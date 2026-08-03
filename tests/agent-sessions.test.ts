import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  AgentSessionRegistryStore,
  type AgentSessionRecord,
} from '../src/agent-session-registry.js';
import {
  AgentSessionIntentController,
  parseCreateAgentSessionIntent,
  PendingAgentActionStore,
} from '../src/agent-session-intent.js';
import {
  buildClaudeCreateArgs,
  buildCodexCreateArgs,
  buildCodexResumeArgs,
  extractProviderResult,
  HeadlessAgentRunner,
  type CreateAgentSessionDraft,
  type HeadlessAgentRunnerLike,
  type HeadlessAgentRuntimeDefaults,
} from '../src/headless-agent-runner.js';
import { createCommandRegistry } from '../src/commands/index.js';
import { Router, type AgentSessionIntentControllerLike, type ReplyClient } from '../src/router.js';
import { Store } from '../src/store.js';
import type { AIResult, MessageContent } from '../src/types.js';
import { createTempDbPath, removeTempDir } from './helpers.js';
import { buildConfig } from '../src/config.js';
import { RuntimeConfigManager } from '../src/runtime-config.js';

function message(text: string, messageId = 'msg-1'): MessageContent {
  return {
    messageId,
    chatId: 'oc_test',
    chatType: 'p2p',
    senderId: 'ou_test',
    messageType: 'text',
    text,
    rawContent: JSON.stringify({ text }),
    mentions: [],
  };
}

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    alias: 'demo-main',
    provider: 'codex',
    nativeSessionId: '019-session',
    cwd: '/tmp/demo',
    jsonlPath: null,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    lastUsedAt: null,
    createdBy: { chatId: 'oc_test', senderId: 'ou_test' },
    launch: { model: '', sandbox: 'workspace-write', permissionMode: '', outputFormat: 'json' },
    ...overrides,
  };
}

test('parseCreateAgentSessionIntent extracts provider cwd alias and prompt', () => {
  const parsed = parseCreateAgentSessionIntent(
    '去 /home/doujie/service/doujie 开个 codex session，叫 doujie-main，让它先熟悉项目'
  );

  assert.equal(parsed.kind, 'draft');
  if (parsed.kind !== 'draft') return;
  assert.equal(parsed.draft.provider, 'codex');
  assert.equal(parsed.draft.cwd, '/home/doujie/service/doujie');
  assert.equal(parsed.draft.alias, 'doujie-main');
  assert.equal(parsed.draft.prompt, '先熟悉项目');
  assert.equal(parsed.draft.sandbox, 'danger-full-access');
  assert.equal(parsed.draft.skipGitRepoCheck, true);
});

test('parseCreateAgentSessionIntent asks for missing structured fields', () => {
  const parsed = parseCreateAgentSessionIntent('帮我开个 agent session');

  assert.equal(parsed.kind, 'missing');
  if (parsed.kind !== 'missing') return;
  assert.deepEqual(parsed.missing, ['provider(codex/claude)', 'cwd/工作区路径', 'alias/别名']);
});

test('registry stores and retrieves sessions by alias', () => {
  const { dir } = createTempDbPath('doujie-agent-registry');
  try {
    const registry = new AgentSessionRegistryStore(path.join(dir, 'agent-sessions.json'));
    registry.upsert(record());

    assert.equal(registry.get('demo-main')?.nativeSessionId, '019-session');
    assert.equal(registry.list().length, 1);
  } finally {
    removeTempDir(dir);
  }
});

