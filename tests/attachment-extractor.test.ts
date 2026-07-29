import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAttachmentExtractor } from '../src/attachment-extractor.js';
import type { AttachmentRecord } from '../src/store.js';

function tempFile(name: string, content = ''): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infohunter-attachment-extractor-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return { dir, filePath };
}

function attachment(params: Partial<AttachmentRecord>): AttachmentRecord {
  return {
    id: 'msg:file_1',
    messageId: 'msg',
    resourceKey: 'file_1',
    resourceType: 'file',
    fileName: 'attachment.txt',
    mime: 'text/plain',
    size: null,
    downloadStatus: 'downloaded',
    localPath: null,
    error: null,
    extractionStatus: 'pending',
    extractedText: null,
    extractionError: null,
    createdAt: 1,
    updatedAt: 1,
    ...params,
  };
}

test('Attachment extractor reads downloaded text and Markdown files as UTF-8', async () => {
  const { dir, filePath } = tempFile('notes.md', '# Title\n\nBody text');
  const extractor = createAttachmentExtractor();
  try {
    const result = await extractor.extract(attachment({ localPath: filePath, fileName: 'notes.md' }));

    assert.deepEqual(result, { status: 'extracted', text: '# Title\n\nBody text' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Attachment extractor skips PDFs when pdftotext is unavailable', async () => {
  const extractor = createAttachmentExtractor({ commandExists: () => false });
  const result = await extractor.extract(attachment({ localPath: '/tmp/report.pdf', fileName: 'report.pdf' }));

  assert.deepEqual(result, { status: 'skipped', error: 'pdftotext is not available' });
});

test('Attachment extractor skips image OCR when no OCR command is configured', async () => {
  const extractor = createAttachmentExtractor();
  const result = await extractor.extract(attachment({
    resourceType: 'image',
    resourceKey: 'img_1',
    localPath: '/tmp/photo.png',
    fileName: 'photo.png',
    mime: 'image/png',
  }));

  assert.deepEqual(result, { status: 'skipped', error: 'OCR command is not configured' });
});
