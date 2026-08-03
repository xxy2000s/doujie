import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createCommandRegistry } from '../src/commands/index.js';
import type { AttachmentDownloader, AttachmentMeta, AttachmentDownloadResult } from '../src/attachments.js';
import type { AttachmentExtractor } from '../src/attachment-extractor.js';
import type { AnswerResult } from '../src/ai/answer-processor.js';
import { CodexChatInterruptedError, type CodexChatOptions, type CodexChatResult } from '../src/ai/codex-chat.js';
import type { FetchedUrl } from '../src/fetcher.js';
import { Router, type CodexChatRunnerLike, type ReactionClient, type ReplyClient, type UrlFetcher } from '../src/router.js';
import { Store } from '../src/store.js';
import type { AIResult, FeishuEvent, PrivacyConfig } from '../src/types.js';
import type { ReactionEmoji } from '../src/reaction.js';
import type { StatusCardParams } from '../src/reply.js';
import { aiResult, createTempDbPath, removeTempDir, textEvent } from './helpers.js';
import { buildConfig } from '../src/config.js';
import { RuntimeConfigManager } from '../src/runtime-config.js';
import type { QuotedMessageProvider } from '../src/quoted-message.js';

type FakeReply = {
  summaries: Array<{ messageId: string; result: AIResult }>;
  errors: string[];
  texts: Array<{ messageId: string; text: string }>;
  statusCards: Array<{ messageId: string; params: StatusCardParams }>;
  statusUpdates: Array<{ messageId: string; params: StatusCardParams }>;
  client: ReplyClient;
};

function createFakeReply(): FakeReply {
  const fake: FakeReply = {
    summaries: [],
    errors: [],
    texts: [],
    statusCards: [],
    statusUpdates: [],
    client: {
      async replyToMessage(messageId: string, result: AIResult): Promise<void> {
        fake.summaries.push({ messageId, result });
      },
      async replyError(messageId: string): Promise<void> {
        fake.errors.push(messageId);
      },
      async replyText(messageId: string, text: string): Promise<void> {
        fake.texts.push({ messageId, text });
      },
    },
  };
  return fake;
}

function createFakeReplyWithStatusCards(): FakeReply {
  const fake = createFakeReply();
  fake.client.replyStatusCard = async (messageId: string, params: StatusCardParams): Promise<string | null> => {
    fake.statusCards.push({ messageId, params });
    return `card-${messageId}`;
  };
  fake.client.updateStatusCard = async (messageId: string, params: StatusCardParams): Promise<void> => {
    fake.statusUpdates.push({ messageId, params });
  };
  return fake;
}

function withoutStatusCards(client: ReplyClient): ReplyClient {
  return {
    replyToMessage: client.replyToMessage,
    replyError: client.replyError,
    replyText: client.replyText,
  };
}

type FakeReaction = {
  reactions: Array<{ messageId: string; emojiType: ReactionEmoji }>;
  client: ReactionClient;
};

function createFakeReaction(): FakeReaction {
  const fake: FakeReaction = {
    reactions: [],
    client: {
      async addReaction(messageId: string, emojiType: ReactionEmoji): Promise<void> {
        fake.reactions.push({ messageId, emojiType });
      },
    },
  };
  return fake;
}

function createFakeUrlFetcher(content: string): UrlFetcher {
  return {
    extractUrls(text: string): string[] {
      return text.includes('https://example.com/a') ? ['https://example.com/a'] : [];
    },
    async fetchAllUrls(_urls: string[]): Promise<string> {
      return content;
    },
  };
}

function createStructuredUrlFetcher(details: FetchedUrl[]): UrlFetcher {
  return {
    extractUrls(text: string): string[] {
      return text.includes('https://example.com') ? details.map((detail) => detail.canonicalUrl) : [];
    },
    async fetchAllUrls(_urls: string[]): Promise<string> {
      throw new Error('structured fetch should be used');
    },
    async fetchAllUrlDetails(_urls: string[]): Promise<FetchedUrl[]> {
      return details;
    },
  };
}

function resourceEvent(params: {
  messageId: string;
  messageType: 'image' | 'file';
  content: Record<string, unknown>;
}): FeishuEvent {
  return {
    schema: '2.0',
    header: {
      event_id: `event-${params.messageId}`,
      event_type: 'im.message.receive_v1',
      create_time: '1783530000000',
    },
    event: {
      message: {
        message_id: params.messageId,
        chat_id: 'oc_test',
        chat_type: 'p2p',
        sender: { sender_id: { open_id: 'ou_test' } },
        message_type: params.messageType,
        content: JSON.stringify(params.content),
      },
    },
  };
}

function editedTextEvent(params: {
  messageId: string;
  text: string;
  chatId?: string;
  chatType?: string;
  senderId?: string;
  updateTime?: string;
  mentions?: FeishuEvent['event']['message']['mentions'];
  parentId?: string;
  replyTo?: string;
  rootId?: string;
}): FeishuEvent {
  const sender = { sender_id: { open_id: params.senderId ?? 'ou_test' } };
  return {
    schema: '2.0',
    header: {
      event_id: `event-${params.messageId}-${params.updateTime ?? 'edit'}`,
      event_type: 'im.message.message_updated_v1',
      create_time: '1783530000000',
    },
    event: {
      sender,
      message: {
        message_id: params.messageId,
        chat_id: params.chatId ?? 'oc_test',
        chat_type: params.chatType ?? 'p2p',
        sender,
        message_type: 'text',
        content: JSON.stringify({ text: params.text }),
        update_time: params.updateTime,
        updated: true,
        ...(params.mentions ? { mentions: params.mentions } : {}),
        ...(params.parentId ? { parent_id: params.parentId } : {}),
        ...(params.replyTo ? { reply_to: params.replyTo } : {}),
        ...(params.rootId ? { root_id: params.rootId } : {}),
      },
    },
  };
}

function createAttachmentDownloader(
  result: (attachment: AttachmentMeta) => AttachmentDownloadResult
): AttachmentDownloader {
  return {
    async download(_messageId: string, attachment: AttachmentMeta): Promise<AttachmentDownloadResult> {
      return result(attachment);
    },
  };
}

function createAttachmentExtractor(text: string): AttachmentExtractor {
  return {
    async extract(): Promise<{ status: 'extracted'; text: string }> {
      return { status: 'extracted', text };
    },
  };
}

type FakeAnswerPipeline = {
  prompts: string[];
  pipeline: { answer(text: string): Promise<AnswerResult> };
};

function createFakeAnswerPipeline(result: AnswerResult): FakeAnswerPipeline {
  const fake: FakeAnswerPipeline = {
    prompts: [],
    pipeline: {
      async answer(text: string): Promise<AnswerResult> {
        fake.prompts.push(text);
        return result;
      },
    },
  };
  return fake;
}

