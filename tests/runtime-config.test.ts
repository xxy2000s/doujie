import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConfig } from '../src/config.js';
import { RuntimeConfigManager, resolveQuotedMessageFeature } from '../src/runtime-config.js';

test('RuntimeConfigManager freezes snapshots and resolves group overrides', () => {
  const config = buildConfig({
    features: { quoted_message: { enabled: true, max_chars: 1000 } },
    privacy: { groups: [{ chat_id: 'oc_group', features: { quoted_message: { enabled: false } } }] },
  }, {});
  const manager = new RuntimeConfigManager(config, () => config, () => 100);
  const snapshot = manager.getSnapshot();

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.loadedAt, 100);
  assert.equal(Object.isFrozen(snapshot.config), true);
  assert.equal(Object.isFrozen(snapshot.config.privacy.groups?.[0]), true);
  assert.deepEqual(resolveQuotedMessageFeature(snapshot, 'oc_group'), { enabled: false, maxChars: 1000 });
  assert.deepEqual(resolveQuotedMessageFeature(snapshot, 'oc_other'), { enabled: true, maxChars: 1000 });
  assert.throws(() => {
    (snapshot.config.features.quotedMessage as { enabled: boolean }).enabled = false;
  }, TypeError);
});

test('RuntimeConfigManager atomically hot-applies output and features and reports restart fields', async () => {
  const initial = buildConfig({
    codex: { model: 'old-model' },
    features: { quoted_message: { enabled: false, max_chars: 1000 } },
    privacy: { groups: [{ chat_id: 'oc_group', allow_user_ids: ['ou_old'] }] },
  }, {});
  const candidate = buildConfig({
    output: { transport: 'post' },
    codex: { model: 'new-model' },
    features: { quoted_message: { enabled: true, max_chars: 2000 } },
    privacy: {
      groups: [{
        chat_id: 'oc_group',
        allow_user_ids: ['ou_new'],
        features: { quoted_message: { max_chars: 700 } },
      }],
    },
  }, {});
  let now = 200;
  const manager = new RuntimeConfigManager(initial, () => candidate, () => now);
  const inFlight = manager.getSnapshot();
  now = 300;

  const result = await manager.reload();
  const applied = manager.getSnapshot();

  assert.deepEqual(result, {
    ok: true,
    previousVersion: 1,
    version: 2,
    changed: true,
    restartRequired: ['codex.model', 'privacy.groups'],
  });
  assert.equal(inFlight.config.features.quotedMessage.enabled, false);
  assert.equal(inFlight.config.output.transport, 'card');
  assert.equal(applied.config.output.transport, 'post');
  assert.equal(applied.config.features.quotedMessage.enabled, true);
  assert.equal(applied.config.codex.model, 'old-model');
  assert.deepEqual(applied.config.privacy.groups?.[0]?.allowUserIds, ['ou_old']);
  assert.deepEqual(resolveQuotedMessageFeature(applied, 'oc_group'), { enabled: true, maxChars: 700 });
  assert.equal(applied.loadedAt, 300);
});

test('RuntimeConfigManager hot-switches output transport without mutating captured snapshots', () => {
  let now = 400;
  const config = buildConfig({}, {});
  const manager = new RuntimeConfigManager(config, () => config, () => now);
  const before = manager.getSnapshot();

  now = 500;
  const after = manager.setOutputTransport('post');

  assert.equal(before.config.output.transport, 'card');
  assert.equal(after.config.output.transport, 'post');
  assert.equal(after.version, 2);
  assert.equal(after.loadedAt, 500);
  assert.equal(manager.setOutputTransport('post'), after);
});

test('RuntimeConfigManager preserves a later output switch while an earlier reload is loading', async () => {
  const initial = buildConfig({
    output: { transport: 'card' },
    features: { quoted_message: { enabled: false } },
  }, {});
  const candidate = buildConfig({
    output: { transport: 'card' },
    features: { quoted_message: { enabled: true } },
  }, {});
  let resolveLoad!: (config: typeof candidate) => void;
  const loading = new Promise<typeof candidate>((resolve) => { resolveLoad = resolve; });
  const manager = new RuntimeConfigManager(initial, () => loading);

  const reload = manager.reload();
  await Promise.resolve();
  const switched = manager.setOutputTransport('post');
  resolveLoad(candidate);
  const result = await reload;

  assert.equal(switched.version, 2);
  assert.equal(manager.getSnapshot().version, 3);
  assert.equal(manager.getSnapshot().config.output.transport, 'post');
  assert.equal(manager.getSnapshot().config.features.quotedMessage.enabled, true);
  assert.deepEqual(result, {
    ok: true,
    previousVersion: 1,
    version: 3,
    changed: true,
    restartRequired: [],
  });
});

test('RuntimeConfigManager preserves snapshot and version on invalid or restart-only reload', async () => {
  const initial = buildConfig({}, {});
  const invalid = new RuntimeConfigManager(initial, () => { throw new Error('secret config body'); });
  const beforeInvalid = invalid.getSnapshot();
  const failure = await invalid.reload();
  assert.equal(invalid.getSnapshot(), beforeInvalid);
  assert.deepEqual(failure, {
    ok: false,
    previousVersion: 1,
    version: 1,
    changed: false,
    restartRequired: [],
    error: 'configuration validation failed',
  });

  const changedInfra = buildConfig({ storage: { db_path: '/tmp/other.db' } }, {});
  const restartOnly = new RuntimeConfigManager(initial, () => changedInfra);
  const beforeRestart = restartOnly.getSnapshot();
  const result = await restartOnly.reload();
  assert.equal(restartOnly.getSnapshot(), beforeRestart);
  assert.equal(result.changed, false);
  assert.equal(result.version, 1);
  assert.deepEqual(result.restartRequired, ['storage.db_path']);
});
