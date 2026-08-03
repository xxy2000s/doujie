import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildConfig } from '../src/config.js';
import {
  RuntimeConfigManager,
  canonicalizeWorkdir,
  isUnsafeWatcherDowngrade,
  resolveQuotedMessageFeature,
} from '../src/runtime-config.js';

test('RuntimeConfigManager freezes snapshots and resolves group overrides', () => {
  const config = buildConfig({
    features: { quoted_message: { enabled: true, max_chars: 1000, max_depth: 4, include_attachments: true } },
    privacy: { groups: [{
      chat_id: 'oc_group',
      features: { quoted_message: { enabled: false, max_depth: 2, include_attachments: false } },
    }] },
  }, {});
  const manager = new RuntimeConfigManager(config, () => config, () => 100);
  const snapshot = manager.getSnapshot();

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.loadedAt, 100);
  assert.equal(Object.isFrozen(snapshot.config), true);
  assert.equal(Object.isFrozen(snapshot.config.privacy.groups?.[0]), true);
  assert.deepEqual(resolveQuotedMessageFeature(snapshot, 'oc_group'), {
    enabled: false, maxChars: 1000, maxDepth: 2, includeAttachments: false,
  });
  assert.deepEqual(resolveQuotedMessageFeature(snapshot, 'oc_other'), {
    enabled: true, maxChars: 1000, maxDepth: 4, includeAttachments: true,
  });
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
    features: { quoted_message: { enabled: true, max_chars: 2000, max_depth: 3, include_attachments: true } },
    privacy: {
      groups: [{
        chat_id: 'oc_group',
        allow_user_ids: ['ou_new'],
        features: { quoted_message: { max_chars: 700, max_depth: 2, include_attachments: false } },
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
    changedFields: [
      'codex.model',
      'features.quoted_message.enabled',
      'features.quoted_message.include_attachments',
      'features.quoted_message.max_chars',
      'features.quoted_message.max_depth',
      'output.transport',
      'privacy.groups',
    ],
    restartRequired: [],
    lifecycleActions: [],
  });
  assert.equal(inFlight.config.features.quotedMessage.enabled, false);
  assert.equal(inFlight.config.output.transport, 'card');
  assert.equal(applied.config.output.transport, 'post');
  assert.equal(applied.config.features.quotedMessage.enabled, true);
  assert.equal(applied.config.codex.model, 'new-model');
  assert.deepEqual(applied.config.privacy.groups?.[0]?.allowUserIds, ['ou_new']);
  assert.deepEqual(resolveQuotedMessageFeature(applied, 'oc_group'), {
    enabled: true, maxChars: 700, maxDepth: 2, includeAttachments: false,
  });
  assert.equal(applied.loadedAt, 300);
});

