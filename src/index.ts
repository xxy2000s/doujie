import { loadConfig } from './config.js';
import { runStartupDoctor } from './doctor.js';
import { Store } from './store.js';
import { EventListener } from './listener.js';
import { EditedMessagePoller } from './edited-message-poller.js';
import { AIPipeline } from './ai/pipeline.js';
import { AnswerPipeline } from './ai/answer-pipeline.js';
import { Router } from './router.js';
import { AgentSessionIntentController } from './agent-session-intent.js';
import { HeadlessAgentRunner } from './headless-agent-runner.js';
import { createCommandRegistry, type CommandRuntime } from './commands/index.js';
import { replyError, replyStatusCard, replyText, replyToMessage, updateStatusCard, type StatusCardParams } from './reply.js';
import { addReaction, type ReactionEmoji } from './reaction.js';
import { DEFAULT_PRIVACY_CONFIG, redactForLog } from './privacy.js';
import { createLarkAttachmentDownloader } from './attachments.js';
import { createAttachmentExtractor } from './attachment-extractor.js';
import type { AIResult, FeishuEvent, PrivacyConfig } from './types.js';
import { LarkGroupContextProvider } from './group-context.js';
import { RuntimeConfigManager } from './runtime-config.js';
import { LarkQuotedMessageProvider } from './quoted-message.js';

let activePrivacyConfig: PrivacyConfig = DEFAULT_PRIVACY_CONFIG;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('[doujie] Starting...');

  // Initialize configuration
  const config = loadConfig();
  const runtimeConfigManager = new RuntimeConfigManager(config, loadConfig);
  activePrivacyConfig = config.privacy;
  console.log('[doujie] Config loaded');
  console.log('[doujie] Codex model:', config.codex.model);
  console.log('[doujie] Codex workdir:', config.codex.workdir);
  console.log('[doujie] DB path:', config.storage.dbPath);

  runStartupDoctor(config);
  console.log('[doujie] Startup doctor passed');

  // Initialize store
  const store = new Store(config.storage.dbPath);
  console.log('[doujie] Store initialized');

  // Initialize AI pipeline
  const aiPipeline = new AIPipeline(config.codex.model);
  const answerPipeline = new AnswerPipeline(config.codex.model);

  // Track in-flight messages for graceful shutdown
  const inFlight = new Set<string>();
  const runtime: CommandRuntime = {
    startedAt: Date.now(),
    inFlight,
    dbPath: config.storage.dbPath,
    backupDir: config.storage.backupDir,
    exportDir: config.storage.exportDir,
    controlSessionDir: config.codex.controlSessionDir,
    reloadConfig: () => runtimeConfigManager.reload(),
    getListenerStatus: () => ({ state: 'stopped' as const, lastEventAt: null, restartCount: 0 }),
  };
  const commands = createCommandRegistry(store, runtime);
  const replyClient = {
    replyToMessage: (messageId: string, result: AIResult): Promise<void> =>
      replyToMessage(messageId, result, config.feishu.as),
    replyError: (messageId: string): Promise<void> =>
      replyError(messageId, config.feishu.as),
    replyText: (messageId: string, text: string): Promise<void> =>
      replyText(messageId, text, config.feishu.as),
    replyStatusCard: (messageId: string, params: StatusCardParams): Promise<string | null> =>
      replyStatusCard(messageId, params, config.feishu.as),
    updateStatusCard: (messageId: string, params: StatusCardParams): Promise<void> =>
      updateStatusCard(messageId, params, config.feishu.as),
  };
  const reactionClient = {
    addReaction: (messageId: string, emojiType: ReactionEmoji): Promise<void> =>
      addReaction(messageId, emojiType, config.feishu.as),
  };

  // Initialize router
  const attachmentDownloader = createLarkAttachmentDownloader(config.storage.attachmentCacheDir, config.feishu.as);
  const attachmentExtractor = createAttachmentExtractor({ ocrCommand: config.attachments.ocrCommand });
  const agentSessionIntentController = new AgentSessionIntentController(
    new HeadlessAgentRunner(undefined, {
      codexSandbox: config.codex.sandbox,
      codexSkipGitRepoCheck: true,
    })
  );
  const router = new Router(
    commands,
    aiPipeline,
    store,
    inFlight,
    replyClient,
    undefined,
    config.privacy,
    attachmentDownloader,
    attachmentExtractor,
    answerPipeline,
    undefined,
    {
      model: config.codex.model,
      workdir: config.codex.workdir,
      sandbox: config.codex.sandbox,
      skipGitRepoCheck: config.codex.skipGitRepoCheck,
      controlSessionDir: config.codex.controlSessionDir,
    },
    'codex_chat',
    reactionClient,
    {
      ids: config.feishu.botMentionIds,
      names: config.feishu.botMentionNames,
    },
    agentSessionIntentController,
    new LarkGroupContextProvider('user'),
    runtimeConfigManager,
    new LarkQuotedMessageProvider('user')
  );

  // Event handler
  const eventHandler = (event: FeishuEvent): void => {
    router.handleEvent(event).catch((err: Error) => {
      console.error('[doujie] Unhandled error in event handler:', redactForLog(err.message, config.privacy));
    });
  };

  // Initialize listener
  const listener = new EventListener(eventHandler, config.feishu.chatIds, config.feishu.as);
  runtime.getListenerStatus = () => listener.getStatus();
  listener.start();
  console.log('[doujie] Listener started. Waiting for Feishu events...');

  const editedMessagePoller = config.feishu.editPolling.enabled
    ? new EditedMessagePoller(eventHandler, config.feishu.editPolling.chatIds, {
        feishuAs: config.feishu.editPolling.as,
        intervalMs: config.feishu.editPolling.intervalMs,
        pageSize: config.feishu.editPolling.pageSize,
      })
    : null;
  editedMessagePoller?.start();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('\n[doujie] Shutting down...');
    listener.stop();
    editedMessagePoller?.stop();

    // Wait for in-flight messages
    const timeout = setTimeout(() => {
      console.error(
        '[doujie] Shutdown timeout. Unfinished messages:',
        [...inFlight]
      );
      store.close();
      process.exit(1);
    }, 10000);

    while (inFlight.size > 0) {
      console.log(
        `[doujie] Waiting for ${inFlight.size} in-flight message(s)...`
      );
      await sleep(500);
    }

    clearTimeout(timeout);
    store.close();
    console.log('[doujie] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: Error) => {
  console.error('[doujie] Fatal error:', redactForLog(err.message, activePrivacyConfig));
  process.exit(1);
});
