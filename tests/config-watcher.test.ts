import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ConfigFileWatcher } from '../src/config-watcher.js';
import type { RuntimeConfigWatcherState } from '../src/runtime-config.js';
import { RuntimeConfigManager } from '../src/runtime-config.js';
import { buildConfig, loadConfig } from '../src/config.js';
import { createTempDbPath, removeTempDir } from './helpers.js';

test('ConfigFileWatcher debounces directory events and recovers after transient reload failures', async () => {
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | null = null;
  let closed = 0;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const states: RuntimeConfigWatcherState[] = [];
  const reloadResults = [false, true];
  let reloads = 0;
  const watcher = new ConfigFileWatcher('/runtime/config.yaml', async () => {
    reloads += 1;
    return reloadResults.shift() ?? true;
  }, {
    debounceMs: 25,
    watch: (directory, callback) => {
      assert.equal(directory, '/runtime');
      listener = callback;
      return { close: () => { closed += 1; } };
    },
    setTimer: ((callback: () => void) => {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimer: ((timer: NodeJS.Timeout) => {
      timers.delete(timer as unknown as number);
    }) as typeof clearTimeout,
    onStateChange: (state) => states.push(state),
  });

  watcher.start();
  const emit = listener as unknown as (eventType: string, filename: string | Buffer | null) => void;
  emit('change', 'other.yaml');
  emit('change', 'config.yaml');
  emit('rename', 'config.yaml');
  assert.equal(timers.size, 1);
  [...timers.values()][0]?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reloads, 1);
  assert.equal(states.at(-1), 'degraded');

  emit('rename', null);
  [...timers.values()].at(-1)?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reloads, 2);
  assert.equal(states.at(-1), 'watching');

  await watcher.stop();
  await watcher.stop();
  assert.equal(closed, 1);
  assert.equal(states.at(-1), 'stopped');
});

