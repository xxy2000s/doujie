import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cleanupOldMessages, createVerifiedBackup, exportMessages } from '../src/maintenance.js';
import { Store } from '../src/store.js';
import { createTempDbPath, removeTempDir } from './helpers.js';

function seedMessage(store: Store, id: string, now: number, tag: string): void {
  store.saveMessage({
    id,
    chatId: 'chat',
    senderId: 'sender',
    content: `content ${id}`,
    messageType: 'text',
    rawEvent: '{}',
  });
  store.createProcessingJob(id);
  store.saveProcessed({
    id: `${id}-processed`,
    messageId: id,
    summary: `summary ${id}`,
    tags: [tag],
    processedAt: now,
  });
}

test('createVerifiedBackup writes an integrity-checked sqlite backup', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-backup');
  const store = new Store(dbPath, () => 1000, { disableFts: true });
  try {
    seedMessage(store, 'backup-1', 1000, '备份');
    const result = await createVerifiedBackup(store, path.join(dir, 'backups'), () => 12345);

    assert.equal(result.integrity, 'ok');
    assert.equal(path.basename(result.path), 'doujie-12345.db');
    assert.equal(fs.existsSync(result.path), true);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('exportMessages writes jsonl and markdown files with filters', () => {
  const { dir, dbPath } = createTempDbPath('doujie-export');
  const store = new Store(dbPath, () => Date.parse('2026-03-01T12:00:00.000Z'), { disableFts: true });
  try {
    seedMessage(store, 'export-1', Date.parse('2026-03-01T12:00:00.000Z'), '技术');
    seedMessage(store, 'export-2', Date.parse('2026-03-01T12:00:00.000Z'), '生活');
    const exportDir = path.join(dir, 'exports');

    const jsonl = exportMessages(store, exportDir, { keyword: 'content', tag: '技术', format: 'jsonl', limit: 10 }, () => 2000);
    const markdown = exportMessages(store, exportDir, { keyword: 'content', format: 'md', limit: 1 }, () => 3000);

    assert.equal(jsonl.count, 1);
    assert.match(fs.readFileSync(jsonl.path, 'utf-8'), /"id":"export-1"/);
    assert.equal(path.basename(markdown.path), 'doujie-export-3000.md');
    assert.match(fs.readFileSync(markdown.path, 'utf-8'), /# Doujie Export/);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('cleanupOldMessages supports dry-run and run modes', () => {
  let now = Date.parse('2026-04-01T00:00:00.000Z');
  const { dir, dbPath } = createTempDbPath('doujie-cleanup');
  const store = new Store(dbPath, () => now, { disableFts: true });
  try {
    seedMessage(store, 'old-1', now, '旧');
    now = Date.parse('2026-04-10T00:00:00.000Z');
    seedMessage(store, 'new-1', now, '新');

    const cutoff = Date.parse('2026-04-05T00:00:00.000Z');
    const dryRun = cleanupOldMessages(store, { cutoff, dryRun: true });
    const run = cleanupOldMessages(store, { cutoff, dryRun: false });

    assert.equal(dryRun.messages, 1);
    assert.equal(run.messages, 1);
    assert.equal(store.searchMessages({ keyword: 'content', limit: 10 }).some((row) => row.id === 'old-1'), false);
    assert.equal(store.searchMessages({ keyword: 'content', limit: 10 }).some((row) => row.id === 'new-1'), true);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});