test('headless provider args use cwd and full-access Codex defaults', () => {
  const codexDraft: CreateAgentSessionDraft = {
    provider: 'codex',
    alias: 'demo-main',
    cwd: '/repo/demo',
    prompt: 'hello',
    createdBy: { chatId: 'oc', senderId: 'ou' },
  };
  const claudeDraft: CreateAgentSessionDraft = {
    provider: 'claude',
    alias: 'demo-main',
    cwd: '/repo/demo',
    prompt: 'hello',
    createdBy: { chatId: 'oc', senderId: 'ou' },
  };

  assert.deepEqual(buildCodexCreateArgs(codexDraft), [
    'exec',
    '--json',
    '--ignore-user-config',
    '--cd',
    '/repo/demo',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    'hello',
  ]);
  assert.deepEqual(buildClaudeCreateArgs(claudeDraft), [
    '-p',
    '--output-format',
    'json',
    '--name',
    'demo-main',
    '--permission-mode',
    'default',
    'hello',
  ]);
});

test('Codex resume uses supported full-access flags before session id without shell quoting', () => {
  const prompt = 'line one\n`echo not-a-shell` $(false) "quoted"';
  const args = buildCodexResumeArgs(record(), prompt);

  assert.deepEqual(args, [
    'exec',
    'resume',
    '--json',
    '--ignore-user-config',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '019-session',
    prompt,
  ]);
  assert.equal(args.includes('--sandbox'), false);
});

test('HeadlessAgentRunner dispatch overrides Codex launch defaults from the request snapshot', async () => {
  const { dir } = createTempDbPath('doujie-codex-dispatch-defaults');
  const registry = new AgentSessionRegistryStore(path.join(dir, 'registry.json'));
  const calls: Array<{ provider: string; args: string[]; cwd: string }> = [];
  const runner = new HeadlessAgentRunner(registry, {
    codexSandbox: 'workspace-write', codexSkipGitRepoCheck: false,
  }, async (provider, args, cwd) => {
    calls.push({ provider, args, cwd });
    return { sessionId: null, text: 'ok' };
  });
  try {
    const result = await runner.dispatch({ record: record({ cwd: dir }), prompt: 'continue' }, {
      model: 'runtime-model', workdir: '/unused-default', sandbox: 'read-only', skipGitRepoCheck: true,
    });
    assert.equal(result.record.launch.model, 'runtime-model');
    assert.equal(result.record.launch.sandbox, 'read-only');
    assert.equal(result.record.cwd, dir);
    assert.deepEqual(calls[0], {
      provider: 'codex', cwd: dir,
      args: ['exec', 'resume', '--json', '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check', '--model', 'runtime-model', '019-session', 'continue'],
    });
  } finally { removeTempDir(dir); }
});

test('HeadlessAgentRunner dispatch leaves Claude launch metadata unchanged', async () => {
  const { dir } = createTempDbPath('doujie-claude-dispatch-defaults');
  const registry = new AgentSessionRegistryStore(path.join(dir, 'registry.json'));
  const original = record({
    provider: 'claude', cwd: dir, nativeSessionId: 'claude-session',
    launch: { model: 'claude-model', sandbox: '', permissionMode: 'plan', outputFormat: 'json' },
  });
  const runner = new HeadlessAgentRunner(registry, {
    codexSandbox: 'workspace-write', codexSkipGitRepoCheck: false,
  }, async () => ({ sessionId: null, text: 'ok' }));
  try {
    const result = await runner.dispatch({ record: original, prompt: 'continue' }, {
      model: 'codex-model', workdir: '/unused-default', sandbox: 'danger-full-access', skipGitRepoCheck: true,
    });
    assert.deepEqual(result.record.launch, original.launch);
  } finally { removeTempDir(dir); }
});

test('HeadlessAgentRunner create does not copy Codex runtime model into Claude registry metadata', async () => {
  const { dir } = createTempDbPath('doujie-claude-create-defaults');
  const registry = new AgentSessionRegistryStore(path.join(dir, 'registry.json'));
  const runner = new HeadlessAgentRunner(registry, {
    codexSandbox: 'workspace-write', codexSkipGitRepoCheck: false,
  }, async () => ({ sessionId: 'claude-created', text: 'ok' }));
  try {
    const created = await runner.create({
      provider: 'claude', alias: 'claude-main', cwd: dir, prompt: 'start',
      createdBy: { chatId: 'oc', senderId: 'ou' },
    }, {
      model: 'codex-only-model', workdir: '/unused-default', sandbox: 'danger-full-access', skipGitRepoCheck: true,
    });
    assert.equal(created.launch.model, '');
    assert.equal(created.launch.sandbox, '');
    assert.equal(created.launch.permissionMode, 'default');
  } finally { removeTempDir(dir); }
});

