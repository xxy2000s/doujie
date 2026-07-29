import { spawn } from 'node:child_process';
import type { AIResult, FeishuIdentity } from './types.js';

const MAX_POST_MARKDOWN_CHARS = 800;

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

export function buildPostMarkdownContent(content: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [
        [
          {
            tag: 'md',
            text: content || ' ',
          },
        ],
      ],
    },
  });
}

export function splitPostMarkdownContent(content: string): string[] {
  const normalized = content || ' ';
  if (normalized.length <= MAX_POST_MARKDOWN_CHARS) {
    return [normalized];
  }

  const sections = splitMarkdownSections(normalized);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of sections) {
    const separator = current ? '\n\n' : '';
    if ((current + separator + paragraph).length <= MAX_POST_MARKDOWN_CHARS) {
      current += separator + paragraph;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (paragraph.length <= MAX_POST_MARKDOWN_CHARS) {
      current = paragraph;
      continue;
    }
    for (let index = 0; index < paragraph.length; index += MAX_POST_MARKDOWN_CHARS) {
      chunks.push(paragraph.slice(index, index + MAX_POST_MARKDOWN_CHARS));
    }
  }
  if (current) {
    chunks.push(current);
  }

  if (chunks.length <= 1) {
    return chunks;
  }
  return chunks.map((chunk, index) => `(${index + 1}/${chunks.length})\n\n${chunk}`);
}

function splitMarkdownSections(content: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of content.split('\n')) {
    if (!inFence && current.length > 0 && /^#{1,6}\s+/.test(line)) {
      sections.push(current.join('\n').trim());
      current = [];
    }
    current.push(line);
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
    }
  }
  if (current.length > 0) {
    sections.push(current.join('\n').trim());
  }
  return sections
    .flatMap((section) => section.split(/\n{2,}/).map((part) => part.trim()))
    .filter(Boolean);
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
    buildPostMarkdownContent(content),
    '--msg-type',
    'post',
    '--as',
    feishuAs,
  ];
}

async function sendReply(
  messageId: string,
  content: string,
  feishuAs: FeishuIdentity
): Promise<void> {
  const chunks = splitPostMarkdownContent(content);
  for (const chunk of chunks) {
    await sendReplyChunk(messageId, chunk, feishuAs);
  }
}

async function sendReplyChunk(
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