type FakeCodexChatRunner = {
  prompts: string[];
  options: CodexChatOptions[];
  runner: CodexChatRunnerLike;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeCodexChatRunner(chunks: string[]): FakeCodexChatRunner {
  const fake: FakeCodexChatRunner = {
    prompts: [],
    options: [],
    runner: {
      async run(
        prompt: string,
        options: CodexChatOptions,
        onChunk: (text: string) => Promise<void>
      ): Promise<CodexChatResult> {
        fake.prompts.push(prompt);
        fake.options.push(options);
        for (const chunk of chunks) {
          await onChunk(chunk);
        }
        return { sessionId: 'session-1' };
      },
    },
  };
  return fake;
}

type InterruptibleCodexChatRunner = FakeCodexChatRunner & {
  firstStarted: Promise<void>;
  abortedPrompts: string[];
};

function createInterruptibleCodexChatRunner(): InterruptibleCodexChatRunner {
  const firstStarted = createDeferred<void>();
  const fake: InterruptibleCodexChatRunner = {
    prompts: [],
    options: [],
    firstStarted: firstStarted.promise,
    abortedPrompts: [],
    runner: {
      async run(
        prompt: string,
        options: CodexChatOptions,
        onChunk: (text: string) => Promise<void>
      ): Promise<CodexChatResult> {
        fake.prompts.push(prompt);
        fake.options.push(options);
        if (prompt === 'first task') {
          await onChunk('partial reply for first task');
          firstStarted.resolve();
          return new Promise<CodexChatResult>((_resolve, reject) => {
            const abort = (): void => {
              fake.abortedPrompts.push(prompt);
              reject(new CodexChatInterruptedError());
            };
            if (options.abortSignal?.aborted) {
              abort();
              return;
            }
            options.abortSignal?.addEventListener('abort', abort, { once: true });
          });
        }
        await onChunk(`reply for ${prompt}`);
        return { sessionId: `session-${prompt}` };
      },
    },
  };
  return fake;
}

test('Router dispatches commands through injected reply client', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-command');
  const store = new Store(dbPath, () => 1000);
  const reply = createFakeReply();
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('AI should not run for commands');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    withoutStatusCards(reply.client),
    createFakeUrlFetcher('')
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'cmd-1', text: '/help' }));

    assert.equal(reply.texts.length, 1);
    assert.equal(reply.texts[0]?.messageId, 'cmd-1');
    assert.match(reply.texts[0]?.text ?? '', /豆姐命令/);
    assert.equal(reply.summaries.length, 0);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router blocks admin commands for an allowed non-admin group member', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-admin-gate');
  const store = new Store(dbPath, () => 1001);
  const reply = createFakeReply();
  const privacy: PrivacyConfig = {
    allowChatIds: [], denyChatIds: [], allowUserIds: [], denyUserIds: [], skipPatterns: [], redactPatterns: [],
    adminUserIds: ['ou_admin'], privateAllowUserIds: ['ou_admin'],
    groups: [{ chatId: 'oc_team', allowUserIds: ['ou_member'], allowAgentUserIds: [], contextEnabled: true, contextMaxMessages: 20, contextMaxChars: 10000 }],
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), privacy,
    null, null, null, undefined, undefined, undefined, null, { ids: [], names: ['豆姐'] }, null
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'admin-gate-1', chatId: 'oc_team', chatType: 'group', senderId: 'ou_member',
      text: '@豆姐 /new', mentions: [{ name: '豆姐', key: '@豆姐' }],
    }));
    assert.deepEqual(reply.texts.map((item) => item.text), ['/new 仅管理员可用。']);
    assert.equal(store.getProcessingJob('admin-gate-1')?.stage, 'privacy_skip');
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router fetches explicit group context and runs the summary in read-only mode', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-group-context');
  const store = new Store(dbPath, () => 1002);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['summary']);
  const privacy: PrivacyConfig = {
    allowChatIds: [], denyChatIds: [], allowUserIds: [], denyUserIds: [], skipPatterns: [], redactPatterns: [],
    adminUserIds: ['ou_admin'], privateAllowUserIds: ['ou_admin'],
    groups: [{ chatId: 'oc_team', allowUserIds: ['ou_member'], allowAgentUserIds: [], contextEnabled: true, contextMaxMessages: 20, contextMaxChars: 10000 }],
  };
  let fetched = false;
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), privacy,
    null, null, null, codex.runner,
    { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
    'codex_chat', null, { ids: [], names: ['豆姐'] }, null,
    { async fetch() { fetched = true; return [{ messageId: 'history-1', senderName: 'A', senderType: 'user', createdAt: '10:00', text: 'use sqlite' }]; } }
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'context-1', chatId: 'oc_team', chatType: 'group', senderId: 'ou_member',
      text: '@豆姐 总结最近 20 条聊天', mentions: [{ name: '豆姐', key: '@豆姐' }],
    }));
    assert.equal(fetched, true);
    assert.match(codex.prompts[0] ?? '', /use sqlite/);
    assert.equal(codex.options[0]?.sandbox, 'read-only');
    assert.equal(codex.options[0]?.sessionKey, 'context:oc_team:context-1');
    assert.deepEqual(reply.texts.map((item) => item.text), ['summary']);
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router streams Codex chunks while updating one status card when supported', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-codex-status-card');
  const store = new Store(dbPath, () => 1110);
  const reply = createFakeReplyWithStatusCards();
  const reaction = createFakeReaction();
  const codex = createFakeCodexChatRunner(['chunk one', 'chunk two']);
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('AI digest should not run for /codex');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    {
      model: 'test-model',
      workdir: dir,
      sandbox: 'workspace-write',
      skipGitRepoCheck: true,
    },
    undefined,
    reaction.client
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'codex-card-1',
      text: '/codex hello',
      senderId: 'ou_event_root',
      senderAtEventRoot: true,
    }));

    assert.deepEqual(reply.texts, []);
    assert.equal(reply.statusCards.length, 1);
    assert.equal(reply.statusCards[0]?.messageId, 'codex-card-1');
    assert.equal(reply.statusCards[0]?.params.state, 'thinking');
    assert.ok(reply.statusUpdates.length >= 2);
    assert.equal(reply.statusUpdates.every((item) => item.messageId === 'card-codex-card-1'), true);
    const finalUpdate = reply.statusUpdates.at(-1);
    assert.equal(finalUpdate?.params.state, 'done');
    assert.equal(finalUpdate?.params.stage, '结果已完整写入');
    assert.equal(finalUpdate?.params.output, 'chunk one\n\nchunk two');
    assert.deepEqual(reaction.reactions, [
      { messageId: 'codex-card-1', emojiType: 'THINKING' },
      { messageId: 'codex-card-1', emojiType: 'DONE' },
    ]);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router streams Codex chunks as Post Markdown when post transport is selected', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-codex-post-transport');
  const store = new Store(dbPath, () => 1110);
  const reply = createFakeReplyWithStatusCards();
  const reaction = createFakeReaction();
  const codex = createFakeCodexChatRunner(['## First\n\n- item', '**Second**']);
  const config = buildConfig({ output: { transport: 'post' } }, {});
  const manager = new RuntimeConfigManager(config, () => config);
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    config.privacy,
    null,
    null,
    null,
    codex.runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat',
    reaction.client,
    { ids: [], names: [] },
    null,
    null,
    manager
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'post-transport-1', text: '/detail markdown' }));

    assert.deepEqual(reply.texts.map((item) => item.text), ['## First\n\n- item', '**Second**']);
    assert.equal(reply.statusCards.length, 1);
    assert.match(reply.statusCards[0]?.params.detail ?? '', /Markdown 消息/);
    assert.equal(reply.statusUpdates.at(-1)?.params.state, 'done');
    assert.equal(reply.statusUpdates.at(-1)?.params.stage, '结果已通过 Markdown 发送');
    assert.equal(reply.statusUpdates.at(-1)?.params.output, undefined);
    assert.equal(codex.options[0]?.outputMode, 'detail');
    assert.deepEqual(reaction.reactions, [
      { messageId: 'post-transport-1', emojiType: 'THINKING' },
      { messageId: 'post-transport-1', emojiType: 'DONE' },
    ]);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router coalesces token-level continuation chunks in Post transport', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-codex-post-deltas');
  const store = new Store(dbPath, () => 1110);
  const reply = createFakeReplyWithStatusCards();
  const config = buildConfig({ output: { transport: 'post' } }, {});
  const manager = new RuntimeConfigManager(config, () => config);
  const runner: CodexChatRunnerLike = {
    async run(_prompt, _options, onChunk): Promise<CodexChatResult> {
      await onChunk('Hel', { continuation: false });
      await onChunk('lo', { continuation: true });
      await onChunk(' world', { continuation: true });
      await onChunk('Second block', { continuation: false });
      return { sessionId: 'post-delta-session' };
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    config.privacy,
    null,
    null,
    null,
    runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat',
    null,
    { ids: [], names: [] },
    null,
    null,
    manager
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'post-deltas-1', text: '/detail stream' }));
    assert.deepEqual(reply.texts.map((item) => item.text), ['Hello world', 'Second block']);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router retains buffered Post output when its first delivery attempt fails', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-codex-post-send-retry');
  const store = new Store(dbPath, () => 1110);
  const reply = createFakeReply();
  let attempts = 0;
  reply.client.replyText = async (messageId: string, text: string): Promise<void> => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary Post failure');
    reply.texts.push({ messageId, text });
  };
  const config = buildConfig({ output: { transport: 'post' } }, {});
  const manager = new RuntimeConfigManager(config, () => config);
  const runner: CodexChatRunnerLike = {
    async run(_prompt, _options, onChunk): Promise<CodexChatResult> {
      await onChunk('preserved first block', { continuation: false });
      await onChunk('second block', { continuation: false });
      return { sessionId: 'post-send-retry-session' };
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    config.privacy,
    null,
    null,
    null,
    runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat',
    null,
    { ids: [], names: [] },
    null,
    null,
    manager
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'post-send-retry-1', text: '/detail stream' }));
    assert.equal(reply.texts.some((item) => item.text === 'preserved first block'), true);
    assert.deepEqual(reply.errors, ['post-send-retry-1']);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router hot-switches output transport for subsequent turns only', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-output-command');
  const store = new Store(dbPath, () => 1110);
  const reply = createFakeReplyWithStatusCards();
  const codex = createFakeCodexChatRunner(['answer']);
  const config = buildConfig({ privacy: { admin_user_ids: ['ou_admin'] } }, {});
  const manager = new RuntimeConfigManager(config, () => config);
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    config.privacy,
    null,
    null,
    null,
    codex.runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat',
    null,
    { ids: [], names: [] },
    null,
    null,
    manager
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'output-post', text: '/output post', senderId: 'ou_admin' }));
    await router.handleEvent(textEvent({ messageId: 'output-post-turn', text: '/codex first', senderId: 'ou_admin' }));
    await router.handleEvent(textEvent({ messageId: 'output-status', text: '/output status', senderId: 'ou_admin' }));
    await router.handleEvent(textEvent({ messageId: 'output-card', text: '/output card', senderId: 'ou_admin' }));
    await router.handleEvent(textEvent({ messageId: 'output-card-turn', text: '/codex second', senderId: 'ou_admin' }));

    assert.equal(manager.getSnapshot().config.output.transport, 'card');
    assert.equal(reply.texts.some((item) => item.messageId === 'output-post-turn' && item.text === 'answer'), true);
    assert.equal(reply.texts.some((item) => item.messageId === 'output-status' && /Post Markdown/.test(item.text)), true);
    assert.equal(reply.statusCards.some((item) => item.messageId === 'output-post-turn'), true);
    assert.equal(reply.statusCards.some((item) => item.messageId === 'output-card-turn'), true);
    assert.equal(reply.statusUpdates.findLast((item) => item.messageId === 'card-output-post-turn')?.params.output, undefined);
    assert.equal(reply.statusUpdates.findLast((item) => item.messageId === 'card-output-card-turn')?.params.output, 'answer');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router keeps an in-flight turn on its captured output transport', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-output-snapshot');
  const store = new Store(dbPath, () => 1110);
  const reply = createFakeReplyWithStatusCards();
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  const config = buildConfig({}, {});
  const manager = new RuntimeConfigManager(config, () => config);
  const runner: CodexChatRunnerLike = {
    async run(_prompt, _options, onChunk): Promise<CodexChatResult> {
      started.resolve();
      await release.promise;
      await onChunk('captured card output');
      return { sessionId: 'captured-card-session' };
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    config.privacy,
    null,
    null,
    null,
    runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat',
    null,
    { ids: [], names: [] },
    null,
    null,
    manager
  );
  try {
    const turn = router.handleEvent(textEvent({ messageId: 'output-snapshot-turn', text: '/codex wait' }));
    await started.promise;
    manager.setOutputTransport('post');
    release.resolve();
    await turn;

    assert.equal(reply.statusCards.length, 1);
    assert.equal(reply.statusUpdates.at(-1)?.params.output, 'captured card output');
    assert.deepEqual(reply.texts, []);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router restricts output transport switching to administrators', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-output-command-auth');
  const store = new Store(dbPath, () => 1110);
  const reply = createFakeReply();
  const config = buildConfig({ privacy: { admin_user_ids: ['ou_admin'] } }, {});
  const manager = new RuntimeConfigManager(config, () => config);
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    config.privacy,
    null,
    null,
    null,
    undefined,
    undefined,
    undefined,
    null,
    { ids: [], names: [] },
    null,
    null,
    manager
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'output-denied', text: '/output post', senderId: 'ou_member' }));
    assert.equal(manager.getSnapshot().config.output.transport, 'card');
    assert.equal(reply.texts[0]?.text, '/output 仅管理员可用。');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router labels card overflow and delivers the complete long result explicitly', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-card-overflow');
  const store = new Store(dbPath, () => 1111);
  const reply = createFakeReplyWithStatusCards();
  const longOutput = `## Result\n\n${'中'.repeat(6500)}`;
  const codex = createFakeCodexChatRunner([longOutput]);
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true }
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'overflow-1', text: '/codex long' }));

    const finalUpdate = reply.statusUpdates.at(-1)?.params;
    assert.equal(finalUpdate?.state, 'done');
    assert.equal(finalUpdate?.outputTruncated, true);
    assert.match(finalUpdate?.stage ?? '', /完整结果见后续消息/);
    assert.deepEqual(reply.texts.map((item) => item.text), [longOutput]);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router repairs fenced Markdown that crosses the retained card tail', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-card-markdown-fence');
  const store = new Store(dbPath, () => 1111);
  const reply = createFakeReplyWithStatusCards();
  const codeLines = Array.from({ length: 900 }, (_, index) => `const value${index} = ${index};`).join('\n');
  const longOutput = `## Result\n\n\`\`\`ts\n${codeLines}\n\`\`\`\n\nFinal paragraph.`;
  const codex = createFakeCodexChatRunner([longOutput]);
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true }
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'markdown-fence-1', text: '/codex long markdown' }));
    const finalOutput = reply.statusUpdates.at(-1)?.params.output ?? '';
    const fences = [...finalOutput.matchAll(/(?:^|\n)[ \t]{0,3}`{3,}(?=[^`]|$)/g)];
    assert.equal(finalOutput.startsWith('```text\n'), true);
    assert.equal(fences.length % 2, 0);
    assert.match(finalOutput, /Final paragraph\.$/);
    assert.deepEqual(reply.texts.map((item) => item.text), [longOutput]);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router concatenates continuation chunks without changing Codex text', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-card-continuation');
  const store = new Store(dbPath, () => 1111);
  const reply = createFakeReplyWithStatusCards();
  const runner: CodexChatRunnerLike = {
    async run(_prompt, _options, onChunk): Promise<CodexChatResult> {
      await onChunk('alpha', { continuation: false });
      await onChunk('beta', { continuation: true });
      await onChunk('gamma', { continuation: false });
      return { sessionId: 'continuation-session' };
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true }
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'continuation-1', text: '/codex continue' }));
    assert.equal(reply.statusUpdates.at(-1)?.params.output, 'alphabeta\n\ngamma');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router retries a failed card patch and falls back to one complete reply', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-card-patch-fallback');
  const store = new Store(dbPath, () => 1112);
  const reply = createFakeReplyWithStatusCards();
  reply.client.updateStatusCard = async (): Promise<void> => {
    throw new Error('patch unavailable');
  };
  const codex = createFakeCodexChatRunner(['first', 'second']);
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true }
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'patch-fallback-1', text: '/codex fallback' }));
    assert.deepEqual(reply.texts.map((item) => item.text), ['first\n\nsecond']);
    assert.equal(store.getProcessingJob('patch-fallback-1')?.status, 'replied');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router reports no output when card patching is unavailable', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-card-no-output-fallback');
  const store = new Store(dbPath, () => 1113);
  const reply = createFakeReplyWithStatusCards();
  reply.client.updateStatusCard = async (): Promise<void> => {
    throw new Error('patch unavailable');
  };
  const codex = createFakeCodexChatRunner([]);
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true }
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'no-output-fallback-1', text: '/codex empty' }));
    assert.deepEqual(reply.texts.map((item) => item.text), ['Codex 没有返回可显示内容。']);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router preserves partial output when the terminal interruption card patch fails', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-interrupt-card-fallback');
  const store = new Store(dbPath, () => 1114);
  const reply = createFakeReplyWithStatusCards();
  reply.client.updateStatusCard = async (): Promise<void> => { throw new Error('patch unavailable'); };
  const codex = createInterruptibleCodexChatRunner();
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat',
    null,
    { ids: ['cli_bot'], names: ['Doujie'] }
  );
  const send = (messageId: string, prompt: string): Promise<void> => router.handleEvent(textEvent({
    messageId,
    text: `@Doujie ${prompt}`,
    chatId: 'oc_group',
    chatType: 'group',
    mentions: [{ key: '@Doujie', name: 'Doujie', id: { app_id: 'cli_bot' } }],
  }));
  try {
    const first = send('interrupt-card-fallback-1', 'first task');
    await codex.firstStarted;
    await send('interrupt-card-fallback-2', 'replacement');
    await first;
    const fallback = reply.texts.find((item) => item.messageId === 'interrupt-card-fallback-1')?.text ?? '';
    assert.match(fallback, /任务已被新消息打断/);
    assert.match(fallback, /partial reply for first task/);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router preserves partial output when interrupted after status-card creation fails', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-interrupt-no-card-fallback');
  const store = new Store(dbPath, () => 1114);
  const reply = createFakeReply();
  const codex = createInterruptibleCodexChatRunner();
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat'
  );
  try {
    const first = router.handleEvent(textEvent({ messageId: 'interrupt-no-card-1', text: 'first task' }));
    await codex.firstStarted;
    await router.handleEvent(textEvent({ messageId: 'interrupt-no-card-2', text: 'replacement' }));
    await first;

    const fallback = reply.texts.find((item) => item.messageId === 'interrupt-no-card-1')?.text ?? '';
    assert.match(fallback, /partial reply for first task/);
    assert.match(fallback, /已被新消息打断/);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router sends the standard error reply when the terminal error card patch fails', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-error-card-fallback');
  const store = new Store(dbPath, () => 1115);
  const reply = createFakeReplyWithStatusCards();
  reply.client.updateStatusCard = async (): Promise<void> => { throw new Error('patch unavailable'); };
  const runner: CodexChatRunnerLike = {
    async run(): Promise<CodexChatResult> { throw new Error('codex failed'); },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true }
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'error-card-fallback-1', text: '/codex fail' }));
    assert.deepEqual(reply.errors, ['error-card-fallback-1']);
    assert.equal(store.getProcessingJob('error-card-fallback-1')?.status, 'failed');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router preserves partial Codex output when the run fails', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-error-card-partial-output');
  const store = new Store(dbPath, () => 1116);
  const reply = createFakeReplyWithStatusCards();
  const runner: CodexChatRunnerLike = {
    async run(_prompt, _options, onChunk): Promise<CodexChatResult> {
      await onChunk('partial result');
      throw new Error('codex failed after output');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true }
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'error-card-partial-1', text: '/codex fail later' }));
    const finalUpdate = reply.statusUpdates.at(-1)?.params;
    assert.equal(finalUpdate?.state, 'error');
    assert.equal(finalUpdate?.output, 'partial result');
    assert.equal(finalUpdate?.detail, 'codex failed after output');
    assert.deepEqual(reply.texts, []);
    assert.equal(store.getProcessingJob('error-card-partial-1')?.status, 'failed');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router preserves partial output when status-card creation fails before the run fails', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-error-no-card-partial-output');
  const store = new Store(dbPath, () => 1116);
  const reply = createFakeReply();
  const runner: CodexChatRunnerLike = {
    async run(_prompt, _options, onChunk): Promise<CodexChatResult> {
      await onChunk('useful partial result');
      throw new Error('codex failed after output');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true }
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'error-no-card-partial-1', text: '/codex fail later' }));
    assert.deepEqual(reply.texts.map((item) => item.text), ['useful partial result']);
    assert.deepEqual(reply.errors, ['error-no-card-partial-1']);
    assert.equal(store.getProcessingJob('error-no-card-partial-1')?.status, 'failed');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router falls back with partial Codex output when the terminal error card patch fails', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-error-card-partial-fallback');
  const store = new Store(dbPath, () => 1117);
  const reply = createFakeReplyWithStatusCards();
  reply.client.updateStatusCard = async (): Promise<void> => { throw new Error('patch unavailable'); };
  const runner: CodexChatRunnerLike = {
    async run(_prompt, _options, onChunk): Promise<CodexChatResult> {
      await onChunk('recoverable partial result');
      throw new Error('codex failed after output');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true }
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'error-card-partial-fallback-1', text: '/codex fail later' }));
    assert.equal(reply.errors.length, 0);
    assert.match(reply.texts[0]?.text ?? '', /Agent 执行失败：codex failed after output/);
    assert.match(reply.texts[0]?.text ?? '', /recoverable partial result/);
    assert.equal(store.getProcessingJob('error-card-partial-fallback-1')?.status, 'failed');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router handles /codex as a streaming Codex chat command', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-codex');
  const store = new Store(dbPath, () => 1100);
  const reply = createFakeReply();
  const reaction = createFakeReaction();
  const codex = createFakeCodexChatRunner(['chunk one', 'chunk two']);
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('AI digest should not run for /codex');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    {
      model: 'test-model',
      workdir: dir,
      sandbox: 'workspace-write',
      skipGitRepoCheck: true,
    },
    undefined,
    reaction.client
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'codex-1',
      text: '/codex hello',
      senderId: 'ou_event_root',
      senderAtEventRoot: true,
    }));

    assert.deepEqual(codex.prompts, ['hello']);
    assert.equal(codex.options[0]?.sessionKey, 'oc_test:ou_event_root');
    assert.equal(codex.options[0]?.outputMode, 'answer');
    assert.deepEqual(reply.texts.map((item) => item.text), ['chunk one\n\nchunk two']);
    assert.deepEqual(reaction.reactions, [
      { messageId: 'codex-1', emojiType: 'THINKING' },
      { messageId: 'codex-1', emojiType: 'DONE' },
    ]);
    const job = store.getProcessingJob('codex-1');
    assert.equal(job?.status, 'replied');
    assert.equal(job?.mode, 'codex_chat');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router interrupts an active Codex chat when a newer message uses the same session', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-codex-interrupt');
  const store = new Store(dbPath, () => 1130);
  const reply = createFakeReplyWithStatusCards();
  const reaction = createFakeReaction();
  const codex = createInterruptibleCodexChatRunner();
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('AI digest should not run for mentioned group Codex messages');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    {
      model: 'test-model',
      workdir: dir,
      sandbox: 'workspace-write',
      skipGitRepoCheck: true,
    },
    'codex_chat',
    reaction.client,
    { ids: ['cli_bot'], names: ['Doujie'] }
  );
  try {
    const first = router.handleEvent(textEvent({
      messageId: 'interrupt-1',
      text: '@Doujie first task',
      chatId: 'oc_group',
      chatType: 'group',
      mentions: [{ key: '@Doujie', name: 'Doujie', id: { app_id: 'cli_bot' } }],
    }));
    await codex.firstStarted;

    await router.handleEvent(textEvent({
      messageId: 'interrupt-2',
      text: '@Doujie second task',
      chatId: 'oc_group',
      chatType: 'group',
      mentions: [{ key: '@Doujie', name: 'Doujie', id: { app_id: 'cli_bot' } }],
    }));
    await first;

    assert.deepEqual(codex.prompts, ['first task', 'second task']);
    assert.deepEqual(codex.abortedPrompts, ['first task']);
    assert.equal(codex.options[0]?.abortSignal?.aborted, true);
    assert.equal(codex.options[1]?.abortSignal?.aborted, false);
    assert.deepEqual(reply.texts, []);
    const interruptedUpdate = reply.statusUpdates.findLast((item) => item.messageId === 'card-interrupt-1');
    assert.equal(interruptedUpdate?.params.stage, '被新消息打断');
    assert.equal(interruptedUpdate?.params.output, 'partial reply for first task');
    assert.equal(reply.statusUpdates.findLast((item) => item.messageId === 'card-interrupt-2')?.params.stage, '结果已完整写入');
    assert.deepEqual(reaction.reactions, [
      { messageId: 'interrupt-1', emojiType: 'THINKING' },
      { messageId: 'interrupt-2', emojiType: 'THINKING' },
      { messageId: 'interrupt-1', emojiType: 'ERROR' },
      { messageId: 'interrupt-2', emojiType: 'DONE' },
    ]);
    assert.equal(store.getProcessingJob('interrupt-1')?.status, 'replied');
    assert.equal(store.getProcessingJob('interrupt-2')?.status, 'replied');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router ignores an unchanged polled edit while the original mentioned message is running', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-reaction-edit-dedup');
  const store = new Store(dbPath, () => 1135);
  const reply = createFakeReplyWithStatusCards();
  const reaction = createFakeReaction();
  const started = createDeferred<void>();
  const finished = createDeferred<CodexChatResult>();
  const prompts: string[] = [];
  const signals: AbortSignal[] = [];
  const runner: CodexChatRunnerLike = {
    async run(
      prompt: string,
      options: CodexChatOptions,
      onChunk: (text: string) => Promise<void>
    ): Promise<CodexChatResult> {
      prompts.push(prompt);
      if (options.abortSignal) signals.push(options.abortSignal);
      started.resolve();
      const result = await finished.promise;
      await onChunk('original reply');
      return result;
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat',
    reaction.client,
    { ids: ['cli_bot'], names: ['Doujie'] }
  );
  const original = textEvent({
    messageId: 'reaction-edit-1',
    text: '@Doujie inspect paragraph',
    chatId: 'oc_group',
    chatType: 'group',
    mentions: [{ key: '@Doujie', name: 'Doujie', id: { app_id: 'cli_bot' } }],
  });
  const polledAfterReaction = editedTextEvent({
    messageId: 'reaction-edit-1',
    text: '@Doujie inspect paragraph',
    chatId: 'oc_group',
    chatType: 'group',
    mentions: [{ key: '@Doujie', name: 'Doujie', id: { app_id: 'cli_bot' } }],
  });

  try {
    const originalRun = router.handleEvent(original);
    await started.promise;
    await router.handleEvent(polledAfterReaction);

    assert.deepEqual(prompts, ['inspect paragraph']);
    assert.equal(signals[0]?.aborted, false);
    assert.equal(reply.texts.some((item) => item.text.includes('已被新消息打断')), false);

    finished.resolve({ sessionId: 'session-original' });
    await originalRun;
    assert.deepEqual(reply.texts, []);
    assert.equal(reply.statusUpdates.at(-1)?.params.output, 'original reply');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('A hash-different historical edit cannot interrupt a newer active turn', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-stale-edit-preemption');
  const store = new Store(dbPath, () => 1135);
  const reply = createFakeReplyWithStatusCards();
  const reaction = createFakeReaction();
  const codex = createInterruptibleCodexChatRunner();
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat',
    reaction.client,
    { ids: ['cli_bot'], names: ['Doujie'] }
  );

  const current = router.handleEvent(textEvent({
    messageId: 'current-turn',
    text: '@Doujie first task',
    chatId: 'oc_group',
    chatType: 'group',
    mentions: [{ key: '@Doujie', name: 'Doujie', id: { app_id: 'cli_bot' } }],
  }));
  await codex.firstStarted;

  try {
    await router.handleEvent(editedTextEvent({
      messageId: 'historical-message',
      text: '@Doujie old text with ���',
      chatId: 'oc_group',
      chatType: 'group',
      updateTime: '1783529999000',
      mentions: [{ key: '@Doujie', name: 'Doujie', id: { app_id: 'cli_bot' } }],
    }));
    await router.handleEvent(editedTextEvent({
      messageId: 'historical-message-without-time',
      text: '@Doujie old edit without authoritative time',
      chatId: 'oc_group',
      chatType: 'group',
      mentions: [{ key: '@Doujie', name: 'Doujie', id: { app_id: 'cli_bot' } }],
    }));

    assert.deepEqual(codex.prompts, ['first task']);
    assert.deepEqual(codex.abortedPrompts, []);
    assert.equal(reply.texts.some((item) => item.text.includes('已被新消息打断')), false);
  } finally {
    await router.handleEvent(textEvent({
      messageId: 'cleanup-newer-turn',
      text: '@Doujie cleanup',
      chatId: 'oc_group',
      chatType: 'group',
      mentions: [{ key: '@Doujie', name: 'Doujie', id: { app_id: 'cli_bot' } }],
    }));
    await current;
    store.close();
    removeTempDir(dir);
  }
});

