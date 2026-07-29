import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { MessageContent, FeishuIdentity } from './types.js';

export type AttachmentResourceType = 'image' | 'file';

export type AttachmentMeta = {
  resourceKey: string;
  resourceType: AttachmentResourceType;
  fileName: string | null;
  mime: string | null;
  size: number | null;
};

export type AttachmentDownloadResult =
  | { status: 'downloaded'; localPath: string }
  | { status: 'failed'; error: string };

export type AttachmentDownloader = {
  download(messageId: string, attachment: AttachmentMeta): Promise<AttachmentDownloadResult>;
};

export function extractAttachments(message: MessageContent): AttachmentMeta[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(message.rawContent) as Record<string, unknown>;
  } catch {
    return [];
  }

  if (message.messageType === 'image') {
    const imageKey = stringValue(parsed.image_key) || stringValue(parsed.file_key);
    if (!imageKey) return [];
    return [{
      resourceKey: imageKey,
      resourceType: 'image',
      fileName: stringValue(parsed.file_name) || `${imageKey}.image`,
      mime: stringValue(parsed.mime_type) || null,
      size: numberValue(parsed.file_size) ?? numberValue(parsed.size),
    }];
  }

  if (message.messageType === 'file') {
    const fileKey = stringValue(parsed.file_key);
    if (!fileKey) return [];
    return [{
      resourceKey: fileKey,
      resourceType: 'file',
      fileName: stringValue(parsed.file_name) || stringValue(parsed.name) || fileKey,
      mime: stringValue(parsed.mime_type) || null,
      size: numberValue(parsed.file_size) ?? numberValue(parsed.size),
    }];
  }

  return [];
}

export function createLarkAttachmentDownloader(
  cacheDir: string,
  feishuAs: FeishuIdentity = 'bot'
): AttachmentDownloader {
  return {
    async download(messageId: string, attachment: AttachmentMeta): Promise<AttachmentDownloadResult> {
      const relativeOutput = safeOutputPath(messageId, attachment);
      const localPath = path.join(cacheDir, relativeOutput);
      const args = buildAttachmentDownloadArgs(messageId, attachment, relativeOutput, feishuAs);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      return new Promise((resolve) => {
        const proc = spawn('lark-cli', args, { cwd: cacheDir, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        proc.on('error', (err) => {
          resolve({ status: 'failed', error: err.message });
        });
        proc.on('close', (code) => {
          if (code === 0) {
            resolve({ status: 'downloaded', localPath });
          } else {
            resolve({ status: 'failed', error: stderr.trim() || `lark-cli exited with code ${code}` });
          }
        });
      });
    },
  };
}

export function buildAttachmentDownloadArgs(
  messageId: string,
  attachment: AttachmentMeta,
  output: string,
  feishuAs: FeishuIdentity = 'bot'
): string[] {
  return [
    'im',
    '+messages-resources-download',
    '--as',
    feishuAs,
    '--message-id',
    messageId,
    '--file-key',
    attachment.resourceKey,
    '--type',
    attachment.resourceType,
    '--output',
    output,
  ];
}

function safeOutputPath(messageId: string, attachment: AttachmentMeta): string {
  const baseName = path.basename(attachment.fileName || attachment.resourceKey).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(messageId.replace(/[^a-zA-Z0-9._-]/g, '_'), `${attachment.resourceKey}-${baseName}`);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
