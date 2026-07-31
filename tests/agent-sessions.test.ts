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
  type CreateAgentSessionDraft,
  type HeadlessAgentRunnerLike,
} from '../src/headless-agent-runner.js';
import { createCommandRegistry } from '../src/commands/index.js';
import { Router, type AgentSessionIntentControllerLike, type ReplyClient } from '../src/router.js';
import { Store } from '../src/store.js';
import type { AIResult, MessageContent } from '../src/types.js';
import { createTempDbPath, removeTempDir } from './helpers.js';

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
  const runner: HeadlessAgentRunnerLike = {
    async create(draft: CreateAgentSessionDraft): Promise<AgentSessionRecord> {
      created.push(draft);
      return record({ alias: draft.alias, provider: draft.provider, cwd: draft.cwd });
    },
    async dispatch(): Promise<{ record: AgentSessionRecord; text: string }> {
      throw new Error('dispatch should not run');
    },
  };
  const controller = new AgentSessionIntentController(runner, pending, () => new Date('2099-07-31T00:00:00.000Z'));
  try {
    const draftReply = await controller.handle(message('去 /home/doujie/service/doujie 开个 codex session，叫 doujie-main，让它先熟悉项目'));
    assert.match(draftReply?.text ?? '', /请确认是否创建新的 Agent session/);
    assert.match(draftReply?.text ?? '', /Alias:\*\* `doujie-main`/);

    const confirmReply = await controller.handle(message('确认', 'msg-2'));
    assert.equal(created.length, 1);
    assert.equal(created[0]?.provider, 'codex');
    assert.equal(created[0]?.createdBy.senderId, 'ou_test');
    assert.match(confirmReply?.text ?? '', /已创建并登记 Agent session/);
    assert.equal(pending.get('oc_test', 'ou_test'), null);
  } finally {
    removeTempDir(dir);
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