test('RuntimeConfigManager hot-switches output transport without mutating captured snapshots', async () => {
  let now = 400;
  const config = buildConfig({}, {});
  const manager = new RuntimeConfigManager(config, () => config, () => now);
  const before = manager.getSnapshot();

  now = 500;
  const after = await manager.setOutputTransport('post');

  assert.equal(before.config.output.transport, 'card');
  assert.equal(after.config.output.transport, 'post');
  assert.equal(after.version, 2);
  assert.equal(after.loadedAt, 500);
  assert.equal(await manager.setOutputTransport('post'), after);
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
  const switchedSnapshot = await switched;

  assert.equal(result.version, 2);
  assert.equal(switchedSnapshot.version, 3);
  assert.equal(manager.getSnapshot().version, 3);
  assert.equal(manager.getSnapshot().config.output.transport, 'post');
  assert.equal(manager.getSnapshot().config.features.quotedMessage.enabled, true);
  assert.deepEqual(result, {
    ok: true,
    previousVersion: 1,
    version: 2,
    changed: true,
    changedFields: ['features.quoted_message.enabled'],
    restartRequired: [],
    lifecycleActions: [],
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
    changedFields: [],
    restartRequired: [],
    lifecycleActions: [],
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

test('RuntimeConfigManager exposes scoped features without identifiers or paths', () => {
  const config = buildConfig({
    features: { quoted_message: { enabled: true, max_chars: 1200 } },
    privacy: {
      groups: [{
        chat_id: 'oc_private_group',
        features: { quoted_message: { enabled: false, max_chars: 400 } },
      }],
    },
  }, {});
  const manager = new RuntimeConfigManager(config, () => config, () => 100);

  assert.deepEqual(manager.getEffectiveFeatures('oc_private_group'), {
    quotedMessage: {
      enabled: false, maxChars: 400, maxDepth: 1, includeAttachments: false, scope: 'group_override',
    },
  });
  assert.deepEqual(manager.getEffectiveFeatures('oc_other'), {
    quotedMessage: {
      enabled: true, maxChars: 1200, maxDepth: 1, includeAttachments: false, scope: 'global',
    },
  });
  assert.doesNotMatch(JSON.stringify(manager.getEffectiveFeatures('oc_private_group')), /oc_private_group|\/Users\//);
});

test('RuntimeConfigManager keeps a bounded redacted reload audit and status metadata', async () => {
  const initial = buildConfig({}, {});
  let now = 100;
  const manager = new RuntimeConfigManager(initial, () => {
    throw new Error('token=super-secret /Users/private/.doujie/config.yaml');
  }, () => now++);

  for (let index = 0; index < 25; index += 1) {
    await manager.reload();
  }

  const audit = manager.getReloadAudit();
  const status = manager.getStatus();
  assert.equal(audit.length, 20);
  assert.equal(Object.isFrozen(audit), true);
  assert.equal(Object.isFrozen(audit[0]), true);
  assert.equal(status.version, 1);
  assert.equal(status.loadedAt, 100);
  assert.equal(status.source, 'startup');
  assert.equal(status.watcherState, 'disabled');
  assert.deepEqual(status.lastLifecycleActions, []);
  assert.equal(status.lastReloadFailure?.error, 'configuration validation failed');
  assert.doesNotMatch(JSON.stringify({ audit, status }), /super-secret|\/Users\/private/);
});

test('RuntimeConfigManager hot-applies request settings while preserving restart-bound roots and listener identity', async () => {
  const initial = buildConfig({
    codex: { model: 'old', workdir: '/workspace/old', control_session_dir: '/state/old' },
    feishu: { as: 'bot', chat_ids: ['listener-old'], bot_mention_names: ['Old'], edit_polling: { enabled: false } },
    privacy: { allow_user_ids: ['user-old'] },
    attachments: { ocr_command: 'ocr-old' },
    storage: { db_path: '/state/old.db' },
  }, {});
  const candidate = buildConfig({
    codex: {
      model: 'new', workdir: '/workspace/new', sandbox: 'read-only',
      skip_git_repo_check: true, control_session_dir: '/state/new',
    },
    feishu: {
      as: 'user', chat_ids: ['listener-new'], bot_mention_names: ['New'],
      edit_polling: { enabled: true, chat_ids: ['poll-chat'], as: 'user', interval_ms: 2000, page_size: 10 },
    },
    privacy: { allow_user_ids: ['user-new'], redact_patterns: [{ name: 'secret', pattern: 'secret' }] },
    attachments: { ocr_command: 'ocr-new' },
    storage: { db_path: '/state/new.db' },
  }, {});
  const manager = new RuntimeConfigManager(initial, () => candidate, () => 500);
  const before = manager.getSnapshot();
  const result = await manager.reload();
  const after = manager.getSnapshot();

  assert.equal(before.config.codex.model, 'old');
  assert.deepEqual(before.config.privacy.allowUserIds, ['user-old']);
  assert.equal(after.config.codex.model, 'new');
  assert.equal(after.config.codex.workdir, '/workspace/new');
  assert.equal(after.config.codex.sandbox, 'read-only');
  assert.equal(after.config.codex.skipGitRepoCheck, true);
  assert.deepEqual(after.config.feishu.botMentionNames, ['New']);
  assert.equal(after.config.feishu.editPolling.enabled, true);
  assert.deepEqual(after.config.privacy.allowUserIds, ['user-new']);
  assert.equal(after.config.attachments.ocrCommand, 'ocr-new');
  assert.equal(after.config.codex.controlSessionDir, '/state/old');
  assert.equal(after.config.feishu.as, 'bot');
  assert.deepEqual(after.config.feishu.chatIds, ['listener-old']);
  assert.equal(after.config.storage.dbPath, '/state/old.db');
  assert.deepEqual(result.restartRequired, [
    'codex.control_session_dir',
    'feishu.as',
    'feishu.chat_ids',
    'storage.db_path',
  ]);
});

test('RuntimeConfigManager serializes manual and watcher reloads', async () => {
  const initial = buildConfig({ codex: { model: 'initial' } }, {});
  const manualCandidate = buildConfig({ codex: { model: 'manual' } }, {});
  const watcherCandidate = buildConfig({ codex: { model: 'watcher' } }, {});
  let releaseManual!: (config: typeof manualCandidate) => void;
  const firstLoad = new Promise<typeof manualCandidate>((resolve) => { releaseManual = resolve; });
  const candidates = [firstLoad, Promise.resolve(watcherCandidate)];
  const loaderSources: Array<string | undefined> = [];
  const manager = new RuntimeConfigManager(initial, (source) => {
    loaderSources.push(source);
    return candidates.shift() ?? watcherCandidate;
  });

  const manual = manager.reload('manual');
  const watcher = manager.reload('watcher');
  await Promise.resolve();
  assert.equal(manager.getSnapshot().config.codex.model, 'initial');
  releaseManual(manualCandidate);
  assert.equal((await manual).version, 2);
  assert.equal((await watcher).version, 3);
  assert.equal(manager.getSnapshot().config.codex.model, 'watcher');
  assert.deepEqual(loaderSources, ['manual', 'watcher']);
  assert.deepEqual(manager.getReloadAudit().map((entry) => entry.source), ['manual', 'watcher']);
});

test('RuntimeConfigManager keeps an applied snapshot and retries after reconciliation failure', async () => {
  const initial = buildConfig({ feishu: { edit_polling: { enabled: false } } }, {});
  const candidate = buildConfig({
    feishu: { edit_polling: { enabled: true, chat_ids: ['poll-chat'] } },
  }, {});
  let attempts = 0;
  const manager = new RuntimeConfigManager(initial, () => candidate);
  manager.setReconciler(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('token and config contents');
    return ['poller:start'];
  });

  const failed = await manager.reload('watcher');
  assert.equal(failed.ok, false);
  assert.equal(failed.changed, true);
  assert.equal(failed.error, 'component reconciliation failed');
  assert.deepEqual(failed.lifecycleActions, ['poller:error']);
  assert.equal(manager.getSnapshot().config.feishu.editPolling.enabled, true);
  assert.doesNotMatch(JSON.stringify(manager.getReloadAudit()), /token|config contents/);

  const recovered = await manager.reload('watcher');
  assert.equal(recovered.ok, true);
  assert.equal(recovered.changed, false);
  assert.deepEqual(recovered.lifecycleActions, ['poller:start']);
  assert.equal(attempts, 2);
});

test('watcher safety policy rejects security downgrades and permits non-downgrade changes', () => {
  const current = buildConfig({
    codex: { model: 'safe-model', workdir: '/safe/work', sandbox: 'read-only', skip_git_repo_check: false },
    feishu: { bot_mention_names: ['MockBot'] },
    privacy: {
      allow_chat_ids: ['chat-a'], deny_chat_ids: ['chat-denied'],
      allow_user_ids: ['user-a'], deny_user_ids: ['user-denied'], admin_user_ids: ['admin-a'],
      private: { allow_user_ids: ['user-a'] },
      groups: [{ chat_id: 'group-a', allow_user_ids: ['user-a'], allow_agent_user_ids: ['admin-a'] }],
      skip_patterns: [{ name: 'skip-a', pattern: 'SECRET' }],
      redact_patterns: [{ name: 'redact-a', pattern: 'TOKEN', replacement: '[X]' }],
    },
  }, {});
  const mutate = (change: (candidate: ReturnType<typeof buildConfig>) => void) => {
    const candidate = structuredClone(current) as ReturnType<typeof buildConfig>;
    change(candidate);
    return isUnsafeWatcherDowngrade(current, candidate);
  };
  assert.equal(mutate((c) => { c.privacy.adminUserIds = []; }), true);
  assert.equal(mutate((c) => { c.privacy.privateAllowUserIds = []; }), true);
  assert.equal(mutate((c) => { c.privacy.groups = []; }), true);
  assert.equal(mutate((c) => { c.privacy.groups![0]!.allowAgentUserIds = []; }), true);
  assert.equal(mutate((c) => { c.privacy.skipPatterns = []; }), true);
  assert.equal(mutate((c) => { c.privacy.redactPatterns = []; }), true);
  assert.equal(mutate((c) => { c.privacy.denyChatIds = []; }), true);
  assert.equal(mutate((c) => { c.privacy.allowChatIds = []; }), true);
  assert.equal(mutate((c) => { c.feishu.botMentionNames = []; }), true);
  assert.equal(mutate((c) => { c.feishu.botMentionNames = ['OtherBot']; }), true);
  assert.equal(mutate((c) => { c.feishu.botMentionIds = ['bot-id']; }), true);
  assert.equal(mutate((c) => { c.codex.model = ''; }), true);
  assert.equal(mutate((c) => { c.codex.workdir = ''; }), true);
  assert.equal(mutate((c) => { c.codex.sandbox = 'danger-full-access'; }), true);
  assert.equal(mutate((c) => { c.codex.skipGitRepoCheck = true; }), true);
  assert.equal(mutate((c) => {
    c.output.transport = 'post';
    c.codex.model = 'new-safe-model';
    c.privacy.denyChatIds.push('another-denied-chat');
    c.privacy.skipPatterns.push({ name: 'skip-b', pattern: 'PRIVATE' });
  }), false);
});

test('watcher exact-set checks cannot replace duplicate authorization or mention entries', () => {
  const duplicate = buildConfig({
    feishu: {
      bot_mention_ids: ['bot-id', 'bot-id'],
      bot_mention_names: ['MockBot', 'MockBot'],
    },
    privacy: {
      allow_chat_ids: ['chat-a', 'chat-a'],
      allow_user_ids: ['user-a', 'user-a'],
      admin_user_ids: ['admin-a', 'admin-a'],
      private: { allow_user_ids: ['private-a', 'private-a'] },
      groups: [{
        chat_id: 'group-a',
        allow_user_ids: ['member-a', 'member-a'],
        allow_agent_user_ids: ['agent-a', 'agent-a'],
      }],
    },
  }, {});
  const replaced = (change: (candidate: ReturnType<typeof buildConfig>) => void) => {
    const candidate = structuredClone(duplicate) as ReturnType<typeof buildConfig>;
    change(candidate);
    return isUnsafeWatcherDowngrade(duplicate, candidate);
  };

  assert.equal(replaced((c) => { c.privacy.allowChatIds = ['chat-a', 'attacker']; }), true);
  assert.equal(replaced((c) => { c.privacy.allowUserIds = ['user-a', 'attacker']; }), true);
  assert.equal(replaced((c) => { c.privacy.adminUserIds = ['admin-a', 'attacker']; }), true);
  assert.equal(replaced((c) => { c.privacy.privateAllowUserIds = ['private-a', 'attacker']; }), true);
  assert.equal(replaced((c) => { c.privacy.groups![0]!.allowUserIds = ['member-a', 'attacker']; }), true);
  assert.equal(replaced((c) => { c.privacy.groups![0]!.allowAgentUserIds = ['agent-a', 'attacker']; }), true);
  assert.equal(replaced((c) => { c.feishu.botMentionIds = ['bot-id', 'attacker']; }), true);
  assert.equal(replaced((c) => { c.feishu.botMentionNames = ['MockBot', 'AttackerBot']; }), true);
});

test('watcher compares workdirs by canonical location and manual reload owns real moves', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doujie-workdir-policy-'));
  const target = path.join(temp, 'target');
  const sibling = path.join(temp, 'sibling');
  const sameLink = path.join(temp, 'same-link');
  const differentLink = path.join(temp, 'different-link');
  const nestedTarget = path.join(sibling, 'nested');
  const traversalLink = path.join(temp, 'traversal-link');
  fs.mkdirSync(target);
  fs.mkdirSync(sibling);
  fs.mkdirSync(nestedTarget);
  fs.symlinkSync(target, sameLink, 'dir');
  fs.symlinkSync(sibling, differentLink, 'dir');
  fs.symlinkSync(nestedTarget, traversalLink, 'dir');

  assert.equal(canonicalizeWorkdir('.'), canonicalizeWorkdir('./'));
  assert.equal(canonicalizeWorkdir(target), canonicalizeWorkdir(path.join(target, '.')));
  assert.equal(canonicalizeWorkdir(target), canonicalizeWorkdir(sameLink));
  const symlinkParentTraversal = `${traversalLink}${path.sep}..`;
  assert.equal(canonicalizeWorkdir(symlinkParentTraversal), canonicalizeWorkdir(sibling));
  assert.notEqual(canonicalizeWorkdir(symlinkParentTraversal), canonicalizeWorkdir(temp));

  const traversalCurrent = buildConfig({ codex: { workdir: temp } }, {});
  const traversalCandidate = structuredClone(traversalCurrent) as ReturnType<typeof buildConfig>;
  traversalCandidate.codex.workdir = symlinkParentTraversal;
  assert.equal(isUnsafeWatcherDowngrade(traversalCurrent, traversalCandidate), true);

  const initial = buildConfig({
    codex: { workdir: target },
    feishu: { bot_mention_ids: ['mock-bot-id'], bot_mention_names: ['MockBot'] },
  }, {});
  let candidate = structuredClone(initial) as ReturnType<typeof buildConfig>;
  const manager = new RuntimeConfigManager(initial, () => candidate);
  try {
    for (const equivalent of [path.join(target, '.'), path.join(target, './'), sameLink]) {
      const retainedWorkdir = manager.getSnapshot().config.codex.workdir;
      candidate = structuredClone(manager.getSnapshot().config) as ReturnType<typeof buildConfig>;
      candidate.codex.workdir = equivalent;
      const accepted = await manager.reload('watcher');
      assert.equal(accepted.ok, true);
      assert.equal(manager.getSnapshot().config.codex.workdir, retainedWorkdir);
      assert.equal(canonicalizeWorkdir(manager.getSnapshot().config.codex.workdir), canonicalizeWorkdir(target));
    }

    fs.unlinkSync(sameLink);
    fs.symlinkSync(sibling, sameLink, 'dir');
    assert.equal(manager.getSnapshot().config.codex.workdir, target);
    assert.equal(canonicalizeWorkdir(manager.getSnapshot().config.codex.workdir), canonicalizeWorkdir(target));

    const unsafeLocations = [
      '..',
      path.dirname(target),
      '/',
      os.homedir(),
      sibling,
      differentLink,
      path.join(target, '..', 'sibling'),
    ];
    for (const unsafe of unsafeLocations) {
      const before = manager.getSnapshot();
      candidate = structuredClone(before.config) as ReturnType<typeof buildConfig>;
      candidate.codex.workdir = unsafe;
      const rejected = await manager.reload('watcher');
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error, 'configuration validation failed');
      assert.deepEqual(rejected.changedFields, []);
      assert.equal(manager.getSnapshot(), before);
      assert.equal(manager.getSnapshot().version, before.version);
      const audit = JSON.stringify(manager.getReloadAudit().at(-1));
      assert.doesNotMatch(audit, new RegExp(path.basename(temp)));
      assert.doesNotMatch(audit, /target|sibling|same-link|different-link/);
    }

    candidate = structuredClone(manager.getSnapshot().config) as ReturnType<typeof buildConfig>;
    candidate.codex.workdir = differentLink;
    const manual = await manager.reload('manual');
    assert.equal(manual.ok, true);
    assert.equal(manager.getSnapshot().config.codex.workdir, differentLink);
    assert.equal(canonicalizeWorkdir(manager.getSnapshot().config.codex.workdir), canonicalizeWorkdir(sibling));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