test('A historical /new edit cannot interrupt a newer turn or clear its session binding', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-stale-new-preemption');
  const store = new Store(dbPath, () => 1135);
  const reply = createFakeReplyWithStatusCards();
  const codex = createInterruptibleCodexChatRunner();
  const stateFile = path.join(dir, 'codex-sessions.json');
  fs.writeFileSync(stateFile, JSON.stringify({ sessions: { 'oc_test:ou_test': 'session-current' } }), 'utf-8');
  const privacy = buildConfig({ privacy: { admin_user_ids: ['ou_test'] } }, {}).privacy;
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    privacy,
    null,
    null,
    null,
    codex.runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true, stateFile },
    'codex_chat'
  );

  const current = router.handleEvent(textEvent({
    messageId: 'current-before-stale-new',
    text: 'first task',
    createTime: '1783530000000',
  }));
  await codex.firstStarted;

  try {
    await router.handleEvent(editedTextEvent({
      messageId: 'historical-new',
      text: '/new',
      updateTime: '1783529999000',
    }));

    assert.deepEqual(codex.abortedPrompts, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf-8')), {
      sessions: { 'oc_test:ou_test': 'session-current' },
    });
    assert.equal(reply.texts.some((item) => item.text.includes('已切换到新的 Codex session')), false);
  } finally {
    await router.handleEvent(textEvent({ messageId: 'cleanup-after-stale-new', text: 'cleanup' }));
    await current;
    store.close();
    removeTempDir(dir);
  }
});