test('ConfigFileWatcher retries when directory watching cannot start', async () => {
  const states: RuntimeConfigWatcherState[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let attempts = 0;
  const watcher = new ConfigFileWatcher('/runtime/config.yaml', async () => true, {
    retryInitialMs: 10,
    watch: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('path and credential details');
      return { close() {} };
    },
    setTimer: ((callback: () => void) => {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimer: ((timer: NodeJS.Timeout) => timers.delete(timer as unknown as number)) as typeof clearTimeout,
    onStateChange: (state) => states.push(state),
  });
  watcher.start();
  assert.deepEqual(states, ['starting', 'degraded']);
  [...timers.values()][0]?.();
  assert.equal(attempts, 2);
  assert.equal(states.at(-1), 'watching');
  await watcher.stop();
});

test('ConfigFileWatcher closes failed native handles and rebuilds with bounded backoff', async () => {
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  const errors: Array<() => void> = [];
  let closed = 0;
  let watches = 0;
  const states: RuntimeConfigWatcherState[] = [];
  const watcher = new ConfigFileWatcher('/runtime/config.yaml', async () => true, {
    retryInitialMs: 10,
    retryMaxMs: 20,
    watch: () => {
      watches += 1;
      return {
        close() { closed += 1; },
        on(_event, listener) { errors.push(listener); },
      };
    },
    setTimer: ((callback: () => void, delay?: number) => {
      nextTimer += 1;
      timers.set(nextTimer, { callback, delay: delay ?? 0 });
      return nextTimer as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimer: ((timer: NodeJS.Timeout) => timers.delete(timer as unknown as number)) as typeof clearTimeout,
    onStateChange: (state) => states.push(state),
  });

  watcher.start();
  errors[0]?.();
  assert.equal(closed, 1);
  assert.equal(states.at(-1), 'degraded');
  assert.equal([...timers.values()][0]?.delay, 10);
  [...timers.values()][0]?.callback();
  assert.equal(watches, 2);
  assert.equal(states.at(-1), 'watching');

  errors[1]?.();
  assert.equal(closed, 2);
  assert.equal([...timers.values()].at(-1)?.delay, 20);
  [...timers.values()].at(-1)?.callback();
  assert.equal(watches, 3);
  await watcher.stop();
  assert.equal(closed, 3);
});

test('ConfigFileWatcher stop cancels native-handle retry', async () => {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let errorListener: (() => void) | null = null;
  let watches = 0;
  const watcher = new ConfigFileWatcher('/runtime/config.yaml', async () => true, {
    watch: () => {
      watches += 1;
      return {
        close() {},
        on(_event, listener) { errorListener = listener; },
      };
    },
    setTimer: ((callback: () => void) => {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimer: ((timer: NodeJS.Timeout) => timers.delete(timer as unknown as number)) as typeof clearTimeout,
  });

  watcher.start();
  (errorListener as (() => void) | null)?.();
  assert.equal(timers.size, 1);
  const retry = [...timers.values()][0];
  await watcher.stop();
  assert.equal(timers.size, 0);
  retry?.();
  assert.equal(watches, 1);
});

test('watcher loadConfig path rejects incomplete real files, preserves snapshot, and recovers', async () => {
  const { dir } = createTempDbPath('doujie-watcher-real-config');
  const configFile = path.join(dir, 'config.yaml');
  const initial = buildConfig({ codex: { model: 'stable-model' } }, {});
  const manager = new RuntimeConfigManager(initial, () => loadConfig({ requireFile: true, configFile, env: {} }));
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | null = null;
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const watcher = new ConfigFileWatcher(configFile, async () => (await manager.reload('watcher')).ok, {
    debounceMs: 1,
    watch: (_directory, callback) => { listener = callback; return { close() {} }; },
    setTimer: ((callback: () => void) => {
      timerId += 1; timers.set(timerId, callback); return timerId as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimer: ((timer: NodeJS.Timeout) => { timers.delete(timer as unknown as number); }) as typeof clearTimeout,
  });
  const applyWrite = async (content: string): Promise<boolean> => {
    fs.writeFileSync(configFile, content, 'utf-8');
    (listener as unknown as (eventType: string, filename: string) => void)('change', 'config.yaml');
    const entry = [...timers.entries()].at(-1);
    assert.ok(entry);
    timers.delete(entry[0]);
    entry[1]();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return manager.getStatus().lastReloadFailure === null;
  };
  try {
    watcher.start();
    for (const invalid of [
      '',
      '   \n\t',
      'privacy:\n',
      'privacy: [\n',
      'privacy:\n  allow_user_ids: null\n',
      'privacy:\n  admin_user_ids: null\n',
      'codex:\n  model: null\n',
      'feishu:\n  edit_polling:\n    enabled: null\n',
      'feishu:\n  edit_polling:\n    chat_ids: null\n',
      'privacy:\n  allow_user_ids:\n    - null\n',
    ]) {
      await applyWrite(invalid);
      assert.equal(manager.getSnapshot().config.codex.model, 'stable-model');
      assert.equal(manager.getStatus().lastReloadFailure?.error, 'configuration validation failed');
    }
    await applyWrite([
      'codex:',
      '  model: recovered-model',
      'privacy:',
      '  allow_user_ids: []',
      '  admin_user_ids: []',
      'feishu:',
      '  as: bot',
      '  edit_polling:',
      '    enabled: false',
      '    chat_ids: []',
      '',
    ].join('\n'));
    assert.equal(manager.getSnapshot().config.codex.model, 'recovered-model');
    assert.equal(manager.getStatus().source, 'watcher');
  } finally {
    await watcher.stop();
    removeTempDir(dir);
  }
});

test('watcher rejects a valid partial security downgrade while manual reload can apply it', async () => {
  const { dir } = createTempDbPath('doujie-watcher-downgrade-gate');
  const configFile = path.join(dir, 'config.yaml');
  const initial = buildConfig({
    codex: { model: 'safe-model', workdir: '/safe/work', sandbox: 'read-only' },
    feishu: { bot_mention_names: ['MockBot'] },
    privacy: {
      allow_user_ids: ['ou_mock_allowed'],
      admin_user_ids: ['ou_mock_admin'],
      private: { allow_user_ids: ['ou_mock_admin'] },
      groups: [{
        chat_id: 'oc_mock_group', allow_user_ids: ['ou_mock_allowed'],
        allow_agent_user_ids: ['ou_mock_admin'],
      }],
      skip_patterns: [{ name: 'skip_mock', pattern: 'SECRET' }],
      redact_patterns: [{ name: 'redact_mock', pattern: 'TOKEN' }],
    },
  }, {});
  const manager = new RuntimeConfigManager(initial, (source) => loadConfig({
    requireFile: source === 'watcher', configFile, env: {},
  }));
  try {
    fs.writeFileSync(configFile, [
      'privacy:',
      '  allow_user_ids:',
      '    - ou_mock_allowed',
      '',
    ].join('\n'), 'utf-8');
    const before = manager.getSnapshot();
    const rejected = await manager.reload('watcher');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'configuration validation failed');
    assert.deepEqual(rejected.changedFields, []);
    assert.equal(manager.getSnapshot(), before);
    assert.equal(manager.getSnapshot().version, 1);
    assert.deepEqual(manager.getSnapshot().config.privacy.adminUserIds, ['ou_mock_admin']);
    assert.equal(manager.getSnapshot().config.codex.model, 'safe-model');
    assert.deepEqual(manager.getSnapshot().config.feishu.botMentionNames, ['MockBot']);
    assert.doesNotMatch(JSON.stringify(manager.getReloadAudit()), /ou_mock|safe-model|MockBot|SECRET|TOKEN/);

    const manual = await manager.reload('manual');
    assert.equal(manual.ok, true);
    assert.equal(manager.getSnapshot().version, 2);
    assert.deepEqual(manager.getSnapshot().config.privacy.adminUserIds, []);
    assert.equal(manager.getSnapshot().config.codex.model, '');
    assert.deepEqual(manager.getSnapshot().config.feishu.botMentionNames, []);

    fs.writeFileSync(configFile, [
      'output:',
      '  transport: post',
      'codex:',
      '  model: restored-model',
      '  sandbox: danger-full-access',
      '  skip_git_repo_check: false',
      'privacy:',
      '  allow_user_ids:',
      '    - ou_mock_allowed',
      '',
    ].join('\n'), 'utf-8');
    const accepted = await manager.reload('watcher');
    assert.equal(accepted.ok, true);
    assert.equal(manager.getSnapshot().version, 3);
    assert.equal(manager.getSnapshot().config.output.transport, 'post');
    assert.equal(manager.getSnapshot().config.codex.model, 'restored-model');
  } finally { removeTempDir(dir); }
});
