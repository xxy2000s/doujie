import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AIResult, FeishuEvent, FeishuMention } from '../src/types.js';

export function createTempDbPath(prefix: string): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return { dir, dbPath: path.join(dir, 'test.db') };
}

export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function textEvent(params: {
  messageId: string;
  text: string;
  chatId?: string;
  chatType?: string;
  senderId?: string;
  senderAtEventRoot?: boolean;
  mentions?: FeishuMention[];
  parentId?: string;
  replyTo?: string;
  rootId?: string;
}): FeishuEvent {
  const sender = { sender_id: { open_id: params.senderId ?? 'ou_test' } };
  return {
    schema: '2.0',
    header: {
      event_id: `event-${params.messageId}`,
      event_type: 'im.message.receive_v1',
      create_time: '1783530000000',
    },
    event: {
      ...(params.senderAtEventRoot ? { sender } : {}),
      message: {
        message_id: params.messageId,
        chat_id: params.chatId ?? 'oc_test',
        chat_type: params.chatType ?? 'p2p',
        ...(params.senderAtEventRoot ? {} : { sender }),
        message_type: 'text',
        content: JSON.stringify({ text: params.text }),
        ...(params.mentions ? { mentions: params.mentions } : {}),
        ...(params.parentId ? { parent_id: params.parentId } : {}),
        ...(params.replyTo ? { reply_to: params.replyTo } : {}),
        ...(params.rootId ? { root_id: params.rootId } : {}),
      },
    },
  };
}

export function aiResult(params: Partial<AIResult> & Pick<AIResult, 'summary' | 'tags'>): AIResult {
  return {
    summary: params.summary,
    tags: params.tags,
    keyPoints: params.keyPoints ?? [],
    actionItems: params.actionItems ?? [],
    entities: params.entities ?? [],
    sourceType: params.sourceType ?? 'chat',
    confidence: params.confidence ?? 0.8,
    schemaVersion: params.schemaVersion ?? 2,
  };
}