test('A historical /new edit cannot clear a newer session after its turn has completed', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-stale-new-after-completion');
  const store = new Store(dbPath, () => 1135);
  const reply = createFakeReplyWithStatusCards();
  const stateFile = path.join(dir, 'codex-sessions.json');
  fs.writeFileSync(stateFile, JSON.stringify({ sessions: { 'oc_test:ou_test': 'session-current' } }), 'utf-8');
  const privacy = buildConfig({ privacy: { admin_user_ids: ['ou_test'] } }, {}).privacy;
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    privacy,
    null,
    null,
    null,
    createFakeCodexChatRunner(['done']).runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true, stateFile },
    'codex_chat'
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'completed-newer-turn',
      text: 'complete this',
      createTime: '1783530000000',
    }));
    await router.handleEvent(editedTextEvent({
      messageId: 'historical-new-after-completion',
      text: '/new',
      updateTime: '1783529999000',
    }));

    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf-8')), {
      sessions: { 'oc_test:ou_test': 'session-current' },
    });
    assert.equal(reply.texts.some((item) => item.text.includes('已切换到新的 Codex session')), false);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('A newer millisecond edit supersedes an active receive event with a microsecond timestamp', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-mixed-timestamp-units');
  const store = new Store(dbPath, () => 1135);
  const reply = createFakeReplyWithStatusCards();
  const codex = createInterruptibleCodexChatRunner();
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat'
  );

  const current = router.handleEvent(textEvent({
    messageId: 'microsecond-receive',
    text: 'first task',
    createTime: '1783530000000000',
  }));
  await codex.firstStarted;
  try {
    await router.handleEvent(editedTextEvent({
      messageId: 'millisecond-edit',
      text: 'newer edited task',
      updateTime: '1783530001000',
    }));
    await current;

    assert.deepEqual(codex.prompts, ['first task', 'newer edited task']);
    assert.deepEqual(codex.abortedPrompts, ['first task']);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router does not report interruption when a normal mention follows natural completion', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-natural-next-message');
  const store = new Store(dbPath, () => 1136);
  const reply = createFakeReplyWithStatusCards();
  const codex = createFakeCodexChatRunner(['normal reply']);
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat',
    null,
    { ids: ['cli_bot'], names: ['Doujie'] }
  );

  try {
    for (const [messageId, text] of [['natural-1', 'first complete'], ['natural-2', 'second normal']] as const) {
      await router.handleEvent(textEvent({
        messageId,
        text: `@Doujie ${text}`,
        chatId: 'oc_group',
        chatType: 'group',
        mentions: [{ key: '@Doujie', name: 'Doujie', id: { app_id: 'cli_bot' } }],
      }));
    }

    assert.deepEqual(codex.prompts, ['first complete', 'second normal']);
    assert.equal(reply.texts.some((item) => item.text.includes('已被新消息打断')), false);
    assert.equal(reply.statusUpdates.filter((item) => item.params.stage === '被新消息打断').length, 0);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('A late close from an interrupted turn cannot clear or overwrite the newer active turn', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-late-close-generation');
  const store = new Store(dbPath, () => 1137);
  const reply = createFakeReplyWithStatusCards();
  const firstStarted = createDeferred<void>();
  const secondStarted = createDeferred<void>();
  const releaseFirstClose = createDeferred<void>();
  const aborted: string[] = [];
  const runner: CodexChatRunnerLike = {
    async run(
      prompt: string,
      options: CodexChatOptions,
      onChunk: (text: string) => Promise<void>
    ): Promise<CodexChatResult> {
      if (prompt === 'first') {
        firstStarted.resolve();
        await new Promise<void>((resolve) => {
          options.abortSignal?.addEventListener('abort', () => {
            aborted.push(prompt);
            resolve();
          }, { once: true });
        });
        await releaseFirstClose.promise;
        throw new CodexChatInterruptedError();
      }
      if (prompt === 'second') {
        secondStarted.resolve();
        await new Promise<void>((resolve) => {
          options.abortSignal?.addEventListener('abort', () => {
            aborted.push(prompt);
            resolve();
          }, { once: true });
        });
        throw new CodexChatInterruptedError();
      }
      await onChunk('third reply');
      return { sessionId: 'session-third' };
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('AI digest should not run'); } },
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat',
    null,
    { ids: ['cli_bot'], names: ['Doujie'] }
  );
  const send = (messageId: string, prompt: string): Promise<void> => router.handleEvent(textEvent({
    messageId,
    text: `@Doujie ${prompt}`,
    chatId: 'oc_group',
    chatType: 'group',
    mentions: [{ key: '@Doujie', name: 'Doujie', id: { app_id: 'cli_bot' } }],
  }));

  try {
    const first = send('late-1', 'first');
    await firstStarted.promise;
    const second = send('late-2', 'second');
    await secondStarted.promise;

    releaseFirstClose.resolve();
    await first;

    await send('late-3', 'third');
    await second;

    assert.deepEqual(aborted, ['first', 'second']);
    assert.equal(reply.texts.length, 0);
    assert.equal(reply.statusUpdates.some((item) => item.params.output === 'third reply'), true);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router handles /detail as a verbose Codex chat command', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-detail');
  const store = new Store(dbPath, () => 1120);
  const reply = createFakeReplyWithStatusCards();
  const codex = createFakeCodexChatRunner(['[thread] started session-1', '[turn] started', 'chunk one']);
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('AI digest should not run for /detail');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    {
      model: 'test-model',
      workdir: dir,
      sandbox: 'workspace-write',
      skipGitRepoCheck: true,
    }
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'detail-1',
      text: '/detail hello',
      senderId: 'ou_event_root',
      senderAtEventRoot: true,
    }));

    assert.deepEqual(codex.prompts, ['hello']);
    assert.equal(codex.options[0]?.sessionKey, 'oc_test:ou_event_root');
    assert.equal(codex.options[0]?.outputMode, 'detail');
    assert.deepEqual(reply.texts, []);
    assert.equal(reply.statusCards.length, 1);
    assert.match(reply.statusCards[0]?.params.detail ?? '', /详细模式/);
    assert.equal(reply.statusUpdates.at(-1)?.params.output, '[thread] started session-1\n\n[turn] started\n\nchunk one');
    assert.equal(store.getProcessingJob('detail-1')?.mode, 'codex_chat');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router handles /new by clearing the current Codex session binding', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-new');
  const store = new Store(dbPath, () => 1130);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['should not run']);
  const stateFile = path.join(dir, 'codex-sessions.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ sessions: { 'oc_test:ou_event_root': 'session-1', other: 'session-2' } }),
    'utf-8'
  );
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('AI digest should not run for /new');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    {
      model: 'test-model',
      workdir: dir,
      sandbox: 'workspace-write',
      skipGitRepoCheck: true,
      stateFile,
    }
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'new-1',
      text: '/new',
      senderId: 'ou_event_root',
      senderAtEventRoot: true,
    }));

    assert.deepEqual(codex.prompts, []);
    assert.deepEqual(reply.texts.map((item) => item.text), [
      '已切换到新的 Codex session。下一条消息会使用新会话。',
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf-8')), {
      sessions: { other: 'session-2' },
    });
    assert.equal(store.getProcessingJob('new-1')?.mode, 'command');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router can route normal messages to Codex chat by default', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-default-codex');
  const store = new Store(dbPath, () => 1150);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['codex default reply']);
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('AI digest should not run for default Codex mode');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher('[来源: https://example.com/a]\narticle body'),
    undefined,
    null,
    null,
    null,
    codex.runner,
    {
      model: '',
      workdir: dir,
      sandbox: 'workspace-write',
      skipGitRepoCheck: true,
    },
    'codex_chat'
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'default-codex-1',
      text: 'read https://example.com/a',
    }));

    assert.equal(codex.prompts.length, 1);
    assert.match(codex.prompts[0] ?? '', /read https:\/\/example\.com\/a/);
    assert.match(codex.prompts[0] ?? '', /以下为链接内容/);
    assert.equal(codex.options[0]?.outputMode, 'answer');
    assert.deepEqual(reply.texts.map((item) => item.text), ['codex default reply']);
    assert.equal(reply.summaries.length, 0);
    assert.equal(store.getProcessingJob('default-codex-1')?.mode, 'codex_chat');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router stores group messages without bot mention but does not process them', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-group-no-mention');
  const store = new Store(dbPath, () => 1170);
  const reply = createFakeReply();
  const reaction = createFakeReaction();
  const codex = createFakeCodexChatRunner(['should not run']);
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('AI digest should not run for group messages without mention');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    {
      model: '',
      workdir: dir,
      sandbox: 'workspace-write',
      skipGitRepoCheck: true,
    },
    'codex_chat',
    reaction.client,
    { ids: ['cli_bot'], names: ['Doujie'] }
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'group-no-mention-1',
      text: '普通群聊消息',
      chatId: 'oc_group',
      chatType: 'group',
    }));

    assert.deepEqual(codex.prompts, []);
    assert.deepEqual(reply.texts, []);
    assert.deepEqual(reaction.reactions, []);
    assert.equal(store.getMessageContent('group-no-mention-1'), '普通群聊消息');
    assert.equal(store.getProcessingJob('group-no-mention-1'), null);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router stores edited group messages without bot mention but does not process them', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-edited-group-no-mention');
  const store = new Store(dbPath, () => 1175);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['should not run']);
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('AI digest should not run for edited group messages without mention');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    {
      model: '',
      workdir: dir,
      sandbox: 'workspace-write',
      skipGitRepoCheck: true,
    },
    'codex_chat',
    null,
    { ids: ['cli_bot'], names: ['Doujie'] }
  );
  try {
    await router.handleEvent(editedTextEvent({
      messageId: 'edited-group-no-mention-1',
      text: '编辑后仍然没有 mention',
      chatId: 'oc_group',
      chatType: 'group',
      updateTime: '1783530001000',
    }));

    assert.deepEqual(codex.prompts, []);
    assert.deepEqual(reply.texts, []);
    assert.equal(store.getMessageContent('edited-group-no-mention-1'), '编辑后仍然没有 mention');
    assert.equal(store.getProcessingJob('edited-group-no-mention-1'), null);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router processes an edited group message after it mentions the bot', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-edited-group-mention');
  const store = new Store(dbPath, () => 1178);
  const reply = createFakeReply();
  const reaction = createFakeReaction();
  const codex = createFakeCodexChatRunner(['edited group reply']);
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('AI digest should not run for edited mentioned group Codex messages');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    {
      model: '',
      workdir: dir,
      sandbox: 'workspace-write',
      skipGitRepoCheck: true,
    },
    'codex_chat',
    reaction.client,
    { ids: ['cli_bot'], names: ['Doujie'] }
  );
  const event = editedTextEvent({
    messageId: 'edited-group-mention-1',
    text: '@Doujie 编辑后请回复 OK',
    chatId: 'oc_group',
    chatType: 'group',
    updateTime: '1783530002000',
    mentions: [{ key: '@Doujie', name: 'Doujie', id: { app_id: 'cli_bot' } }],
  });
  try {
    await router.handleEvent(event);
    await router.handleEvent(event);

    assert.deepEqual(codex.prompts, ['编辑后请回复 OK']);
    assert.equal(codex.options[0]?.sessionKey, 'oc_group');
    assert.deepEqual(reply.texts.map((item) => item.text), ['edited group reply']);
    assert.deepEqual(reaction.reactions, [
      { messageId: 'edited-group-mention-1', emojiType: 'THINKING' },
      { messageId: 'edited-group-mention-1', emojiType: 'DONE' },
    ]);
    assert.equal(store.getMessageContent('edited-group-mention-1'), '编辑后请回复 OK');
    assert.equal(store.getProcessingJob('edited-group-mention-1')?.mode, 'codex_chat');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router processes group messages that mention the bot with a group-scoped Codex session', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-group-mention');
  const store = new Store(dbPath, () => 1180);
  const reply = createFakeReply();
  const reaction = createFakeReaction();
  const codex = createFakeCodexChatRunner(['group reply']);
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('AI digest should not run for mentioned group Codex messages');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    codex.runner,
    {
      model: '',
      workdir: dir,
      sandbox: 'workspace-write',
      skipGitRepoCheck: true,
    },
    'codex_chat',
    reaction.client,
    { ids: ['cli_bot'], names: ['Doujie'] }
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'group-mention-1',
      text: '@Doujie 请回复群聊 OK',
      chatId: 'oc_group',
      chatType: 'group',
      mentions: [{ key: '@Doujie', name: 'Doujie', id: { app_id: 'cli_bot' } }],
    }));

    assert.deepEqual(codex.prompts, ['请回复群聊 OK']);
    assert.equal(codex.options[0]?.sessionKey, 'oc_group');
    assert.deepEqual(reply.texts.map((item) => item.text), ['group reply']);
    assert.deepEqual(reaction.reactions, [
      { messageId: 'group-mention-1', emojiType: 'THINKING' },
      { messageId: 'group-mention-1', emojiType: 'DONE' },
    ]);
    assert.equal(store.getProcessingJob('group-mention-1')?.mode, 'codex_chat');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router processes normal messages with fetched URL content', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-default');
  const store = new Store(dbPath, () => 2000);
  const reply = createFakeReply();
  const aiInputs: string[] = [];
  const aiPipeline = {
    async process(text: string): Promise<AIResult> {
      aiInputs.push(text);
      return aiResult({ summary: 'summary', tags: ['技术'] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher('[来源: https://example.com/a]\n(抓取失败: timeout)')
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'msg-url',
      text: 'read https://example.com/a',
    }));

    assert.equal(aiInputs.length, 1);
    assert.match(aiInputs[0] ?? '', /以下为链接内容/);
    assert.match(aiInputs[0] ?? '', /抓取失败/);
    assert.deepEqual(reply.summaries, [
      { messageId: 'msg-url', result: aiResult({ summary: 'summary', tags: ['技术'] }) },
    ]);
    assert.equal(store.searchMessages('read')[0]?.summary, 'summary');
    const job = store.getProcessingJob('msg-url');
    assert.equal(job?.status, 'replied');
    assert.equal(job?.stage, 'reply');
    assert.equal(job?.retryCount, 0);
    assert.equal(job?.lastError, null);
    assert.equal(job?.replySentAt, 2000);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router persists URL source metadata for successful and failed fetches', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-sources');
  const store = new Store(dbPath, () => 2500);
  const reply = createFakeReply();
  const aiInputs: string[] = [];
  const aiPipeline = {
    async process(text: string): Promise<AIResult> {
      aiInputs.push(text);
      return aiResult({ summary: 'source summary', tags: ['链接'] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createStructuredUrlFetcher([
      {
        originalUrl: 'https://example.com/a',
        canonicalUrl: 'https://example.com/a',
        finalUrl: 'https://example.com/a',
        domain: 'example.com',
        title: 'Article A',
        fetchStatus: 'fetched',
        contentLength: 12,
        error: null,
        content: 'article text',
      },
      {
        originalUrl: 'https://example.com/fail',
        canonicalUrl: 'https://example.com/fail',
        finalUrl: null,
        domain: 'example.com',
        title: null,
        fetchStatus: 'failed',
        contentLength: 0,
        error: 'timeout',
        content: '(抓取失败: timeout)',
      },
    ])
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'source-msg',
      text: 'read https://example.com/a and https://example.com/fail',
    }));

    assert.match(aiInputs[0] ?? '', /read https:\/\/example.com\/a and https:\/\/example.com\/fail/);
    assert.match(aiInputs[0] ?? '', /article text/);
    assert.match(aiInputs[0] ?? '', /抓取失败: timeout/);
    const sources = store.getSourcesForMessage('source-msg');
    assert.equal(sources.length, 2);
    assert.equal(sources[0]?.fetchStatus, 'fetched');
    assert.equal(sources[0]?.title, 'Article A');
    assert.equal(sources[0]?.contentLength, 12);
    assert.equal(sources[1]?.fetchStatus, 'failed');
    assert.equal(sources[1]?.error, 'timeout');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router suppresses duplicate messages before AI and reply side effects', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-dedupe');
  const store = new Store(dbPath, () => 3000);
  const reply = createFakeReply();
  let aiCalls = 0;
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      aiCalls += 1;
      return aiResult({ summary: 'once', tags: ['其他'] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher('')
  );
  try {
    const event = textEvent({ messageId: 'dup-1', text: 'duplicate' });
    await router.handleEvent(event);
    await router.handleEvent(event);

    assert.equal(aiCalls, 1);
    assert.equal(reply.summaries.length, 1);
    assert.equal(store.getProcessingJob('dup-1')?.status, 'replied');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router sends error reply when AI processing fails', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-error');
  const store = new Store(dbPath, () => 4000);
  const reply = createFakeReply();
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('codex failed');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher('')
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'err-1', text: 'please summarize' }));

    assert.deepEqual(reply.errors, ['err-1']);
    assert.equal(reply.summaries.length, 0);
    const job = store.getProcessingJob('err-1');
    assert.equal(job?.status, 'failed');
    assert.equal(job?.stage, 'codex');
    assert.equal(job?.retryCount, 1);
    assert.equal(job?.lastError, 'codex failed');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router retries a failed message using the stored raw event', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-retry');
  const store = new Store(dbPath, () => 5000);
  const reply = createFakeReply();
  let aiCalls = 0;
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      aiCalls += 1;
      if (aiCalls === 1) {
        throw new Error('temporary codex failure');
      }
      return aiResult({ summary: 'retry summary', tags: ['学习'] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher('')
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'retry-target', text: 'retry me' }));
    assert.equal(store.getProcessingJob('retry-target')?.status, 'failed');

    await router.handleEvent(textEvent({ messageId: 'retry-command', text: '/retry retry-target' }));

    assert.equal(aiCalls, 2);
    assert.equal(reply.summaries.length, 1);
    assert.equal(reply.summaries[0]?.messageId, 'retry-target');
    assert.equal(store.getProcessingJob('retry-target')?.status, 'replied');
    assert.equal(store.getProcessingJob('retry-target')?.retryCount, 1);
    assert.match(reply.texts[0]?.text ?? '', /Retry started/);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router treats an explicit retry as newer than the stored target message', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-retry-freshness');
  const store = new Store(dbPath, () => 5100);
  const reply = createFakeReply();
  const currentStarted = createDeferred<void>();
  const prompts: string[] = [];
  const aborted: string[] = [];
  let oldRuns = 0;
  const runner: CodexChatRunnerLike = {
    async run(prompt, options, onChunk): Promise<CodexChatResult> {
      prompts.push(prompt);
      if (prompt === 'old failed task') {
        oldRuns += 1;
        if (oldRuns === 1) throw new Error('temporary failure');
        await onChunk('retry completed');
        return { sessionId: 'retried-session' };
      }
      currentStarted.resolve();
      return new Promise<CodexChatResult>((_resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => {
          aborted.push(prompt);
          reject(new CodexChatInterruptedError());
        }, { once: true });
      });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
    store,
    new Set<string>(),
    withoutStatusCards(reply.client),
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    null,
    runner,
    { model: '', workdir: dir, sandbox: 'workspace-write', skipGitRepoCheck: true },
    'codex_chat'
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'retry-old-target', text: 'old failed task', createTime: '100',
    }));
    assert.equal(store.getProcessingJob('retry-old-target')?.status, 'failed');

    const current = router.handleEvent(textEvent({
      messageId: 'retry-current-turn', text: 'current running task', createTime: '200',
    }));
    await currentStarted.promise;
    await router.handleEvent(textEvent({
      messageId: 'retry-fresh-command', text: '/retry retry-old-target', createTime: '300',
    }));
    await current;

    assert.deepEqual(prompts, ['old failed task', 'current running task', 'old failed task']);
    assert.deepEqual(aborted, ['current running task']);
    assert.equal(store.getProcessingJob('retry-old-target')?.status, 'replied');
    assert.equal(reply.texts.some((item) => item.text === 'retry completed'), true);
    assert.equal(reply.texts.some((item) => /Retry started/.test(item.text)), true);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router rejects retry for an already successful message', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-retry-reject');
  const store = new Store(dbPath, () => 6000);
  const reply = createFakeReply();
  let aiCalls = 0;
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      aiCalls += 1;
      return aiResult({ summary: 'already done', tags: ['其他'] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher('')
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'done-1', text: 'already done' }));
    await router.handleEvent(textEvent({ messageId: 'retry-done', text: '/retry done-1' }));

    assert.equal(aiCalls, 1);
    assert.equal(reply.summaries.length, 1);
    assert.match(reply.texts[0]?.text ?? '', /Cannot retry done-1/);
    assert.equal(store.getProcessingJob('done-1')?.status, 'replied');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router save command stores text without AI processing', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-save');
  const store = new Store(dbPath, () => 7000);
  const reply = createFakeReply();
  let aiCalls = 0;
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      aiCalls += 1;
      return aiResult({ summary: 'should not happen', tags: [] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher('')
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'save-1', text: '/save remember this item' }));

    assert.equal(aiCalls, 0);
    assert.equal(reply.summaries.length, 0);
    assert.match(reply.texts[0]?.text ?? '', /Saved 18 characters/);
    assert.equal(store.searchMessages('remember this item')[0]?.content, 'remember this item');
    const job = store.getProcessingJob('save-1');
    assert.equal(job?.status, 'replied');
    assert.equal(job?.mode, 'save');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router digest command runs AI on provided text', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-digest');
  const store = new Store(dbPath, () => 8000);
  const reply = createFakeReply();
  const aiInputs: string[] = [];
  const aiPipeline = {
    async process(text: string): Promise<AIResult> {
      aiInputs.push(text);
      return aiResult({ summary: 'digest summary', tags: ['学习'] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher('[来源: https://example.com/a]\narticle text')
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'digest-1', text: '/digest read https://example.com/a' }));

    assert.equal(aiInputs.length, 1);
    assert.doesNotMatch(aiInputs[0] ?? '', /^\/digest/);
    assert.match(aiInputs[0] ?? '', /article text/);
    assert.deepEqual(reply.summaries, [
      { messageId: 'digest-1', result: aiResult({ summary: 'digest summary', tags: ['学习'] }) },
    ]);
    assert.equal(store.getProcessingJob('digest-1')?.mode, 'digest');
    assert.equal(store.searchMessages('read https://example.com/a')[0]?.summary, 'digest summary');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router skip command records skipped mode without AI processing', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-skip');
  const store = new Store(dbPath, () => 9000);
  const reply = createFakeReply();
  let aiCalls = 0;
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      aiCalls += 1;
      return aiResult({ summary: 'should not happen', tags: [] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher('')
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'skip-1', text: '/skip private' }));

    assert.equal(aiCalls, 0);
    assert.equal(reply.summaries.length, 0);
    assert.match(reply.texts[0]?.text ?? '', /Skipped processing/);
    const job = store.getProcessingJob('skip-1');
    assert.equal(job?.status, 'replied');
    assert.equal(job?.mode, 'skip');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router redo command refreshes processed result without duplicate target reply', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-redo');
  const store = new Store(dbPath, () => 10000);
  const reply = createFakeReply();
  let aiCalls = 0;
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      aiCalls += 1;
      if (aiCalls === 1) {
        return aiResult({ summary: 'old summary', tags: ['旧'] });
      }
      return aiResult({ summary: 'new summary', tags: ['新'] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher('')
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'redo-target', text: 'redo target content' }));
    assert.equal(reply.summaries.length, 1);
    assert.equal(store.searchMessages('redo target')[0]?.summary, 'old summary');

    await router.handleEvent(textEvent({ messageId: 'redo-command', text: '/redo redo-target' }));

    assert.equal(aiCalls, 2);
    assert.equal(reply.summaries.length, 1);
    assert.match(reply.texts[0]?.text ?? '', /Redo complete for redo-target/);
    assert.equal(
      store.searchMessages('redo target').find((result) => result.id === 'redo-target')?.summary,
      'new summary'
    );
    const targetJob = store.getProcessingJob('redo-target');
    assert.equal(targetJob?.status, 'processed');
    assert.equal(targetJob?.mode, 'redo');
    assert.equal(store.getProcessingJob('redo-command')?.status, 'replied');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router retag command updates processed tags without running AI', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-retag');
  const store = new Store(dbPath, () => 11000, { disableFts: true });
  const reply = createFakeReply();
  let aiCalls = 0;
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      aiCalls += 1;
      return aiResult({ summary: 'target summary', tags: ['旧标签'] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher('')
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'retag-target', text: 'retag target content' }));
    await router.handleEvent(textEvent({ messageId: 'retag-command', text: '/retag retag-target 技术,学习 技术' }));

    assert.equal(aiCalls, 1);
    assert.match(reply.texts[0]?.text ?? '', /Retagged retag-target/);
    assert.equal(store.searchMessages({ keyword: 'retag target', tag: '技术' })[0]?.id, 'retag-target');
    assert.equal(store.getTagFeedback('retag-target').length, 1);
    assert.equal(store.getProcessingJob('retag-command')?.status, 'replied');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router merge-tag command records alias and rewrites existing tags', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-merge-tag');
  const store = new Store(dbPath, () => 12000, { disableFts: true });
  const reply = createFakeReply();
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('AI should not run for merge-tag');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher('')
  );
  try {
    store.saveMessage({
      id: 'merge-target',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'merge target content',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.saveProcessed({
      id: 'merge-target-processed',
      messageId: 'merge-target',
      summary: 'merge summary',
      tags: ['tech'],
      processedAt: 12001,
    });

    await router.handleEvent(textEvent({ messageId: 'merge-command', text: '/merge-tag tech 技术' }));

    assert.match(reply.texts[0]?.text ?? '', /Merged tag tech -> 技术/);
    assert.equal(store.searchMessages({ keyword: 'merge target', tag: 'tech' })[0]?.id, 'merge-target');
    assert.equal(store.searchMessages({ keyword: 'merge target', tag: '技术' })[0]?.tags, '["技术"]');
    assert.equal(store.getProcessingJob('merge-command')?.status, 'replied');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router ask command answers with stored message citations', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-ask');
  const store = new Store(dbPath, () => 12500, { disableFts: true });
  const reply = createFakeReply();
  const fakeAnswer = createFakeAnswerPipeline({
    answer: 'Use the launch checklist from the stored note.',
    citations: ['ask-target'],
  });
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('Digest AI should not run for ask');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    fakeAnswer.pipeline
  );
  try {
    store.saveMessage({
      id: 'ask-target',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'alpha launch checklist',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.saveProcessed({
      id: 'ask-target-processed',
      messageId: 'ask-target',
      summary: 'Alpha launch checklist summary',
      tags: ['技术'],
      keyPoints: ['alpha launch requires checklist'],
      processedAt: 12501,
    });

    await router.handleEvent(textEvent({ messageId: 'ask-command', text: '/ask alpha launch?' }));

    assert.equal(fakeAnswer.prompts.length, 1);
    assert.match(fakeAnswer.prompts[0] ?? '', /Question: alpha launch\?/);
    assert.match(fakeAnswer.prompts[0] ?? '', /message_id: ask-target/);
    assert.match(reply.texts[0]?.text ?? '', /Use the launch checklist/);
    assert.match(reply.texts[0]?.text ?? '', /ask-target/);
    assert.equal(store.getProcessingJob('ask-command')?.status, 'replied');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router ask command refuses to answer when no evidence is found', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-ask-empty');
  const store = new Store(dbPath, () => 12600, { disableFts: true });
  const reply = createFakeReply();
  const fakeAnswer = createFakeAnswerPipeline({ answer: 'should not run', citations: [] });
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('Digest AI should not run for ask');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    null,
    null,
    fakeAnswer.pipeline
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'ask-empty', text: '/ask missing topic' }));

    assert.equal(fakeAnswer.prompts.length, 0);
    assert.match(reply.texts[0]?.text ?? '', /No evidence found/);
    assert.match(reply.texts[0]?.text ?? '', /will not invent/);
    assert.equal(store.getProcessingJob('ask-empty')?.status, 'replied');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router ask command applies privacy skip rules to evidence context', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-ask-privacy-skip');
  const store = new Store(dbPath, () => 12700, { disableFts: true });
  const reply = createFakeReply();
  const fakeAnswer = createFakeAnswerPipeline({ answer: 'should not run', citations: [] });
  const privacy: PrivacyConfig = {
    allowChatIds: [],
    denyChatIds: [],
    allowUserIds: [],
    denyUserIds: [],
    skipPatterns: [{ name: 'secret-token', pattern: 'SECRET-[0-9]+' }],
    redactPatterns: [],
  };
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('Digest AI should not run for ask');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    privacy,
    null,
    null,
    fakeAnswer.pipeline
  );
  try {
    store.saveMessage({
      id: 'ask-secret-target',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'alpha SECRET-123',
      messageType: 'text',
      rawEvent: '{}',
    });

    await router.handleEvent(textEvent({ messageId: 'ask-secret', text: '/ask alpha' }));

    assert.equal(fakeAnswer.prompts.length, 0);
    assert.match(reply.texts[0]?.text ?? '', /Skipped by privacy rule: privacy_skip:secret-token/);
    assert.equal(store.getProcessingJob('ask-secret')?.status, 'replied');
    assert.equal(store.getProcessingJob('ask-secret')?.mode, 'skip');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router ask command redacts evidence context before QA processing', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-ask-privacy-redact');
  const store = new Store(dbPath, () => 12800, { disableFts: true });
  const reply = createFakeReply();
  const fakeAnswer = createFakeAnswerPipeline({ answer: 'Redacted answer.', citations: ['ask-redact-target'] });
  const privacy: PrivacyConfig = {
    allowChatIds: [],
    denyChatIds: [],
    allowUserIds: [],
    denyUserIds: [],
    skipPatterns: [],
    redactPatterns: [{ name: 'email', pattern: '[^\\s]+@example\\.com', replacement: '[EMAIL]' }],
  };
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      throw new Error('Digest AI should not run for ask');
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    privacy,
    null,
    null,
    fakeAnswer.pipeline
  );
  try {
    store.saveMessage({
      id: 'ask-redact-target',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'alpha contact user@example.com',
      messageType: 'text',
      rawEvent: '{}',
    });

    await router.handleEvent(textEvent({ messageId: 'ask-redact', text: '/ask alpha contact' }));

    assert.equal(fakeAnswer.prompts.length, 1);
    assert.match(fakeAnswer.prompts[0] ?? '', /contact \[EMAIL\]/);
    assert.doesNotMatch(fakeAnswer.prompts[0] ?? '', /user@example.com/);
    assert.match(reply.texts[0]?.text ?? '', /ask-redact-target/);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router injects frequent tag and alias hints into digest input', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-tag-context');
  const store = new Store(dbPath, () => 13000, { disableFts: true });
  const reply = createFakeReply();
  const aiInputs: string[] = [];
  const aiPipeline = {
    async process(text: string): Promise<AIResult> {
      aiInputs.push(text);
      return aiResult({ summary: 'hinted summary', tags: ['技术'] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher('')
  );
  try {
    store.saveMessage({
      id: 'tag-history',
      chatId: 'chat-1',
      senderId: 'sender-1',
      content: 'history content',
      messageType: 'text',
      rawEvent: '{}',
    });
    store.saveProcessed({
      id: 'tag-history-processed',
      messageId: 'tag-history',
      summary: 'history summary',
      tags: ['技术'],
      processedAt: 13001,
    });
    store.mergeTag('tech', '技术');

    await router.handleEvent(textEvent({ messageId: 'hinted-message', text: 'new content' }));

    assert.match(aiInputs[0] ?? '', /\[Doujie tag hints\]/);
    assert.match(aiInputs[0] ?? '', /Frequent tags: 技术\(1\)/);
    assert.match(aiInputs[0] ?? '', /Aliases: tech -> 技术/);
    assert.match(aiInputs[0] ?? '', /--- Message ---\nnew content/);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router skips denylisted users before AI and stores only a privacy placeholder', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-privacy-deny');
  const store = new Store(dbPath, () => 14000, { disableFts: true });
  const reply = createFakeReply();
  let aiCalls = 0;
  const privacy: PrivacyConfig = {
    allowChatIds: [],
    denyChatIds: [],
    allowUserIds: [],
    denyUserIds: ['ou_denied'],
    skipPatterns: [],
    redactPatterns: [],
  };
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      aiCalls += 1;
      return aiResult({ summary: 'should not happen', tags: [] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    privacy
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'privacy-deny', senderId: 'ou_denied', text: 'SECRET full text' }));

    assert.equal(aiCalls, 0);
    assert.match(reply.texts[0]?.text ?? '', /Skipped by privacy rule: privacy_skip:deny_user/);
    assert.equal(store.getMessageContent('privacy-deny'), '[privacy skipped: privacy_skip:deny_user]');
    assert.doesNotMatch(store.getMessageRawEvent('privacy-deny') ?? '', /SECRET full text/);
    const job = store.getProcessingJob('privacy-deny');
    assert.equal(job?.status, 'replied');
    assert.equal(job?.stage, 'privacy_skip');
    assert.equal(job?.mode, 'skip');
    assert.equal(job?.lastError, 'privacy_skip:deny_user');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router redacts configured patterns before storage and AI', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-privacy-redact');
  const store = new Store(dbPath, () => 15000, { disableFts: true });
  const reply = createFakeReply();
  const aiInputs: string[] = [];
  const privacy: PrivacyConfig = {
    allowChatIds: [],
    denyChatIds: [],
    allowUserIds: [],
    denyUserIds: [],
    skipPatterns: [],
    redactPatterns: [{ name: 'email', pattern: '[^\\s]+@example\\.com', replacement: '[EMAIL]' }],
  };
  const aiPipeline = {
    async process(text: string): Promise<AIResult> {
      aiInputs.push(text);
      return aiResult({ summary: 'redacted summary', tags: ['隐私'] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    privacy
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'privacy-redact', text: 'contact user@example.com now' }));

    assert.equal(aiInputs.length, 1);
    assert.match(aiInputs[0] ?? '', /contact \[EMAIL\] now/);
    assert.doesNotMatch(aiInputs[0] ?? '', /user@example.com/);
    assert.equal(store.getMessageContent('privacy-redact'), 'contact [EMAIL] now');
    assert.doesNotMatch(store.getMessageRawEvent('privacy-redact') ?? '', /user@example.com/);
    assert.equal(store.getProcessingJob('privacy-redact')?.status, 'replied');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router skips after fetched URL content triggers a privacy rule', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-privacy-fetch-skip');
  const store = new Store(dbPath, () => 16000, { disableFts: true });
  const reply = createFakeReply();
  let aiCalls = 0;
  const privacy: PrivacyConfig = {
    allowChatIds: [],
    denyChatIds: [],
    allowUserIds: [],
    denyUserIds: [],
    skipPatterns: [{ name: 'secret-token', pattern: 'SECRET-[0-9]+' }],
    redactPatterns: [],
  };
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      aiCalls += 1;
      return aiResult({ summary: 'should not happen', tags: [] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher('article SECRET-123 content'),
    privacy
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'privacy-fetch-skip', text: 'read https://example.com/a' }));

    assert.equal(aiCalls, 0);
    assert.match(reply.texts[0]?.text ?? '', /Skipped by privacy rule: privacy_skip:secret-token/);
    const job = store.getProcessingJob('privacy-fetch-skip');
    assert.equal(job?.status, 'replied');
    assert.equal(job?.stage, 'privacy_skip');
    assert.equal(job?.lastError, 'privacy_skip:secret-token');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router downloads image attachments and records metadata', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-attachment-success');
  const store = new Store(dbPath, () => 17000, { disableFts: true });
  const reply = createFakeReply();
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      return aiResult({ summary: 'image summary', tags: ['图片'] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    createAttachmentDownloader((attachment) => ({
      status: 'downloaded',
      localPath: `/tmp/cache/${attachment.resourceKey}`,
    }))
  );
  try {
    await router.handleEvent(resourceEvent({
      messageId: 'image-message',
      messageType: 'image',
      content: { image_key: 'img_abc', file_name: 'photo.png', file_size: 123 },
    }));

    const attachments = store.getAttachmentsForMessage('image-message');
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]?.resourceKey, 'img_abc');
    assert.equal(attachments[0]?.resourceType, 'image');
    assert.equal(attachments[0]?.downloadStatus, 'downloaded');
    assert.equal(attachments[0]?.localPath, '/tmp/cache/img_abc');
    assert.equal(store.getProcessingJob('image-message')?.status, 'replied');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router extracts downloaded attachment text and appends it to AI input', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-attachment-extract');
  const store = new Store(dbPath, () => 17500, { disableFts: true });
  const reply = createFakeReply();
  const aiInputs: string[] = [];
  const aiPipeline = {
    async process(text: string): Promise<AIResult> {
      aiInputs.push(text);
      return aiResult({ summary: 'file summary', tags: ['文件'] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    createAttachmentDownloader((attachment) => ({
      status: 'downloaded',
      localPath: `/tmp/cache/${attachment.resourceKey}.txt`,
    })),
    createAttachmentExtractor('attachment extracted body')
  );
  try {
    await router.handleEvent(resourceEvent({
      messageId: 'file-extract-message',
      messageType: 'file',
      content: { file_key: 'file_text', file_name: 'notes.txt', mime_type: 'text/plain' },
    }));

    assert.match(aiInputs[0] ?? '', /以下为附件内容/);
    assert.match(aiInputs[0] ?? '', /\[附件 1: notes\.txt\]/);
    assert.match(aiInputs[0] ?? '', /attachment extracted body/);
    const attachments = store.getAttachmentsForMessage('file-extract-message');
    assert.equal(attachments[0]?.extractionStatus, 'extracted');
    assert.equal(attachments[0]?.extractedText, 'attachment extracted body');
    assert.equal(attachments[0]?.extractionError, null);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router persists attachment extraction failures without failing processing', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-attachment-extract-fail');
  const store = new Store(dbPath, () => 17600, { disableFts: true });
  const reply = createFakeReply();
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      return aiResult({ summary: 'file summary', tags: ['文件'] });
    },
  };
  const failingExtractor: AttachmentExtractor = {
    async extract(): Promise<{ status: 'failed'; error: string }> {
      return { status: 'failed', error: 'cannot read attachment' };
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    createAttachmentDownloader((attachment) => ({
      status: 'downloaded',
      localPath: `/tmp/cache/${attachment.resourceKey}.pdf`,
    })),
    failingExtractor
  );
  try {
    await router.handleEvent(resourceEvent({
      messageId: 'file-extract-fail-message',
      messageType: 'file',
      content: { file_key: 'file_pdf', file_name: 'report.pdf', mime_type: 'application/pdf' },
    }));

    const attachments = store.getAttachmentsForMessage('file-extract-fail-message');
    assert.equal(attachments[0]?.extractionStatus, 'failed');
    assert.equal(attachments[0]?.extractedText, null);
    assert.equal(attachments[0]?.extractionError, 'cannot read attachment');
    assert.equal(store.getProcessingJob('file-extract-fail-message')?.status, 'replied');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router records failed file attachment downloads without failing processing', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-attachment-fail');
  const store = new Store(dbPath, () => 18000, { disableFts: true });
  const reply = createFakeReply();
  const aiPipeline = {
    async process(_text: string): Promise<AIResult> {
      return aiResult({ summary: 'file summary', tags: ['文件'] });
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    aiPipeline,
    store,
    new Set<string>(),
    reply.client,
    createFakeUrlFetcher(''),
    undefined,
    createAttachmentDownloader(() => ({ status: 'failed', error: 'download denied' }))
  );
  try {
    await router.handleEvent(resourceEvent({
      messageId: 'file-message',
      messageType: 'file',
      content: { file_key: 'file_abc', file_name: 'report.pdf', mime_type: 'application/pdf' },
    }));

    const attachments = store.getAttachmentsForMessage('file-message');
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]?.downloadStatus, 'failed');
    assert.equal(attachments[0]?.error, 'download denied');
    assert.equal(store.getProcessingJob('file-message')?.status, 'replied');
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router includes one bounded direct-parent quote in the default Codex prompt', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-quote-parent');
  const store = new Store(dbPath, () => 19000);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['ok']);
  const config = buildConfig({ features: { quoted_message: { enabled: true, max_chars: 4 } } }, {});
  const manager = new RuntimeConfigManager(config, () => config);
  const fetchedIds: string[] = [];
  const quoted: QuotedMessageProvider = {
    async fetch(messageId) {
      fetchedIds.push(messageId);
      return { messageId, text: '123456' };
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), config.privacy,
    null, null, null, codex.runner,
    { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
    'codex_chat', null, { ids: [], names: [] }, null, null, manager, quoted
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'quote-parent-1', text: 'current request',
      parentId: 'om_parent', replyTo: 'om_reply_fallback', rootId: 'om_root',
    }));

    assert.deepEqual(fetchedIds, ['om_parent']);
    assert.match(codex.prompts[0] ?? '', /CURRENT USER REQUEST \(the only instruction to execute\)\ncurrent request/);
    assert.match(codex.prompts[0] ?? '', /UNTRUSTED QUOTED FEISHU MESSAGE/);
    assert.match(codex.prompts[0] ?? '', /> 1234\n\[QUOTED MESSAGE TRUNCATED\]/);
    assert.doesNotMatch(codex.prompts[0] ?? '', /12345/);
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router skips quote lookup when disabled or before the group mention gate', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-quote-gates');
  const store = new Store(dbPath, () => 19100);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['ok']);
  const disabled = buildConfig({}, {});
  const enabled = buildConfig({ features: { quoted_message: { enabled: true } } }, {});
  const manager = new RuntimeConfigManager(disabled, () => enabled);
  let fetches = 0;
  const quoted: QuotedMessageProvider = {
    async fetch(messageId) { fetches += 1; return { messageId, text: 'quote' }; },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), disabled.privacy,
    null, null, null, codex.runner,
    { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
    'codex_chat', null, { ids: [], names: ['豆姐'] }, null, null, manager, quoted
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'quote-disabled', text: 'plain', parentId: 'om_parent' }));
    await manager.reload();
    await router.handleEvent(textEvent({ messageId: 'quote-no-relationship', text: 'no relation' }));
    await router.handleEvent(textEvent({
      messageId: 'quote-no-mention', text: 'group plain', parentId: 'om_parent',
      chatId: 'oc_group', chatType: 'group',
    }));
    assert.equal(fetches, 0);
    assert.deepEqual(codex.prompts, ['plain', 'no relation']);
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router falls back to current text on unavailable or failed root quote lookup', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-quote-fallback');
  const store = new Store(dbPath, () => 19200);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['ok']);
  const config = buildConfig({ features: { quoted_message: { enabled: true } } }, {});
  const manager = new RuntimeConfigManager(config, () => config);
  const ids: string[] = [];
  const quoted: QuotedMessageProvider = {
    async fetch(messageId) {
      ids.push(messageId);
      if (messageId === 'om_fail') throw new Error('lookup failed without message body');
      return null;
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), config.privacy,
    null, null, null, codex.runner,
    { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
    'codex_chat', null, { ids: [], names: [] }, null, null, manager, quoted
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'quote-root-null', text: 'first', rootId: 'om_root' }));
    await router.handleEvent(textEvent({ messageId: 'quote-root-fail', text: 'second', rootId: 'om_fail' }));
    assert.deepEqual(ids, ['om_root', 'om_fail']);
    assert.deepEqual(codex.prompts, ['first', 'second']);
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router applies combined-content privacy skip and redaction to quoted text', async () => {
  const runCase = async (action: 'skip' | 'redact'): Promise<{ prompts: string[]; replies: string[] }> => {
    const { dir, dbPath } = createTempDbPath(`doujie-router-quote-privacy-${action}`);
    const store = new Store(dbPath, () => 19300);
    const reply = createFakeReply();
    const codex = createFakeCodexChatRunner(['ok']);
    const config = buildConfig({
      features: { quoted_message: { enabled: true } },
      privacy: action === 'skip'
        ? { skip_patterns: [{ name: 'quote', pattern: 'QUOTE-SECRET' }] }
        : { redact_patterns: [{ name: 'quote', pattern: 'QUOTE-SECRET', replacement: '[QUOTE]' }] },
    }, {});
    const manager = new RuntimeConfigManager(config, () => config);
    const router = new Router(
      createCommandRegistry(store),
      { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
      store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), config.privacy,
      null, null, null, codex.runner,
      { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
      'codex_chat', null, { ids: [], names: [] }, null, null, manager,
      { async fetch(messageId) { return { messageId, text: 'QUOTE-SECRET' }; } }
    );
    try {
      await router.handleEvent(textEvent({ messageId: `quote-${action}`, text: 'current', parentId: 'om_parent' }));
      return { prompts: codex.prompts, replies: reply.texts.map((item) => item.text) };
    } finally {
      store.close(); removeTempDir(dir);
    }
  };

  const skipped = await runCase('skip');
  assert.deepEqual(skipped.prompts, []);
  assert.deepEqual(skipped.replies, ['Skipped by privacy rule: privacy_skip:quote']);
  const redacted = await runCase('redact');
  assert.equal(redacted.prompts.length, 1);
  assert.match(redacted.prompts[0] ?? '', /\[QUOTE\]/);
  assert.doesNotMatch(redacted.prompts[0] ?? '', /QUOTE-SECRET/);
});

