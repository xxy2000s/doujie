import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, Store } from '../src/store.js';
import { createTempDbPath, removeTempDir } from './helpers.js';

function readUserVersion(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    return db.pragma('user_version', { simple: true }) as number;
  } finally {
    db.close();
  }
}

function readMigrationRows(dbPath: string): Array<{ version: number; name: string; applied_at: number }> {
  const db = new Database(dbPath);
  try {
    return db.prepare(`
      SELECT version, name, applied_at
      FROM schema_migrations
      ORDER BY version
    `).all() as Array<{ version: number; name: string; applied_at: number }>;
  } finally {
    db.close();
  }
}

function createMvpDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT NOT NULL,
        raw_event TEXT,
        received_at INTEGER NOT NULL
      );

      CREATE TABLE processed (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id),
        summary TEXT,
        tags TEXT,
        processed_at INTEGER NOT NULL
      );

      INSERT INTO messages (id, chat_id, sender_id, content, message_type, raw_event, received_at)
      VALUES ('legacy-1', 'chat', 'sender', 'legacy content', 'text', '{}', 42);
    `);
  } finally {
    db.close();
  }
}

test('Store saves messages with deterministic timestamps and skips duplicates', () => {
  const { dir, dbPath } = createTempDbPath('infohunter-store');
  const store = new Store(dbPath, () => 123456);
  try {
    const first = store.saveMessage({
      id: 'msg-1',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'hello world',
      messageType: 'text',
      rawEvent: '{}',
    });
    const duplicate = store.saveMessage({
      id: 'msg-1',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'hello again',
      messageType: 'text',
      rawEvent: '{}',
    });

    assert.equal(first, true);
    assert.equal(duplicate, false);
    assert.deepEqual(store.searchMessages('hello'), [
      {
        id: 'msg-1',
        content: 'hello world',
        summary: null,
        tags: null,
        keyPoints: null,
        actionItems: null,
        entities: null,
        sourceType: null,
        confidence: null,
        schemaVersion: null,
        sources: null,
        receivedAt: 123456,
      },
    ]);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store initializes an empty database with current schema version', () => {
  const { dir, dbPath } = createTempDbPath('infohunter-migration-empty');
  const store = new Store(dbPath, () => 7000);
  try {
    assert.equal(readUserVersion(dbPath), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(readMigrationRows(dbPath), [
      { version: 1, name: 'create_mvp_schema', applied_at: 7000 },
      { version: 2, name: 'create_processing_jobs', applied_at: 7000 },
      { version: 3, name: 'add_processing_mode', applied_at: 7000 },
      { version: 4, name: 'create_sources', applied_at: 7000 },
      { version: 5, name: 'create_message_fts', applied_at: 7000 },
      { version: 6, name: 'add_structured_processed_fields', applied_at: 7000 },
      { version: 7, name: 'create_tag_feedback', applied_at: 7000 },
      { version: 8, name: 'create_attachments', applied_at: 7000 },
      { version: 9, name: 'add_attachment_extraction', applied_at: 7000 },
    ]);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store upgrades an existing MVP database without dropping data', () => {
  const { dir, dbPath } = createTempDbPath('infohunter-migration-legacy');
  createMvpDatabase(dbPath);
  const store = new Store(dbPath, () => 8000);
  try {
    assert.equal(readUserVersion(dbPath), CURRENT_SCHEMA_VERSION);
    assert.equal(store.searchMessages('legacy')[0]?.id, 'legacy-1');
    assert.deepEqual(readMigrationRows(dbPath), [
      { version: 1, name: 'create_mvp_schema', applied_at: 8000 },
      { version: 2, name: 'create_processing_jobs', applied_at: 8000 },
      { version: 3, name: 'add_processing_mode', applied_at: 8000 },
      { version: 4, name: 'create_sources', applied_at: 8000 },
      { version: 5, name: 'create_message_fts', applied_at: 8000 },
      { version: 6, name: 'add_structured_processed_fields', applied_at: 8000 },
      { version: 7, name: 'create_tag_feedback', applied_at: 8000 },
      { version: 8, name: 'create_attachments', applied_at: 8000 },
      { version: 9, name: 'add_attachment_extraction', applied_at: 8000 },
    ]);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store does not rerun migrations on repeated startup', () => {
  const { dir, dbPath } = createTempDbPath('infohunter-migration-idempotent');
  const firstStore = new Store(dbPath, () => 9000);
  firstStore.close();

  const secondStore = new Store(dbPath, () => 10000);
  try {
    assert.equal(readUserVersion(dbPath), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(readMigrationRows(dbPath), [
      { version: 1, name: 'create_mvp_schema', applied_at: 9000 },
      { version: 2, name: 'create_processing_jobs', applied_at: 9000 },
      { version: 3, name: 'add_processing_mode', applied_at: 9000 },
      { version: 4, name: 'create_sources', applied_at: 9000 },
      { version: 5, name: 'create_message_fts', applied_at: 9000 },
      { version: 6, name: 'add_structured_processed_fields', applied_at: 9000 },
      { version: 7, name: 'create_tag_feedback', applied_at: 9000 },
      { version: 8, name: 'create_attachments', applied_at: 9000 },
      { version: 9, name: 'add_attachment_extraction', applied_at: 9000 },
    ]);
  } finally {
    secondStore.close();
    removeTempDir(dir);
  }
});

test('Store tracks processing job state transitions', () => {
  let now = 12000;
  const { dir, dbPath } = createTempDbPath('infohunter-processing-jobs');
  const store = new Store(dbPath, () => now);
  try {
    store.saveMessage({
      id: 'state-1',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'state test',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.createProcessingJob('state-1');
    assert.equal(store.getProcessingJob('state-1')?.status, 'pending');
    assert.equal(store.getProcessingJob('state-1')?.mode, 'default');

    now = 12100;
    store.setProcessingMode('state-1', 'digest');
    store.markProcessing('state-1', 'codex');
    assert.equal(store.getProcessingJob('state-1')?.stage, 'codex');
    assert.equal(store.getProcessingJob('state-1')?.mode, 'digest');

    now = 12200;
    store.markFailed('state-1', 'codex', 'failed once');
    const failed = store.getProcessingJob('state-1');
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.retryCount, 1);
    assert.equal(failed?.lastError, 'failed once');

    now = 12300;
    assert.equal(store.prepareRetry('state-1'), true);
    assert.equal(store.getProcessingJob('state-1')?.status, 'retrying');
    assert.equal(store.getProcessingJob('state-1')?.mode, 'retry');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store prepares redo for completed jobs and blocks active jobs', () => {
  let now = 13000;
  const { dir, dbPath } = createTempDbPath('infohunter-processing-redo');
  const store = new Store(dbPath, () => now);
  try {
    store.saveMessage({
      id: 'redo-1',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'redo test',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.createProcessingJob('redo-1');
    store.markReplied('redo-1');

    now = 13100;
    assert.equal(store.prepareRedo('redo-1'), true);
    assert.equal(store.getProcessingJob('redo-1')?.status, 'retrying');
    assert.equal(store.getProcessingJob('redo-1')?.stage, 'redo');
    assert.equal(store.getProcessingJob('redo-1')?.mode, 'redo');

    assert.equal(store.prepareRedo('redo-1'), false);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store surfaces migration audit table failures', () => {
  const { dir, dbPath } = createTempDbPath('infohunter-migration-failure');
  const db = new Database(dbPath);
  try {
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);');
  } finally {
    db.close();
  }

  assert.throws(
    () => new Store(dbPath, () => 11000),
    /table schema_migrations has no column named name/
  );
  removeTempDir(dir);
});

test('Store saves processed results and returns them in search', () => {
  const { dir, dbPath } = createTempDbPath('infohunter-processed');
  const store = new Store(dbPath, () => 5000);
  try {
    store.saveMessage({
      id: 'msg-2',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'sqlite test',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.saveProcessed({
      id: 'msg-2-processed',
      messageId: 'msg-2',
      summary: 'summary text',
      tags: ['技术', '学习'],
      keyPoints: ['SQLite migration'],
      actionItems: ['Review schema'],
      entities: ['SQLite'],
      sourceType: 'chat',
      confidence: 0.7,
      schemaVersion: 2,
      processedAt: 6000,
    });

    const results = store.searchMessages('sqlite');

    assert.equal(results.length, 1);
    assert.equal(results[0]?.summary, 'summary text');
    assert.equal(results[0]?.tags, '["技术","学习"]');
    assert.equal(results[0]?.keyPoints, '["SQLite migration"]');
    assert.equal(results[0]?.actionItems, '["Review schema"]');
    assert.equal(results[0]?.entities, '["SQLite"]');
    assert.equal(results[0]?.sourceType, 'chat');
    assert.equal(results[0]?.confidence, 0.7);
    assert.equal(results[0]?.schemaVersion, 2);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store deduplicates sources and links them to messages', () => {
  let now = 15000;
  const { dir, dbPath } = createTempDbPath('infohunter-sources');
  const store = new Store(dbPath, () => now);
  try {
    for (const id of ['source-msg-1', 'source-msg-2']) {
      store.saveMessage({
        id,
        chatId: 'chat-1',
        senderId: 'sender-1',
        content: 'source test',
        messageType: 'text',
        rawEvent: '{}',
      });
    }

    store.saveSourceForMessage('source-msg-1', {
      originalUrl: 'https://Example.com/a',
      canonicalUrl: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      domain: 'example.com',
      title: 'First title',
      fetchStatus: 'fetched',
      contentLength: 12,
      error: null,
    }, 0);

    now = 15100;
    store.saveSourceForMessage('source-msg-1', {
      originalUrl: 'https://example.com/a',
      canonicalUrl: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      domain: 'example.com',
      title: 'Updated title',
      fetchStatus: 'fetched',
      contentLength: 14,
      error: null,
    }, 1);
    store.saveSourceForMessage('source-msg-2', {
      originalUrl: 'https://example.com/a',
      canonicalUrl: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      domain: 'example.com',
      title: 'Updated title',
      fetchStatus: 'fetched',
      contentLength: 14,
      error: null,
    }, 0);

    const firstSources = store.getSourcesForMessage('source-msg-1');
    assert.equal(firstSources.length, 1);
    assert.equal(firstSources[0]?.title, 'Updated title');
    assert.equal(firstSources[0]?.contentLength, 14);
    assert.equal(firstSources[0]?.createdAt, 15000);
    assert.equal(firstSources[0]?.updatedAt, 15100);

    const secondSources = store.getSourcesForMessage('source-msg-2');
    assert.equal(secondSources.length, 1);
    assert.equal(secondSources[0]?.canonicalUrl, 'https://example.com/a');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store persists attachment extraction status and extracted text', () => {
  const { dir, dbPath } = createTempDbPath('infohunter-attachment-extraction');
  const store = new Store(dbPath, () => 15500, { disableFts: true });
  try {
    store.saveMessage({
      id: 'attachment-msg',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'attachment body',
      messageType: 'file',
      rawEvent: '{}',
    });
    store.saveAttachment({
      messageId: 'attachment-msg',
      resourceKey: 'file_1',
      resourceType: 'file',
      fileName: 'notes.md',
      mime: 'text/markdown',
      size: 42,
      downloadStatus: 'downloaded',
      localPath: '/tmp/notes.md',
      error: null,
    });

    store.updateAttachmentExtraction('attachment-msg', 'file_1', {
      status: 'extracted',
      text: 'extracted attachment notes',
      error: null,
    });

    const attachments = store.getAttachmentsForMessage('attachment-msg');
    assert.equal(attachments[0]?.extractionStatus, 'extracted');
    assert.equal(attachments[0]?.extractedText, 'extracted attachment notes');
    assert.deepEqual(store.getExtractedAttachmentText('attachment-msg'), [
      { fileName: 'notes.md', text: 'extracted attachment notes' },
    ]);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store searches processed summaries through FTS when available', () => {
  const { dir, dbPath } = createTempDbPath('infohunter-fts-summary');
  const store = new Store(dbPath, () => 16000);
  try {
    store.saveMessage({
      id: 'fts-1',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'plain message',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.saveProcessed({
      id: 'fts-1-processed',
      messageId: 'fts-1',
      summary: 'neural retrieval index notes',
      tags: ['search'],
      processedAt: 16001,
    });

    const results = store.searchMessages('retrieval');

    assert.equal(results[0]?.id, 'fts-1');
    if (store.getSearchDiagnostics().fts_available === 'true') {
      assert.equal(store.getSearchDiagnostics().last_backend, 'fts');
    }
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store searches structured action items and entities', () => {
  const { dir, dbPath } = createTempDbPath('infohunter-structured-search');
  const store = new Store(dbPath, () => 16500);
  try {
    store.saveMessage({
      id: 'structured-1',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'plain message',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.saveProcessed({
      id: 'structured-1-processed',
      messageId: 'structured-1',
      summary: 'plain summary',
      tags: ['待办'],
      keyPoints: ['无关事实'],
      actionItems: ['prepare launch checklist'],
      entities: ['InfoHunter'],
      sourceType: 'article',
      confidence: 0.88,
      schemaVersion: 2,
      processedAt: 16501,
    });

    assert.equal(store.searchMessages('launch')[0]?.id, 'structured-1');
    assert.equal(store.searchMessages('InfoHunter')[0]?.id, 'structured-1');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store falls back to LIKE for Chinese search fixtures', () => {
  const { dir, dbPath } = createTempDbPath('infohunter-fts-chinese');
  const store = new Store(dbPath, () => 17000);
  try {
    store.saveMessage({
      id: 'zh-1',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: '中文资料沉淀',
      messageType: 'text',
      rawEvent: '{}',
    });

    const results = store.searchMessages('中文资料');

    assert.equal(results[0]?.id, 'zh-1');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store can disable FTS and use LIKE fallback with diagnostics', () => {
  const { dir, dbPath } = createTempDbPath('infohunter-fts-disabled');
  const store = new Store(dbPath, () => 18000, { disableFts: true });
  try {
    store.saveMessage({
      id: 'fallback-1',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'fallback body',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.saveProcessed({
      id: 'fallback-1-processed',
      messageId: 'fallback-1',
      summary: 'fallback summary',
      tags: ['fallback'],
      processedAt: 18001,
    });

    const results = store.searchMessages('summary');
    const diagnostics = store.getSearchDiagnostics();

    assert.equal(results[0]?.id, 'fallback-1');
    assert.equal(diagnostics.fts_available, 'false');
    assert.equal(diagnostics.last_backend, 'like');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store search combines tag date source and limit filters', () => {
  let now = Date.parse('2026-01-02T12:00:00.000Z');
  const { dir, dbPath } = createTempDbPath('infohunter-search-filters');
  const store = new Store(dbPath, () => now, { disableFts: true });
  try {
    for (const row of [
      { id: 'filter-1', tag: '技术', domain: 'example.com', day: '2026-01-02' },
      { id: 'filter-2', tag: '生活', domain: 'example.com', day: '2026-01-03' },
      { id: 'filter-3', tag: '技术', domain: 'other.com', day: '2026-01-04' },
    ]) {
      now = Date.parse(`${row.day}T12:00:00.000Z`);
      store.saveMessage({
        id: row.id,
        chatId: 'chat-1',
        senderId: 'sender-1',
        content: `alpha ${row.id}`,
        messageType: 'text',
        rawEvent: '{}',
      });
      store.saveProcessed({
        id: `${row.id}-processed`,
        messageId: row.id,
        summary: `${row.id} summary`,
        tags: [row.tag],
        processedAt: now,
      });
      store.saveSourceForMessage(row.id, {
        originalUrl: `https://${row.domain}/a`,
        canonicalUrl: `https://${row.domain}/a`,
        finalUrl: `https://${row.domain}/a`,
        domain: row.domain,
        title: row.domain,
        fetchStatus: 'fetched',
        contentLength: 10,
        error: null,
      }, 0);
    }

    const results = store.searchMessages({
      keyword: 'alpha',
      tag: '技术',
      source: 'example.com',
      since: Date.parse('2026-01-01T00:00:00.000Z'),
      until: Date.parse('2026-01-03T23:59:59.999Z'),
      limit: 5,
    });

    assert.deepEqual(results.map((result) => result.id), ['filter-1']);
    assert.equal(results[0]?.sources, 'example.com');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store retags a processed message and records feedback', () => {
  const { dir, dbPath } = createTempDbPath('infohunter-retag');
  const store = new Store(dbPath, () => 19000, { disableFts: true });
  try {
    store.saveMessage({
      id: 'retag-1',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'retag body',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.saveProcessed({
      id: 'retag-1-processed',
      messageId: 'retag-1',
      summary: 'retag summary',
      tags: ['旧标签'],
      processedAt: 19001,
    });

    const result = store.retagMessage('retag-1', ['#技术', '学习', '技术'], 'test-retag');

    assert.equal(result.updated, true);
    assert.deepEqual(result.previousTags, ['旧标签']);
    assert.deepEqual(result.newTags, ['技术', '学习']);
    assert.equal(store.searchMessages({ keyword: '', tag: '技术' })[0]?.id, 'retag-1');
    assert.equal(store.searchMessages({ keyword: '', tag: '旧标签' }).length, 0);
    const feedback = store.getTagFeedback('retag-1');
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0]?.previousTags, '["旧标签"]');
    assert.equal(feedback[0]?.newTags, '["技术","学习"]');
    assert.equal(feedback[0]?.reason, 'test-retag');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store merges tag aliases and search resolves alias or canonical tag', () => {
  const { dir, dbPath } = createTempDbPath('infohunter-merge-tag');
  const store = new Store(dbPath, () => 20000, { disableFts: true });
  try {
    for (const row of [
      { id: 'merge-1', tags: ['tech', '阅读'] },
      { id: 'merge-2', tags: ['技术'] },
    ]) {
      store.saveMessage({
        id: row.id,
        chatId: 'chat-1',
        senderId: 'sender-1',
        content: 'merge body',
        messageType: 'text',
        rawEvent: '{}',
      });
      store.saveProcessed({
        id: `${row.id}-processed`,
        messageId: row.id,
        summary: `${row.id} summary`,
        tags: row.tags,
        processedAt: 20001,
      });
    }

    const result = store.mergeTag('tech', '技术');

    assert.deepEqual(result, { alias: 'tech', canonicalTag: '技术', updatedMessages: 1 });
    assert.deepEqual(store.getTagAliases().map((row) => [row.alias, row.canonicalTag]), [['tech', '技术']]);
    assert.deepEqual(store.searchMessages({ keyword: 'merge', tag: 'tech' }).map((row) => row.id).sort(), ['merge-1', 'merge-2']);
    assert.deepEqual(store.searchMessages({ keyword: 'merge', tag: '技术' }).map((row) => row.id).sort(), ['merge-1', 'merge-2']);
    assert.equal(store.searchMessages({ keyword: 'merge', tag: '阅读' }).find((row) => row.id === 'merge-1')?.tags, '["技术","阅读"]');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Store builds compact tag prompt context from frequent tags and aliases', () => {
  const { dir, dbPath } = createTempDbPath('infohunter-tag-context');
  const store = new Store(dbPath, () => 21000, { disableFts: true });
  try {
    for (const row of [
      { id: 'context-1', tags: ['技术'] },
      { id: 'context-2', tags: ['技术', '学习'] },
    ]) {
      store.saveMessage({
        id: row.id,
        chatId: 'chat-1',
        senderId: 'sender-1',
        content: 'context body',
        messageType: 'text',
        rawEvent: '{}',
      });
      store.saveProcessed({
        id: `${row.id}-processed`,
        messageId: row.id,
        summary: 'context summary',
        tags: row.tags,
        processedAt: 21001,
      });
    }
    store.mergeTag('tech', '技术');

    const context = store.getTagPromptContext();

    assert.match(context ?? '', /\[Doujie tag hints\]/);
    assert.match(context ?? '', /技术\(2\)/);
    assert.match(context ?? '', /tech -> 技术/);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});
