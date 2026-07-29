import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WEB_HOST,
  startInfoHunterWebServer,
} from '../src/web/server.js';
import { Store } from '../src/store.js';
import { createTempDbPath, removeTempDir } from './helpers.js';

async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

test('InfoHunter web server defaults to localhost binding', () => {
  assert.equal(DEFAULT_WEB_HOST, '127.0.0.1');
});

test('InfoHunter web server serves static read-only UI assets', async () => {
  const { dir, dbPath } = createTempDbPath('infohunter-web-static');
  const store = new Store(dbPath, () => 1000, { disableFts: true });
  const web = await startInfoHunterWebServer(store, { port: 0 });
  try {
    assert.equal(web.host, '127.0.0.1');
    const html = await fetch(web.url).then((response) => response.text());
    const css = await fetch(`${web.url}/static/styles.css`).then((response) => response.text());
    const js = await fetch(`${web.url}/static/app.js`).then((response) => response.text());

    assert.match(html, /Local knowledge search/);
    assert.match(css, /\.workspace/);
    assert.match(js, /\/api\/search/);
  } finally {
    await web.close();
    store.close();
    removeTempDir(dir);
  }
});

test('InfoHunter web search API reuses store filters', async () => {
  let now = Date.parse('2026-03-02T12:00:00.000Z');
  const { dir, dbPath } = createTempDbPath('infohunter-web-search');
  const store = new Store(dbPath, () => now, { disableFts: true });
  const web = await startInfoHunterWebServer(store, { port: 0 });
  try {
    store.saveMessage({
      id: 'web-1',
      chatId: 'chat',
      senderId: 'sender',
      content: 'alpha source note',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.saveProcessed({
      id: 'web-1-processed',
      messageId: 'web-1',
      summary: 'filtered alpha summary',
      tags: ['技术'],
      processedAt: now,
    });
    store.saveSourceForMessage('web-1', {
      originalUrl: 'https://example.com/a',
      canonicalUrl: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      domain: 'example.com',
      title: 'Example',
      fetchStatus: 'fetched',
      contentLength: 20,
      error: null,
    }, 0);

    now = Date.parse('2026-03-03T12:00:00.000Z');
    store.saveMessage({
      id: 'web-2',
      chatId: 'chat',
      senderId: 'sender',
      content: 'alpha source note',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.saveProcessed({
      id: 'web-2-processed',
      messageId: 'web-2',
      summary: 'other summary',
      tags: ['生活'],
      processedAt: now,
    });

    const response = await fetch(`${web.url}/api/search?q=alpha&tag=%E6%8A%80%E6%9C%AF&source=example.com&limit=50`);
    const payload = await readJson<{ count: number; results: Array<{ id: string; sources: string | null }> }>(response);

    assert.equal(response.status, 200);
    assert.equal(payload.count, 1);
    assert.equal(payload.results[0]?.id, 'web-1');
    assert.equal(payload.results[0]?.sources, 'example.com');
  } finally {
    await web.close();
    store.close();
    removeTempDir(dir);
  }
});

test('InfoHunter web detail API returns message sources and attachments', async () => {
  const { dir, dbPath } = createTempDbPath('infohunter-web-detail');
  const store = new Store(dbPath, () => 2000, { disableFts: true });
  const web = await startInfoHunterWebServer(store, { port: 0 });
  try {
    store.saveMessage({
      id: 'detail-1',
      chatId: 'chat',
      senderId: 'sender',
      content: 'detail body',
      messageType: 'file',
      rawEvent: '{}',
    });
    store.saveProcessed({
      id: 'detail-1-processed',
      messageId: 'detail-1',
      summary: 'detail summary',
      tags: ['文件'],
      keyPoints: ['point'],
      actionItems: ['act'],
      entities: ['InfoHunter'],
      sourceType: 'chat',
      confidence: 0.9,
      schemaVersion: 2,
      processedAt: 2001,
    });
    store.saveSourceForMessage('detail-1', {
      originalUrl: 'https://example.com/a',
      canonicalUrl: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      domain: 'example.com',
      title: 'Example',
      fetchStatus: 'fetched',
      contentLength: 20,
      error: null,
    }, 0);
    store.saveAttachment({
      messageId: 'detail-1',
      resourceKey: 'file_1',
      resourceType: 'file',
      fileName: 'notes.txt',
      mime: 'text/plain',
      size: 12,
      downloadStatus: 'downloaded',
      localPath: '/tmp/notes.txt',
      error: null,
      extractionStatus: 'extracted',
      extractedText: 'notes',
      extractionError: null,
    });

    const response = await fetch(`${web.url}/api/message?id=detail-1`);
    const payload = await readJson<{
      message: {
        id: string;
        processed: { summary: string | null } | null;
        sources: Array<{ domain: string }>;
        attachments: Array<{ fileName: string | null; extractionStatus?: string }>;
      };
    }>(response);

    assert.equal(response.status, 200);
    assert.equal(payload.message.id, 'detail-1');
    assert.equal(payload.message.processed?.summary, 'detail summary');
    assert.equal(payload.message.sources[0]?.domain, 'example.com');
    assert.equal(payload.message.attachments[0]?.fileName, 'notes.txt');
    assert.equal(payload.message.attachments[0]?.extractionStatus, 'extracted');
  } finally {
    await web.close();
    store.close();
    removeTempDir(dir);
  }
});

test('InfoHunter web server rejects mutating methods', async () => {
  const { dir, dbPath } = createTempDbPath('infohunter-web-readonly');
  const store = new Store(dbPath, () => 3000, { disableFts: true });
  const web = await startInfoHunterWebServer(store, { port: 0 });
  try {
    const response = await fetch(`${web.url}/api/search`, { method: 'POST' });
    const payload = await readJson<{ error: string; message: string }>(response);

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(payload.error, 'method_not_allowed');
    assert.match(payload.message, /read-only/);
  } finally {
    await web.close();
    store.close();
    removeTempDir(dir);
  }
});
