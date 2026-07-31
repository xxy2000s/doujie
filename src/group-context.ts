import { spawn } from 'node:child_process';
import type { FeishuIdentity, PrivacyGroupRule } from './types.js';

export type GroupContextMessage = {
  messageId: string;
  senderName: string;
  senderType: string;
  createdAt: string;
  text: string;
};

export type GroupContextRequest = {
  maxMessages?: number;
  hours?: number;
};

export type GroupContextProvider = {
  fetch(chatId: string, rule: PrivacyGroupRule, request: GroupContextRequest): Promise<GroupContextMessage[]>;
};

export function parseGroupContextRequest(text: string): GroupContextRequest | null {
  if (!/(总结|汇总|回顾|结合).*(上下文|聊天|讨论|消息)|(最近|过去).*(总结|发生|聊了)/u.test(text)) return null;
  const count = text.match(/(?:最近|前)\s*(\d{1,3})\s*条/u);
  const hours = text.match(/(?:最近|过去)\s*(\d{1,2})\s*(?:小时|个小时)/u);
  return {
    ...(count ? { maxMessages: Number(count[1]) } : {}),
    ...(hours ? { hours: Number(hours[1]) } : {}),
  };
}

export function formatGroupContextPrompt(
  instruction: string,
  messages: GroupContextMessage[],
  maxChars: number
): string {
  const lines: string[] = [];
  let chars = 0;
  for (const message of messages) {
    const line = `[${message.createdAt}] ${message.senderName}: ${message.text}`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return [
    '请根据下面真实的飞书群聊上下文完成用户指令。不要编造上下文中不存在的信息。',
    `用户指令：${instruction}`,
    `实际读取消息数：${lines.length}`,
    '--- 群聊上下文（按时间升序）---',
    ...lines,
    '--- 上下文结束 ---',
  ].join('\n');
}

export class LarkGroupContextProvider implements GroupContextProvider {
  constructor(private readonly identity: FeishuIdentity = 'user') {}

  async fetch(chatId: string, rule: PrivacyGroupRule, request: GroupContextRequest): Promise<GroupContextMessage[]> {
    const pageSize = Math.min(request.maxMessages ?? rule.contextMaxMessages, rule.contextMaxMessages, 100);
    const stdout = await runLark([
      'im', '+chat-messages-list', '--chat-id', chatId,
      '--page-size', String(pageSize), '--as', this.identity, '--format', 'json',
    ]);
    const first = stdout.indexOf('{');
    const last = stdout.lastIndexOf('}');
    if (first < 0 || last < first) throw new Error('lark-cli group history output is not JSON');
    const parsed = JSON.parse(stdout.slice(first, last + 1)) as { data?: { messages?: Array<Record<string, unknown>> } };
    const cutoff = request.hours ? Date.now() - request.hours * 3600000 : null;
    const rows = Array.isArray(parsed.data?.messages) ? parsed.data.messages : [];
    return rows
      .filter((row) => !row.deleted)
      .map((row) => {
        const sender = typeof row.sender === 'object' && row.sender !== null ? row.sender as Record<string, unknown> : {};
        return {
          messageId: String(row.message_id ?? ''),
          senderName: String(sender.name ?? sender.id ?? 'unknown'),
          senderType: String(sender.sender_type ?? 'unknown'),
          createdAt: String(row.create_time ?? ''),
          text: String(row.content ?? '').trim(),
        };
      })
      .filter((row) => row.messageId && row.text && (!cutoff || parseFeishuTime(row.createdAt) >= cutoff))
      .reverse();
  }
}

function parseFeishuTime(value: string): number {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + ':00';
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function runLark(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `lark-cli exited ${code}`)));
  });
}
