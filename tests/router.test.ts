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

    assert.deepEqual(reply.texts.map((item) => item.text), ['chunk one', 'chunk two']);
    assert.equal(reply.statusCards.length, 1);
    assert.equal(reply.statusCards[0]?.messageId, 'codex-card-1');
    assert.equal(reply.statusCards[0]?.params.state, 'thinking');
    assert.equal(reply.statusUpdates.length, 1);
    assert.equal(reply.statusUpdates[0]?.messageId, 'card-codex-card-1');
    assert.equal(reply.statusUpdates[0]?.params.state, 'done');
    assert.equal(reply.statusUpdates[0]?.params.stage, '正文已发送完成');
    assert.equal('result' in reply.statusUpdates[0]!.params, false);
    assert.deepEqual(reaction.reactions, [
      { messageId: 'codex-card-1', emojiType: 'THINKING' },
      { messageId: 'codex-card-1', emojiType: 'DONE' },
    ]);
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
    assert.deepEqual(reply.texts.map((item) => item.text), ['chunk one', 'chunk two']);
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
    assert.deepEqual(
      reply.texts
        .map((item) => ({ messageId: item.messageId, text: item.text }))
        .sort((a, b) => a.messageId.localeCompare(b.messageId)),
      [
        { messageId: 'interrupt-1', text: '已被新消息打断，正在处理最新消息。' },
        { messageId: 'interrupt-2', text: 'reply for second task' },
      ]
    );
    assert.equal(reply.statusUpdates.find((item) => item.messageId === 'card-interrupt-1')?.params.stage, '被新消息打断');
    assert.equal(reply.statusUpdates.find((item) => item.messageId === 'card-interrupt-2')?.params.stage, '正文已发送完成');
    assert.deepEqual(reaction.reactions, [
      { messageId: 'interrupt-1', emojiType: 'THINKING' },
      { messageId: 'interrupt-2', emojiType: 'THINKING' },
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
    assert.deepEqual(reply.texts.map((item) => item.text), ['original reply']);
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
    assert.equal(
      reply.texts.filter((item) => item.text === '已被新消息打断，正在处理最新消息。').length,
      2
    );
    assert.equal(reply.texts.some((item) => item.text === 'third reply'), true);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test('Router handles /detail as a verbose Codex chat command', async () => {
  const { dir, dbPath } = createTempDbPath('doujie-router-detail');
  const store = new Store(dbPath, () => 1120);
  const reply = createFakeReply();
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
    assert.deepEqual(reply.texts.map((item) => item.text), [
      'Codex 已开始处理。',
      '[thread] started session-1',
      '[turn] started',
      'chunk one',
      'Codex 任务结束。session: session-1',
    ]);
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
