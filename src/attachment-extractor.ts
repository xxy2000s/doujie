import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AttachmentRecord } from './store.js';

export type AttachmentExtractionResult =
  | { status: 'extracted'; text: string }
  | { status: 'skipped'; error: string }
  | { status: 'failed'; error: string };

export type AttachmentExtractor = {
  extract(attachment: AttachmentRecord): Promise<AttachmentExtractionResult>;
};

export type AttachmentExtractorOptions = {
  ocrCommand?: string | null;
  commandExists?: (command: string) => boolean;
};

export function createAttachmentExtractor(options: AttachmentExtractorOptions = {}): AttachmentExtractor {
  const commandExists = options.commandExists ?? defaultCommandExists;
  return {
    async extract(attachment: AttachmentRecord): Promise<AttachmentExtractionResult> {
      if (!attachment.localPath) return { status: 'skipped', error: 'attachment has no local path' };
      const ext = path.extname(attachment.localPath).toLowerCase();
      if (attachment.resourceType === 'file' && ['.txt', '.md', '.markdown'].includes(ext)) {
        return readUtf8Text(attachment.localPath);
      }
      if (attachment.resourceType === 'file' && ext === '.pdf') {
        if (!commandExists('pdftotext')) return { status: 'skipped', error: 'pdftotext is not available' };
        return runTextCommand('pdftotext', [attachment.localPath, '-']);
      }
      if (attachment.resourceType === 'image') {
        if (!options.ocrCommand) return { status: 'skipped', error: 'OCR command is not configured' };
        const [command, ...args] = options.ocrCommand.split(/\s+/).filter(Boolean);
        if (!commandExists(command)) return { status: 'skipped', error: `${command} is not available` };
        return runTextCommand(command, [...args, attachment.localPath]);
      }
      return { status: 'skipped', error: `unsupported attachment type: ${attachment.resourceType}${ext}` };
    },
  };
}

function readUtf8Text(filePath: string): AttachmentExtractionResult {
  try {
    return { status: 'extracted', text: fs.readFileSync(filePath, 'utf-8') };
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
}

function runTextCommand(command: string, args: string[]): AttachmentExtractionResult {
  const result = spawnSync(command, args, { encoding: 'utf-8' });
  if (result.error) return { status: 'failed', error: result.error.message };
  if (result.status !== 0) return { status: 'failed', error: result.stderr || `${command} exited with ${result.status}` };
  return { status: 'extracted', text: result.stdout };
}

function defaultCommandExists(command: string): boolean {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}