test('Router keeps an in-flight request on its captured quote snapshot across reload', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-quote-snapshot');
  const store = new Store(dbPath, () => 19400);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['ok']);
  const enabled = buildConfig({ features: { quoted_message: { enabled: true, max_chars: 3 } } }, {});
  const disabled = buildConfig({ features: { quoted_message: { enabled: false, max_chars: 20 } } }, {});
  const manager = new RuntimeConfigManager(enabled, () => disabled);
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  const fetchedIds: string[] = [];
  const quoted: QuotedMessageProvider = {
    async fetch(messageId) {
      fetchedIds.push(messageId);
      started.resolve();
      await release.promise;
      return { messageId, text: 'abcdef' };
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), enabled.privacy,
    null, null, null, codex.runner,
    { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
    'codex_chat', null, { ids: [], names: [] }, null, null, manager, quoted
  );
  try {
    const handling = router.handleEvent(textEvent({ messageId: 'quote-snapshot', text: 'current', parentId: 'om_parent' }));
    await started.promise;
    await manager.reload();
    release.resolve();
    await handling;

    assert.match(codex.prompts[0] ?? '', /> abc\n\[QUOTED MESSAGE TRUNCATED\]/);
    assert.equal(manager.getSnapshot().config.features.quotedMessage.enabled, false);
    await router.handleEvent(textEvent({ messageId: 'quote-after-reload', text: 'next', parentId: 'om_next' }));
    assert.deepEqual(fetchedIds, ['om_parent']);
    assert.equal(codex.prompts[1], 'next');
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router authorizes /reload before invoking its side effect', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-reload-gate');
  const store = new Store(dbPath, () => 19500);
  const reply = createFakeReply();
  let reloads = 0;
  const runtime = {
    startedAt: 0,
    inFlight: new Set<string>(),
    dbPath,
    backupDir: dir,
    exportDir: dir,
    controlSessionDir: dir,
    getListenerStatus: () => ({ state: 'running' as const, lastEventAt: null, restartCount: 0 }),
    reloadConfig: async () => {
      reloads += 1;
      return { ok: true, previousVersion: 1, version: 2, changed: true, restartRequired: [] };
    },
  };
  const privacy: PrivacyConfig = {
    allowChatIds: [], denyChatIds: [], allowUserIds: [], denyUserIds: [], skipPatterns: [], redactPatterns: [],
    adminUserIds: ['ou_admin'], privateAllowUserIds: ['ou_admin', 'ou_member'], groups: [],
  };
  const router = new Router(
    createCommandRegistry(store, runtime),
    { async process(): Promise<AIResult> { throw new Error('AI should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), privacy,
    null, null, null, undefined, undefined, undefined, null, { ids: [], names: [] }, null
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'reload-member', text: '/reload', senderId: 'ou_member' }));
    assert.equal(reloads, 0);
    assert.equal(reply.texts[0]?.text, '/reload 仅管理员可用。');
    await router.handleEvent(textEvent({ messageId: 'reload-admin', text: '/reload', senderId: 'ou_admin' }));
    assert.equal(reloads, 1);
    assert.match(reply.texts[1]?.text ?? '', /配置重载成功/);
    assert.match(reply.texts[1]?.text ?? '', /1 → 2/);
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router denies quote lookup before the group Agent permission gate', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-quote-agent-permission');
  const store = new Store(dbPath, () => 19600);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['should not run']);
  const config = buildConfig({
    features: { quoted_message: { enabled: true } },
    privacy: {
      groups: [{
        chat_id: 'oc_group',
        allow_user_ids: ['ou_member'],
        allow_agent_user_ids: [],
      }],
    },
  }, {});
  let fetches = 0;
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), config.privacy,
    null, null, null, codex.runner,
    { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
    'codex_chat', null, { ids: ['cli_bot'], names: [] }, null, null,
    new RuntimeConfigManager(config, () => config),
    { async fetch(messageId) { fetches += 1; return { messageId, text: 'quote' }; } }
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'quote-agent-denied',
      text: '@Doujie current',
      senderId: 'ou_member',
      chatId: 'oc_group',
      chatType: 'group',
      parentId: 'om_parent',
      mentions: [{ key: '@Doujie', id: { app_id: 'cli_bot' } }],
    }));

    assert.equal(fetches, 0);
    assert.deepEqual(codex.prompts, []);
    assert.match(reply.texts[0]?.text ?? '', /没有权限调度 Codex Agent/);
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router treats an edited reply relationship as a new prompt generation', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-quote-edit-relationship');
  const store = new Store(dbPath, () => 19700);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['first', 'second']);
  const config = buildConfig({ features: { quoted_message: { enabled: true } } }, {});
  const ids: string[] = [];
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), config.privacy,
    null, null, null, codex.runner,
    { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
    'codex_chat', null, { ids: [], names: [] }, null, null,
    new RuntimeConfigManager(config, () => config),
    { async fetch(messageId) { ids.push(messageId); return { messageId, text: `quote:${messageId}` }; } }
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'quote-edit-relation', text: 'same current text', replyTo: 'om_parent_1',
    }));
    await router.handleEvent(editedTextEvent({
      messageId: 'quote-edit-relation', text: 'same current text', replyTo: 'om_parent_2',
    }));

    assert.deepEqual(ids, ['om_parent_1', 'om_parent_2']);
    assert.match(codex.prompts[0] ?? '', /quote:om_parent_1/);
    assert.match(codex.prompts[1] ?? '', /quote:om_parent_2/);
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router resolves a receive-event reply relationship and suppresses poller enrichment replay', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-quote-receive-poller-race');
  const store = new Store(dbPath, () => 19750);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['once']);
  const config = buildConfig({ features: { quoted_message: { enabled: true } } }, {});
  const fetched: string[] = [];
  const resolving = createDeferred<void>();
  const releaseRelationship = createDeferred<void>();
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), config.privacy,
    null, null, null, codex.runner,
    { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
    'codex_chat', null, { ids: [], names: [] }, null, null,
    new RuntimeConfigManager(config, () => config),
    {
      async resolveRelationship() {
        resolving.resolve();
        await releaseRelationship.promise;
        return { parentId: 'om_parent' };
      },
      async fetch(messageId) { fetched.push(messageId); return { messageId, text: 'quoted parent' }; },
    }
  );
  try {
    const receiveHandling = router.handleEvent(textEvent({
      messageId: 'quote-race', text: 'current request', rootId: 'om_root_only',
    }));
    await resolving.promise;
    await router.handleEvent(editedTextEvent({
      messageId: 'quote-race', text: 'current request', replyTo: 'om_parent', rootId: 'om_root_only',
    }));
    releaseRelationship.resolve();
    await receiveHandling;

    assert.deepEqual(fetched, ['om_parent']);
    assert.equal(codex.prompts.length, 1);
    assert.match(codex.prompts[0] ?? '', /quoted parent/);
    assert.equal(store.getProcessingJob('quote-race')?.status, 'replied');
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router persists a resolver-first direct parent before a later poller observation', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-quote-resolver-first');
  const store = new Store(dbPath, () => 19755);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['once']);
  const config = buildConfig({ features: { quoted_message: { enabled: true } } }, {});
  let relationshipResolutions = 0;
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), config.privacy,
    null, null, null, codex.runner,
    { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
    'codex_chat', null, { ids: [], names: [] }, null, null,
    new RuntimeConfigManager(config, () => config),
    {
      async resolveRelationship() { relationshipResolutions += 1; return { parentId: 'om_parent' }; },
      async fetch(messageId) { return { messageId, text: 'quoted parent' }; },
    }
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'quote-resolver-first', text: 'current request' }));
    const stored = JSON.parse(store.getMessageRawEvent('quote-resolver-first') ?? '{}') as FeishuEvent;
    assert.equal(stored.event.message.parent_id, 'om_parent');

    await router.handleEvent(editedTextEvent({
      messageId: 'quote-resolver-first', text: 'current request', replyTo: 'om_parent',
    }));
    assert.equal(relationshipResolutions, 1);
    assert.equal(codex.prompts.length, 1);
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router retry reuses the persisted resolver-discovered direct parent', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-quote-resolved-retry');
  const store = new Store(dbPath, () => 19757);
  const reply = createFakeReply();
  const config = buildConfig({ features: { quoted_message: { enabled: true } } }, {});
  let relationshipResolutions = 0;
  let runs = 0;
  const fetched: string[] = [];
  const runner: CodexChatRunnerLike = {
    async run(): Promise<CodexChatResult> {
      runs += 1;
      if (runs === 1) throw new Error('temporary failure');
      return { sessionId: 'resolved-retry-session' };
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), config.privacy,
    null, null, null, runner,
    { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
    'codex_chat', null, { ids: [], names: [] }, null, null,
    new RuntimeConfigManager(config, () => config),
    {
      async resolveRelationship() { relationshipResolutions += 1; return { parentId: 'om_parent' }; },
      async fetch(messageId) { fetched.push(messageId); return { messageId, text: 'quoted parent' }; },
    }
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'quote-resolved-retry', text: 'current request' }));
    assert.equal(store.getProcessingJob('quote-resolved-retry')?.status, 'failed');
    await router.handleEvent(textEvent({
      messageId: 'quote-resolved-retry-command', text: '/retry quote-resolved-retry',
    }));

    assert.equal(relationshipResolutions, 1);
    assert.deepEqual(fetched, ['om_parent', 'om_parent']);
    assert.equal(store.getProcessingJob('quote-resolved-retry')?.status, 'replied');
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router ignores relationship-only poller enrichment when quoting is disabled', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-quote-disabled-race');
  const store = new Store(dbPath, () => 19760);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['once']);
  const config = buildConfig({ features: { quoted_message: { enabled: false } } }, {});
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), config.privacy,
    null, null, null, codex.runner,
    { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
    'codex_chat', null, { ids: [], names: [] }, null, null,
    new RuntimeConfigManager(config, () => config),
    { async fetch(messageId) { return { messageId, text: 'must not be read' }; } }
  );
  try {
    await router.handleEvent(textEvent({ messageId: 'quote-disabled-race', text: 'current request' }));
    await router.handleEvent(editedTextEvent({
      messageId: 'quote-disabled-race', text: 'current request',
      parentId: 'om_parent', replyTo: 'om_parent',
    }));

    assert.deepEqual(codex.prompts, ['current request']);
    assert.equal(store.getProcessingJob('quote-disabled-race')?.status, 'replied');
    const stored = JSON.parse(store.getMessageRawEvent('quote-disabled-race') ?? '{}') as FeishuEvent;
    assert.equal(stored.event.message.parent_id, 'om_parent');
    assert.equal(stored.event.message.reply_to, 'om_parent');
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router reprocesses when reply relationship enrichment also changes effective text', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-quote-enrichment-text-change');
  const store = new Store(dbPath, () => 19762);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['first', 'second']);
  const config = buildConfig({ features: { quoted_message: { enabled: true } } }, {});
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), config.privacy,
    null, null, null, codex.runner,
    { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
    'codex_chat', null, { ids: [], names: [] }, null, null,
    new RuntimeConfigManager(config, () => config),
    { async fetch(messageId) { return { messageId, text: 'quoted parent' }; } }
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'quote-enrichment-text-change', text: 'first request',
    }));
    await router.handleEvent(editedTextEvent({
      messageId: 'quote-enrichment-text-change', text: 'changed request',
      parentId: 'om_parent', replyTo: 'om_parent', updateTime: '1783530002500',
    }));

    assert.equal(codex.prompts.length, 2);
    assert.equal(codex.prompts[0], 'first request');
    assert.match(codex.prompts[1] ?? '', /changed request/);
    assert.match(codex.prompts[1] ?? '', /quoted parent/);
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router combines update_time with text and known-parent generations', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-quote-same-update-generations');
  const store = new Store(dbPath, () => 19764);
  const reply = createFakeReply();
  const codex = createFakeCodexChatRunner(['first', 'second', 'third']);
  const config = buildConfig({ features: { quoted_message: { enabled: true } } }, {});
  const fetched: string[] = [];
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), config.privacy,
    null, null, null, codex.runner,
    { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
    'codex_chat', null, { ids: [], names: [] }, null, null,
    new RuntimeConfigManager(config, () => config),
    { async fetch(messageId) { fetched.push(messageId); return { messageId, text: `quote:${messageId}` }; } }
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'quote-same-update', text: 'first request', parentId: 'om_parent_1',
    }));
    await router.handleEvent(editedTextEvent({
      messageId: 'quote-same-update', text: 'second request', parentId: 'om_parent_1',
      updateTime: '1783530002600',
    }));
    await router.handleEvent(editedTextEvent({
      messageId: 'quote-same-update', text: 'second request', parentId: 'om_parent_2',
      updateTime: '1783530002600',
    }));

    assert.equal(codex.prompts.length, 3);
    assert.deepEqual(fetched, ['om_parent_1', 'om_parent_1', 'om_parent_2']);
    assert.match(codex.prompts[1] ?? '', /second request/);
    assert.match(codex.prompts[2] ?? '', /quote:om_parent_2/);
  } finally {
    store.close(); removeTempDir(dir);
  }
});

