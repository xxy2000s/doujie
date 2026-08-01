import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  createCommandDefinitions,
  createCommandRegistry,
  type CommandRuntime,
} from '../src/commands/index.js';
import { Store } from '../src/store.js';
import type { MessageContent } from '../src/types.js';
import { createTempDbPath, removeTempDir } from './helpers.js';

const dummyMessage: MessageContent = {
  messageId: 'command-message',
  chatId: 'chat',
  chatType: 'p2p',
  senderId: 'sender',
  messageType: 'text',
  text: '/status',
  rawContent: '',
  mentions: [],
};

function createRuntime(dbPath: string): CommandRuntime {
  return {
    startedAt: Date.now() - 61000,
    inFlight: new Set(['msg-1']),
    dbPath,
    backupDir: `${dbPath}-backups`,
    exportDir: `${dbPath}-exports`,
    controlSessionDir: `${dbPath}-control-sessions`,
    getListenerStatus: () => ({
      state: 'running',
      lastEventAt: 123456,
      restartCount: 2,
    }),
  };
}

test('status command reports runtime and job counts', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-status-command');
  const store = new Store(dbPath, () => 1000);
  try {
    store.saveMessage({
      id: 'msg-1',
      chatId: 'chat',
      senderId: 'sender',
      content: 'hello',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.createProcessingJob('msg-1');
    store.markReplied('msg-1');

    const commands = createCommandRegistry(store, createRuntime(dbPath));
    const result = await commands.get('status')?.('', dummyMessage);

    assert.match(result ?? '', /^Doujie Status/);
    assert.match(result ?? '', /\*\*Listener:\*\* running/);
    assert.match(result ?? '', /\*\*Restarts:\*\* 2/);
    assert.match(result ?? '', /\*\*In-flight:\*\* 1/);
    assert.match(result ?? '', /replied:1/);
    assert.match(result ?? '', /\*\*Modes:\*\* default:1/);
    assert.match(result ?? '', /\*\*Search:\*\* fts=/);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('help command is generated from command metadata', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-help-command');
  const store = new Store(dbPath, () => 1500);
  try {
    const definitions = createCommandDefinitions(store, createRuntime(dbPath));
    const commands = createCommandRegistry(store, createRuntime(dbPath));
    const result = await commands.get('help')?.('', dummyMessage);

    for (const definition of definitions) {
      assert.match(result ?? '', new RegExp(`/${definition.usage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(result ?? '', new RegExp(definition.description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(result ?? '', /私聊和群聊 @豆姐/);
    assert.match(result ?? '', /会话控制/);
    assert.match(result ?? '', /运行状态/);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('reload command formats applied, restart-required, and sanitized failure states', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-reload-command');
  const store = new Store(dbPath);
  try {
    const successRuntime = {
      ...createRuntime(dbPath),
      reloadConfig: async () => ({
        ok: true as const,
        previousVersion: 2,
        version: 3,
        changed: true,
        restartRequired: ['codex.model', 'privacy.groups'],
      }),
    };
    const success = await createCommandRegistry(store, successRuntime).get('reload')?.('', dummyMessage);
    assert.match(success ?? '', /配置重载成功/);
    assert.match(success ?? '', /2 → 3/);
    assert.match(success ?? '', /codex\.model/);
    assert.match(success ?? '', /privacy\.groups/);

    const noChangeRuntime = {
      ...createRuntime(dbPath),
      reloadConfig: async () => ({
        ok: true as const,
        previousVersion: 3,
        version: 3,
        changed: false,
        restartRequired: [],
      }),
    };
    const noChange = await createCommandRegistry(store, noChangeRuntime).get('reload')?.('', dummyMessage);
    assert.match(noChange ?? '', /3 → 3/);
    assert.match(noChange ?? '', /no_change/);

    const failureRuntime = {
      ...createRuntime(dbPath),
      reloadConfig: async () => ({
        ok: false as const,
        previousVersion: 3,
        version: 3,
        changed: false,
        restartRequired: [],
        error: 'secret: real-config-value',
      }),
    };
    const failure = await createCommandRegistry(store, failureRuntime).get('reload')?.('', dummyMessage);
    assert.match(failure ?? '', /配置重载失败/);
    assert.match(failure ?? '', /3（未变化）/);
    assert.match(failure ?? '', /configuration validation failed/);
    assert.doesNotMatch(failure ?? '', /real-config-value/);
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('sessions command reports Doujie control sessions', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-sessions-command');
  const store = new Store(dbPath, () => 1600);
  const runtime = createRuntime(dbPath);
  fs.mkdirSync(runtime.controlSessionDir, { recursive: true });
  fs.writeFileSync(
    `${runtime.controlSessionDir}/index.json`,
    JSON.stringify({
      version: 1,
      updatedAt: '2026-07-29T00:00:00.000Z',
      sessions: {
        oc_group: {
          sessionKey: 'oc_group',
          sessionId: 'session-1',
          workdir: '/repo/control',
          codexJsonlPath: '/codex/session-1.jsonl',
          linkPath: `${runtime.controlSessionDir}/links/oc_group.jsonl`,
          active: true,
          firstSeenAt: '2026-07-29T00:00:00.000Z',
          updatedAt: '2026-07-29T00:00:00.000Z',
        },
      },
    }),
    'utf-8'
  );
  try {
    const commands = createCommandRegistry(store, runtime);
    const result = await commands.get('sessions')?.('', {
      ...dummyMessage,
      chatId: 'oc_group',
      chatType: 'group',
    });

    assert.match(result ?? '', /Codex Sessions/);
    assert.match(result ?? '', /Control dir/);
    assert.match(result ?? '', /oc_group \[active current\]/);
    assert.match(result ?? '', /session-1/);
    assert.match(result ?? '', /\/repo\/control/);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('session command reports the current Feishu session binding', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-current-session-command');
  const store = new Store(dbPath, () => 1700);
  const runtime = createRuntime(dbPath);
  fs.mkdirSync(runtime.controlSessionDir, { recursive: true });
  fs.writeFileSync(
    `${runtime.controlSessionDir}/index.json`,
    JSON.stringify({
      version: 1,
      updatedAt: '2026-07-30T00:00:00.000Z',
      sessions: {
        'chat:sender': {
          sessionKey: 'chat:sender',
          sessionId: '019f-current-session',
          workdir: '/home/doujie/service/doujie',
          codexJsonlPath: '/home/doujie/.codex/sessions/current.jsonl',
          linkPath: `${runtime.controlSessionDir}/links/chat_user.jsonl`,
          active: true,
          firstSeenAt: '2026-07-30T00:00:00.000Z',
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
      },
    }),
    'utf-8'
  );
  try {
    const commands = createCommandRegistry(store, runtime);
    const result = await commands.get('session')?.('', dummyMessage);

    assert.match(result ?? '', /当前 Codex Session/);
    assert.match(result ?? '', /chat:sender/);
    assert.match(result ?? '', /019f-current-session/);
    assert.match(result ?? '', /\/home\/doujie\/service\/doujie/);
    assert.match(result ?? '', /\*\*Project:\*\* doujie/);
    assert.match(result ?? '', /current\.jsonl/);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('recent command returns bounded message previews', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-recent-command');
  const store = new Store(dbPath, () => 2000);
  try {
    store.saveMessage({
      id: 'recent-1',
      chatId: 'chat',
      senderId: 'sender',
      content: 'a long message body that should be previewed safely',
      messageType: 'text',
      rawEvent: '{}',
    });

    const commands = createCommandRegistry(store, createRuntime(dbPath));
    const result = await commands.get('recent')?.('1', dummyMessage);

    assert.match(result ?? '', /最近消息/);
    assert.match(result ?? '', /recent-1/);
    assert.match(result ?? '', /\*\*Type:\*\* text/);
    assert.doesNotMatch(result ?? '', /没有最近消息/);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('search command supports filters and renders sources', async () => {
  let now = Date.parse('2026-02-02T12:00:00.000Z');
  const { dir, dbPath } = createTempDbPath('doujie-search-command');
  const store = new Store(dbPath, () => now, { disableFts: true });
  try {
    store.saveMessage({
      id: 'search-filter-1',
      chatId: 'chat',
      senderId: 'sender',
      content: 'alpha source note',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.saveProcessed({
      id: 'search-filter-1-processed',
      messageId: 'search-filter-1',
      summary: 'filtered summary',
      tags: ['技术'],
      processedAt: now,
    });
    store.saveSourceForMessage('search-filter-1', {
      originalUrl: 'https://example.com/a',
      canonicalUrl: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      domain: 'example.com',
      title: 'Example',
      fetchStatus: 'fetched',
      contentLength: 10,
      error: null,
    }, 0);

    now = Date.parse('2026-02-03T12:00:00.000Z');
    store.saveMessage({
      id: 'search-filter-2',
      chatId: 'chat',
      senderId: 'sender',
      content: 'alpha source note',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.saveProcessed({
      id: 'search-filter-2-processed',
      messageId: 'search-filter-2',
      summary: 'other summary',
      tags: ['生活'],
      processedAt: now,
    });

    const commands = createCommandRegistry(store, createRuntime(dbPath));
    const result = await commands.get('search')?.('alpha tag:技术 source:example.com limit:1', dummyMessage);

    assert.match(result ?? '', /搜索结果/);
    assert.match(result ?? '', /alpha source note/);
    assert.match(result ?? '', /\*\*Sources:\*\* example.com/);
    assert.doesNotMatch(result ?? '', /other summary/);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('maintenance commands create backup export and cleanup output', async () => {
  let now = Date.parse('2026-05-01T00:00:00.000Z');
  const { dir, dbPath } = createTempDbPath('doujie-maintenance-command');
  const store = new Store(dbPath, () => now, { disableFts: true });
  try {
    store.saveMessage({
      id: 'maint-1',
      chatId: 'chat',
      senderId: 'sender',
      content: 'maintenance content',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.createProcessingJob('maint-1');
    store.saveProcessed({
      id: 'maint-1-processed',
      messageId: 'maint-1',
      summary: 'maintenance summary',
      tags: ['维护'],
      processedAt: now,
    });

    const runtime = {
      ...createRuntime(dbPath),
      backupDir: `${dir}/backups`,
      exportDir: `${dir}/exports`,
      clock: () => Date.parse('2026-05-10T00:00:00.000Z'),
    };
    const commands = createCommandRegistry(store, runtime);

    const backup = await commands.get('backup')?.('', dummyMessage);
    const exported = await commands.get('export')?.('format:jsonl tag:维护 limit:10', dummyMessage);
    const cleanup = await commands.get('cleanup')?.('dry-run messages:1', dummyMessage);

    assert.match(backup ?? '', /Backup complete:/);
    assert.match(exported ?? '', /Records: 1/);
    assert.match(cleanup ?? '', /Cleanup dry-run/);
    assert.equal(fs.existsSync(`${dir}/backups/doujie-${Date.parse('2026-05-10T00:00:00.000Z')}.db`), true);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('search command rejects invalid filters', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-search-invalid');
  const store = new Store(dbPath, () => 4000);
  try {
    const commands = createCommandRegistry(store, createRuntime(dbPath));
    const result = await commands.get('search')?.('alpha limit:99', dummyMessage);

    assert.equal(result, 'Usage: limit:<1-20>');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('errors command returns failed job diagnostics', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-errors-command');
  const store = new Store(dbPath, () => 3000);
  try {
    store.saveMessage({
      id: 'failed-1',
      chatId: 'chat',
      senderId: 'sender',
      content: 'failed message',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.createProcessingJob('failed-1');
    store.markProcessing('failed-1', 'codex');
    store.markFailed('failed-1', 'codex', 'codex exploded with a long error');

    const commands = createCommandRegistry(store, createRuntime(dbPath));
    const result = await commands.get('errors')?.('5', dummyMessage);

    assert.match(result ?? '', /最近错误/);
    assert.match(result ?? '', /failed-1/);
    assert.match(result ?? '', /\*\*Mode:\*\* default/);
    assert.match(result ?? '', /\*\*Stage:\*\* codex/);
    assert.match(result ?? '', /\*\*Retries:\*\* 1/);
    assert.match(result ?? '', /codex exploded/);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});