test('provider output parser captures Codex and Claude session ids', () => {
  assert.deepEqual(
    extractProviderResult('codex', [
      JSON.stringify({ type: 'thread.started', thread_id: '019-codex' }),
      JSON.stringify({ item: { type: 'agent_message', text: 'CODEX_OK' } }),
    ].join('\n')),
    { sessionId: '019-codex', text: 'CODEX_OK' }
  );
  assert.deepEqual(
    extractProviderResult('claude', JSON.stringify({ type: 'result', session_id: 'claude-1', result: 'CLAUDE_OK' })),
    { sessionId: 'claude-1', text: 'CLAUDE_OK' }
  );
});

test('intent controller stores a pending action and creates after confirmation', async () => {
  const { dir } = createTempDbPath('doujie-agent-intent');
  const pending = new PendingAgentActionStore(path.join(dir, 'pending.json'));
  const created: CreateAgentSessionDraft[] = [];
  const observedDefaults: Array<HeadlessAgentRuntimeDefaults | undefined> = [];
  const runner: HeadlessAgentRunnerLike = {
    async create(draft: CreateAgentSessionDraft, defaults): Promise<AgentSessionRecord> {
      created.push(draft);
      observedDefaults.push(defaults);
      return record({ alias: draft.alias, provider: draft.provider, cwd: draft.cwd });
    },
    async dispatch(): Promise<{ record: AgentSessionRecord; text: string }> {
      throw new Error('dispatch should not run');
    },
  };
  const controller = new AgentSessionIntentController(runner, pending, () => new Date('2099-07-31T00:00:00.000Z'));
  try {
    const approvedDefaults: HeadlessAgentRuntimeDefaults = {
      model: 'approved-model', workdir: '/ignored-default', sandbox: 'read-only', skipGitRepoCheck: false,
    };
    const draftReply = await controller.handle(
      message('去 /home/doujie/service/doujie 开个 codex session，叫 doujie-main，让它先熟悉项目'),
      approvedDefaults
    );
    assert.match(draftReply?.text ?? '', /请确认是否创建新的 Agent session/);
    assert.match(draftReply?.text ?? '', /Alias:\*\* `doujie-main`/);
    assert.match(draftReply?.text ?? '', /Model:\*\* approved-model/);
    assert.match(draftReply?.text ?? '', /Sandbox:\*\* read-only/);
    assert.match(draftReply?.text ?? '', /Skip Git Repo Check:\*\* false/);

    const reloadedDefaults: HeadlessAgentRuntimeDefaults = {
      model: 'request-model',
      workdir: '/request/default',
      sandbox: 'danger-full-access',
      skipGitRepoCheck: true,
    };
    const confirmReply = await controller.handle(message('确认', 'msg-2'), reloadedDefaults);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.provider, 'codex');
    assert.equal(created[0]?.createdBy.senderId, 'ou_test');
    assert.deepEqual(observedDefaults, [{ ...approvedDefaults, workdir: '/home/doujie/service/doujie' }]);
    assert.match(confirmReply?.text ?? '', /已创建并登记 Agent session/);
    assert.equal(pending.get('oc_test', 'ou_test'), null);
  } finally {
    removeTempDir(dir);
  }
});