test('Router restores reply relationships when retrying a failed message', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-quote-retry');
  const store = new Store(dbPath, () => 19800);
  const reply = createFakeReply();
  const config = buildConfig({ features: { quoted_message: { enabled: true } } }, {});
  const ids: string[] = [];
  let runs = 0;
  const runner: CodexChatRunnerLike = {
    async run(): Promise<CodexChatResult> {
      runs += 1;
      if (runs === 1) throw new Error('temporary failure');
      return { sessionId: 'retry-session' };
    },
  };
  const router = new Router(
    createCommandRegistry(store),
    { async process(): Promise<AIResult> { throw new Error('digest should not run'); } },
    store, new Set<string>(), withoutStatusCards(reply.client), createFakeUrlFetcher(''), config.privacy,
    null, null, null, runner,
    { model: 'test', workdir: dir, sandbox: 'danger-full-access', skipGitRepoCheck: true },
    'codex_chat', null, { ids: [], names: [] }, null, null,
    new RuntimeConfigManager(config, () => config),
    { async fetch(messageId) { ids.push(messageId); return { messageId, text: 'quoted' }; } }
  );
  try {
    await router.handleEvent(textEvent({
      messageId: 'quote-retry-target', text: 'current', replyTo: 'om_retry_parent',
    }));
    assert.equal(store.getProcessingJob('quote-retry-target')?.status, 'failed');

    await router.handleEvent(textEvent({
      messageId: 'quote-retry-command', text: '/retry quote-retry-target',
    }));

    assert.deepEqual(ids, ['om_retry_parent', 'om_retry_parent']);
    assert.equal(runs, 2);
    assert.equal(store.getProcessingJob('quote-retry-target')?.status, 'replied');
  } finally {
    store.close(); removeTempDir(dir);
  }
});
