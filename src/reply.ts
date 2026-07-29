import { spawn } from 'node:child_process';
import type { AIResult, FeishuIdentity } from './types.js';

const MAX_POST_MARKDOWN_CHARS = 800;

export type StatusCardState = 'thinking' | 'working' | 'done' | 'error';

export type StatusCardParams = {
  state: StatusCardState;
  title?: string;
  stage: string;
  detail?: string;
  elapsedMs?: number;
  dots?: number;
  sessionId?: string | null;
};

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

export async function replyStatusCard(
  messageId: string,
  params: StatusCardParams,
  feishuAs: FeishuIdentity = 'bot'
): Promise<string | null> {
  const stdout = await spawnLarkCli(buildStatusCardReplyArgs(messageId, params, feishuAs));
  return extractMessageId(stdout);
}

export async function updateStatusCard(
  messageId: string,
  params: StatusCardParams,
  feishuAs: FeishuIdentity = 'bot'
): Promise<void> {
  await spawnLarkCli(buildStatusCardPatchArgs(messageId, params, feishuAs));
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

export function buildStatusCard(params: StatusCardParams): Record<string, unknown> {
  const stateLabel = statusLabel(params.state);
  const dots = params.state === 'thinking' || params.state === 'working'
    ? '.'.repeat(Math.max(1, Math.min(params.dots ?? 3, 3)))
    : '';
  const title = params.title ?? (params.state === 'done' ? '豆姐完成了' : `豆姐${stateLabel}${dots}`);
  const elapsed = params.elapsedMs === undefined ? '' : `\n**已用时：** ${formatElapsed(params.elapsedMs)}`;
  const session = params.sessionId ? `\n**Session：** \`${params.sessionId}\`` : '';
  const detail = params.detail ? `\n**详情：** ${params.detail}` : '';

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      update_multi: true,
    },
    header: {
      template: statusTemplate(params.state),
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**状态：** ${stateLabel}${dots}\n**阶段：** ${params.stage}${elapsed}${session}${detail}`,
        },
      },
    ],
  };
}

export function buildStatusCardReplyArgs(
  messageId: string,
  params: StatusCardParams,
  feishuAs: FeishuIdentity
): string[] {
  return [
    'im',
    '+messages-reply',
    '--message-id',
    messageId,
    '--content',
    JSON.stringify(buildStatusCard(params)),
    '--msg-type',
    'interactive',
    '--as',
    feishuAs,
  ];
}

export function buildStatusCardPatchArgs(
  messageId: string,
  params: StatusCardParams,
  feishuAs: FeishuIdentity
): string[] {
  return [
    'api',
    'PATCH',
    `/open-apis/im/v1/messages/${messageId}`,
    '--data',
    JSON.stringify({ content: JSON.stringify(buildStatusCard(params)) }),
    '--as',
    feishuAs,
  ];
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

async function spawnLarkCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('lark-cli', args, {
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
        resolve(stdout);
      } else {
        reject(new Error(`lark-cli exited with code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on('error', reject);
  });
}

function extractMessageId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { data?: { message_id?: unknown } };
    return typeof parsed.data?.message_id === 'string' ? parsed.data.message_id : null;
  } catch {
    return null;
  }
}

function statusLabel(state: StatusCardState): string {
  if (state === 'done') return '已完成';
  if (state === 'error') return '失败';
  if (state === 'working') return '处理中';
  return '思考中';
}

function statusTemplate(state: StatusCardState): string {
  if (state === 'done') return 'green';
  if (state === 'error') return 'red';
  if (state === 'working') return 'blue';
  return 'wathet';
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