test('pending Agent confirmation remains owned by its sender and owner cancellation stays compatible', async () => {
  const { dir } = createTempDbPath('doujie-agent-pending-owner');
  const pending = new PendingAgentActionStore(path.join(dir, 'pending.json'));
  let creates = 0;
  const runner: HeadlessAgentRunnerLike = {
    async create() { creates += 1; return record(); },
    async dispatch() { throw new Error('dispatch should not run'); },
  };
  const controller = new AgentSessionIntentController(runner, pending);
  try {
    await controller.handle(message('去 /tmp 开个 codex session，叫 owner-main'));
    assert.equal(await controller.handle({ ...message('确认', 'other-confirm'), senderId: 'ou_other' }), null);
    assert.equal(creates, 0);
    assert.match((await controller.handle(message('取消', 'owner-cancel')))?.text ?? '', /已取消/);
    assert.equal(await controller.handle(message('确认', 'owner-confirm')), null);
    assert.equal(creates, 0);
  } finally { removeTempDir(dir); }
});

test('Router gives project-Agent operations the request-captured Codex defaults across reload', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-agent-runtime-defaults');
  const store = new Store(dbPath, () => 2500);
  const replies: string[] = [];
  const initial = buildConfig({
    codex: { model: 'old-model', workdir: '/old-workdir', sandbox: 'read-only', skip_git_repo_check: false },
  }, {});
  const candidate = buildConfig({
    codex: { model: 'new-model', workdir: '/new-workdir', sandbox: 'danger-full-access', skip_git_repo_check: true },
  }, {});
  const manager = new RuntimeConfigManager(initial, () => candidate);
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const defaults: HeadlessAgentRuntimeDefaults[] = [];
  const controller: AgentSessionIntentControllerLike = {
    async handle(_message, runtimeDefaults): Promise<{ text: string }> {
      assert.ok(runtimeDefaults);
      defaults.push(runtimeDefaults);
      if (defaults.length === 1) {
        firstStarted();
        await firstBlocked;
      }
      return { text: 'agent handled' };
    },
  };
  const replyClient: ReplyClient = {
    async replyToMessage() { throw new Error('digest should not run'); },
    async replyError() { throw new Error('error reply should not run'); },
    async replyText(_messageId, text) { replies.push(text); },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI should not run'); } },
    store, new Set<string>(), replyClient, undefined, initial.privacy,
    null, null, null, undefined, undefined, undefined, null, { ids: [], names: [] }, controller,
    null, manager
  );
  try {
    const first = router.handleEvent({
      schema: '2.0',
      header: { event_id: 'agent-old', event_type: 'im.message.receive_v1', create_time: '1' },
      event: { message: {
        message_id: 'agent-old', chat_id: 'private', chat_type: 'p2p',
        sender: { sender_id: { open_id: 'actor' } }, message_type: 'text',
        content: JSON.stringify({ text: '创建 codex session' }),
      } },
    });
    await started;
    await manager.reload('manual');
    releaseFirst();
    await first;
    await router.handleEvent({
      schema: '2.0',
      header: { event_id: 'agent-new', event_type: 'im.message.receive_v1', create_time: '2' },
      event: { message: {
        message_id: 'agent-new', chat_id: 'private', chat_type: 'p2p',
        sender: { sender_id: { open_id: 'actor' } }, message_type: 'text',
        content: JSON.stringify({ text: '创建 codex session' }),
      } },
    });

    assert.deepEqual(defaults, [
      { model: 'old-model', workdir: '/old-workdir', sandbox: 'read-only', skipGitRepoCheck: false },
      { model: 'new-model', workdir: '/new-workdir', sandbox: 'danger-full-access', skipGitRepoCheck: true },
    ]);
    assert.deepEqual(replies, ['agent handled', 'agent handled']);
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router intercepts natural language agent-session intent before default Codex chat', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-agent-router');
  const store = new Store(dbPath, () => 1000);
  const replies: string[] = [];
  const replyClient: ReplyClient = {
    async replyToMessage(): Promise<void> {
      throw new Error('digest reply should not run');
    },
    async replyError(): Promise<void> {
      throw new Error('error reply should not run');
    },
    async replyText(_messageId: string, text: string): Promise<void> {
      replies.push(text);
    },
  };
  const agentController: AgentSessionIntentControllerLike = {
    async handle(): Promise<{ text: string }> {
      return { text: 'pending confirmation' };
    },
  };
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('default AI should not run');
    },
  };
  const codexRunner = {
    async run(): Promise<{ sessionId: string | null }> {
      throw new Error('default Codex should not run');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    replyClient,
    undefined,
    undefined,
    null,
    null,
    null,
    codexRunner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat',
    null,
    { ids: [], names: [] },
    agentController
  );
  try {
    await router.handleEvent({
      schema: '2.0',
      header: { event_id: 'event-router-agent', event_type: 'im.message.receive_v1', create_time: '1783530000000' },
      event: {
        message: {
          message_id: 'router-agent-1',
          chat_id: 'oc_test',
          chat_type: 'p2p',
          sender: { sender_id: { open_id: 'ou_test' } },
          message_type: 'text',
          content: JSON.stringify({ text: '去 /repo 开个 codex session，叫 repo-main' }),
        },
      },
    });

    assert.deepEqual(replies, ['pending confirmation']);
    assert.equal(store.getProcessingJob('router-agent-1')?.mode, 'agent_session');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router accepts group confirmation without a second bot mention when pending action exists', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-agent-router-group-confirm');
  const store = new Store(dbPath, () => 2000);
  const replies: string[] = [];
  const replyClient: ReplyClient = {
    async replyToMessage(): Promise<void> {
      throw new Error('digest reply should not run');
    },
    async replyError(): Promise<void> {
      throw new Error('error reply should not run');
    },
    async replyText(_messageId: string, text: string): Promise<void> {
      replies.push(text);
    },
  };
  const created: CreateAgentSessionDraft[] = [];
  const runner: HeadlessAgentRunnerLike = {
    async create(draft: CreateAgentSessionDraft): Promise<AgentSessionRecord> {
      created.push(draft);
      return record({ alias: draft.alias, provider: draft.provider, cwd: draft.cwd });
    },
    async dispatch(): Promise<{ record: AgentSessionRecord; text: string }> {
      throw new Error('dispatch should not run');
    },
  };
  const controller = new AgentSessionIntentController(
    runner,
    new PendingAgentActionStore(path.join(dir, 'pending.json')),
    () => new Date('2099-07-31T00:00:00.000Z')
  );
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('default AI should not run');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    replyClient,
    undefined,
    undefined,
    null,
    null,
    null,
    null,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat',
    null,
    { ids: ['cli_bot'], names: ['豆姐'] },
    controller
  );
  try {
    await router.handleEvent({
      schema: '2.0',
      header: { event_id: 'event-group-draft', event_type: 'im.message.receive_v1', create_time: '1783530000000' },
      event: {
        message: {
          message_id: 'group-draft',
          chat_id: 'oc_group',
          chat_type: 'group',
          sender: { sender_id: { open_id: 'ou_test' } },
          message_type: 'text',
          content: JSON.stringify({ text: '@豆姐 去 /home/doujie/service/doujie 开个 codex session，叫 group-main，让它先熟悉项目' }),
          mentions: [{ key: '@豆姐', name: '豆姐', id: { app_id: 'cli_bot' } }],
        },
      },
    });
    await router.handleEvent({
      schema: '2.0',
      header: { event_id: 'event-group-confirm', event_type: 'im.message.receive_v1', create_time: '1783530000000' },
      event: {
        message: {
          message_id: 'group-confirm',
          chat_id: 'oc_group',
          chat_type: 'group',
          sender: { sender_id: { open_id: 'ou_test' } },
          message_type: 'text',
          content: JSON.stringify({ text: '确认' }),
        },
      },
    });

    assert.equal(created.length, 1);
    assert.equal(created[0]?.alias, 'group-main');
    assert.match(replies[0] ?? '', /请确认是否创建新的 Agent session/);
    assert.match(replies[1] ?? '', /已创建并登记 Agent session/);
    assert.equal(store.getProcessingJob('group-confirm')?.mode, 'agent_session');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});
