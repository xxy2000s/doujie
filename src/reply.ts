import { spawn } from 'node:child_process';
import type { AIResult, FeishuIdentity } from './types.js';

export function formatReply(result: AIResult): string {
  const tagStr = result.tags.map((t) => `#${t}`).join(' ');
  const sections = [
    `**AI Summary**\n\n${result.summary}`,
    `**Tags**: ${tagStr}`,
  ];
  if (result.actionItems.length > 0) {
    sections.push(`**Action Items**\n${result.actionItems.slice(0, 3).map((item) => `- ${item}`).join('\n')}`);
  }
  if (result.entities.length > 0) {
    sections.push(`**Entities**: ${result.entities.slice(0, 5).join(', ')}`);
  }
  return sections.join('\n\n');
}

export async function replyToMessage(
  messageId: string,
  result: AIResult,
  feishuAs: FeishuIdentity = 'bot'
): Promise<void> {
  const content = formatReply(result);
  await sendReply(messageId, content, feishuAs);
}

export async function replyError(
  messageId: string,
  feishuAs: FeishuIdentity = 'bot'
): Promise<void> {
  await sendReply(messageId, '处理失败，请稍后重试', feishuAs);
}

export async function replyText(
  messageId: string,
  text: string,
  feishuAs: FeishuIdentity = 'bot'
): Promise<void> {
  await sendReply(messageId, text, feishuAs);
}

export function buildReplyArgs(
  messageId: string,
  content: string,
  feishuAs: FeishuIdentity
): string[] {
  return [
    'im',
    '+messages-reply',
    '--message-id',
    messageId,
    '--content',
    JSON.stringify({ text: content }),
    '--msg-type',
    'text',
    '--as',
    feishuAs,
  ];
}

async function sendReply(
  messageId: string,
  content: string,
  feishuAs: FeishuIdentity
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('lark-cli', buildReplyArgs(messageId, content, feishuAs), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        console.log('[reply] Sent reply to', messageId);
        resolve();
      } else {
        console.error('[reply] Failed to send reply:', stderr, stdout);
        reject(new Error(`lark-cli exited with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (err: Error) => {
      console.error('[reply] Process error:', err.message);
      reject(err);
    });
  });
}
