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

test('RuntimeConfigManager atomically hot-applies only features and reports restart fields', async () => {
  const initial = buildConfig({
    codex: { model: 'old-model' },
    features: { quoted_message: { enabled: false, max_chars: 1000 } },
    privacy: { groups: [{ chat_id: 'oc_group', allow_user_ids: ['ou_old'] }] },
  }, {});
  const candidate = buildConfig({
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
  assert.equal(applied.config.features.quotedMessage.enabled, true);
  assert.equal(applied.config.codex.model, 'old-model');
  assert.deepEqual(applied.config.privacy.groups?.[0]?.allowUserIds, ['ou_old']);
  assert.deepEqual(resolveQuotedMessageFeature(applied, 'oc_group'), { enabled: true, maxChars: 700 });
  assert.equal(applied.loadedAt, 300);
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
