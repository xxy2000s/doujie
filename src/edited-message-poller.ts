import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import type { FeishuEvent, FeishuIdentity, FeishuMention } from './types.js';
import type { EventHandler } from './listener.js';
import { MESSAGE_UPDATED_EVENTS, redactListenerLog } from './listener.js';
import { normalizeDirectParentId } from './quoted-message.js';

export type FeishuListMessage = {
  message_id: string;
  chat_id?: string;
  chat_type?: string;
  msg_type?: string;
  content?: string;
  mentions?: FeishuMention[];
  parent_id?: string;
  reply_to?: string;
  root_id?: string;
  sender?: {
    id?: string;
    id_type?: string;
    sender_type?: string;
  };
  update_time?: string;
  updated?: boolean;
};

type ListMessages = (chatId: string) => Promise<FeishuListMessage[]>;

export type EditedMessagePollerOptions = {
  feishuAs: FeishuIdentity;
  intervalMs: number;
  pageSize: number;
  skipExistingOnStart?: boolean;
  listMessages?: ListMessages;
};

export function buildChatMessagesListArgs(
  chatId: string,
  pageSize: number,
  feishuAs: FeishuIdentity
): string[] {
  return [
    'im',
    '+chat-messages-list',
    '--chat-id',
    chatId,
    '--page-size',
    String(pageSize),
    '--as',
    feishuAs,
  ];
}

export function parseChatMessagesListOutput(stdout: string): FeishuListMessage[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < firstBrace) {
    throw new Error('lark-cli chat message output is not JSON');
  }
  const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as {
    data?: { messages?: FeishuListMessage[] };
  };
  return Array.isArray(parsed.data?.messages) ? parsed.data.messages : [];
}

export function listMessageToEditedEvent(message: FeishuListMessage, fallbackChatId: string): FeishuEvent | null {
  if (!message.updated || !message.message_id) return null;

  const chatId = message.chat_id || fallbackChatId;
  const messageType = message.msg_type || 'text';
  const content = contentToRawJson(messageType, message.content || '');
  const senderId = message.sender?.id || 'unknown';
  const versionKey = getListMessageVersionKey(message);
  const parentId = normalizeDirectParentId(message.parent_id, message.reply_to);

  return {
    schema: '2.0',
    header: {
      event_id: `poll:${chatId}:${message.message_id}:${versionKey}`,
      event_type: MESSAGE_UPDATED_EVENTS[0],
      create_time: String(Date.now()),
    },
    event: {
      sender: {
        sender_id: {
          open_id: senderId,
        },
      },
      message: {
        message_id: message.message_id,
        chat_id: chatId,
        chat_type: message.chat_type || 'group',
        sender: {
          sender_id: {
            open_id: senderId,
          },
        },
        message_type: messageType,
        content,
        mentions: message.mentions || [],
        ...(parentId ? { parent_id: parentId } : {}),
        reply_to: message.reply_to,
        root_id: message.root_id,
        update_time: message.update_time,
        updated: true,
      },
    },
  };
}

export class EditedMessagePoller {
  private handler: EventHandler;
  private chatIds: string[];
  private options: Required<EditedMessagePollerOptions>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private initialized = false;
  private seenVersionKeys = new Set<string>();

  constructor(
    handler: EventHandler,
    chatIds: string[],
    options: EditedMessagePollerOptions
  ) {
    this.handler = handler;
    this.chatIds = chatIds;
    this.options = {
      skipExistingOnStart: true,
      listMessages: (chatId: string) => listChatMessages(chatId, options.pageSize, options.feishuAs),
      ...options,
    };
  }

  start(): void {
    if (this.timer) return;
    if (this.chatIds.length === 0) {
      console.warn('[edit-poller] Disabled because feishu.chat_ids is empty.');
      return;
    }
    console.log(
      `[edit-poller] Starting edited-message polling for ${this.chatIds.length} chat(s) every ${this.options.intervalMs}ms as ${this.options.feishuAs}.`
    );
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.options.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const shouldProcess = this.initialized || !this.options.skipExistingOnStart;

    try {
      for (const chatId of this.chatIds) {
        const messages = await this.options.listMessages(chatId);
        for (const message of messages) {
          const event = listMessageToEditedEvent(message, chatId);
          if (!event) continue;

          const key = getEventPollKey(event);
          if (this.seenVersionKeys.has(key)) continue;
          this.seenVersionKeys.add(key);

          if (shouldProcess) {
            this.handler(event);
          }
        }
      }
      this.initialized = true;
    } catch (err) {
      console.error('[edit-poller] Failed to poll edited messages:', redactListenerLog((err as Error).message));
    } finally {
      this.running = false;
    }
  }
}

async function listChatMessages(
  chatId: string,
  pageSize: number,
  feishuAs: FeishuIdentity
): Promise<FeishuListMessage[]> {
  const stdout = await spawnLarkCli(buildChatMessagesListArgs(chatId, pageSize, feishuAs));
  return parseChatMessagesListOutput(stdout);
}

function spawnLarkCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('lark-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('lark-cli chat message list timed out'));
    }, 20000);

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `lark-cli exited with code ${code}`));
      }
    });
  });
}

function contentToRawJson(messageType: string, content: string): string {
  if (messageType === 'text') {
    return JSON.stringify({ text: content });
  }
  return content;
}

function getListMessageVersionKey(message: FeishuListMessage): string {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      content: message.content || '',
      mentions: message.mentions || [],
      parentId: normalizeDirectParentId(message.parent_id, message.reply_to),
      rootId: message.root_id,
      updated: message.updated || false,
    }))
    .digest('hex')
    .slice(0, 24);
  return message.update_time ? `update:${message.update_time}:hash:${hash}` : `hash:${hash}`;
}

function getEventPollKey(event: FeishuEvent): string {
  return `${event.event.message.chat_id}:${event.event.message.message_id}:${event.header.event_id}`;
}
