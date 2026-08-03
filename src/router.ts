import type {
  FeishuEvent,
  FeishuMention,
  MessageContent,
  CommandHandler,
  AIResult,
  ProcessingMode,
  PrivacyConfig,
  OutputTransport,
} from './types.js';
import crypto from 'node:crypto';
import type { Store } from './store.js';
import { replyToMessage, replyError, replyText, type StatusCardParams } from './reply.js';
import type { ReactionEmoji } from './reaction.js';
import {
  DEFAULT_PRIVACY_CONFIG,
  evaluateContentPrivacy,
  evaluateMessagePrivacy,
  canRunAgent,
  findPrivacyGroupRule,
  isPrivacyAdmin,
  redactForLog,
} from './privacy.js';
import {
  formatGroupContextPrompt,
  parseGroupContextRequest,
  type GroupContextProvider,
} from './group-context.js';
import {
  extractUrls,
  fetchAllUrls,
  fetchAllUrlDetails,
  formatFetchedUrlDetails,
  type FetchedUrl,
} from './fetcher.js';
import { extractAttachments, type AttachmentDownloader } from './attachments.js';
import type { AttachmentExtractor } from './attachment-extractor.js';
import type { AnswerResult } from './ai/answer-processor.js';
import {
  CodexChatInterruptedError,
  clearCodexSession,
  isCodexChatInterruptedError,
  runCodexChat,
  type CodexChunkMeta,
  type CodexChatOptions,
  type CodexChatResult,
} from './ai/codex-chat.js';
import { deactivateControlSession } from './control-sessions.js';
import {
  buildAskPrompt,
  DEFAULT_ASK_EVIDENCE_LIMIT,
  formatAskAnswer,
  formatNoEvidenceAnswer,
  getAskEvidence,
} from './qa.js';
import { AgentSessionIntentController, type AgentSessionIntentResult } from './agent-session-intent.js';
import { HeadlessAgentRunner } from './headless-agent-runner.js';
import { MESSAGE_RECEIVE_EVENT, MESSAGE_UPDATED_EVENTS } from './listener.js';
import {
  resolveQuotedMessageFeature,
  type RuntimeConfigSnapshot,
  type RuntimeConfigSource,
} from './runtime-config.js';
import {
  formatQuotedMessagePrompt,
  normalizeDirectParentId,
  selectQuotedMessageId,
  type QuotedMessageProvider,
} from './quoted-message.js';

type AIPipelineLike = {
  process(text: string): Promise<AIResult>;
};

type AnswerPipelineLike = {
  answer(text: string): Promise<AnswerResult>;
};

export type CodexChatRunnerLike = {
  run(
    prompt: string,
    options: CodexChatOptions,
    onChunk: (text: string, meta?: CodexChunkMeta) => Promise<void>
  ): Promise<CodexChatResult>;
};

export type DefaultMessageMode = 'digest' | 'codex_chat';

export type BotMentionConfig = {
  ids: string[];
  names: string[];
};

export type ReplyClient = {
  replyToMessage(messageId: string, result: AIResult): Promise<void>;
  replyError(messageId: string): Promise<void>;
  replyText(messageId: string, text: string): Promise<void>;
  replyStatusCard?(messageId: string, params: StatusCardParams): Promise<string | null>;
  updateStatusCard?(messageId: string, params: StatusCardParams): Promise<void>;
};

export type ReactionClient = {
  addReaction(messageId: string, emojiType: ReactionEmoji): Promise<void>;
};

export type AgentSessionIntentControllerLike = {
  handle(message: MessageContent): Promise<AgentSessionIntentResult | null>;
  hasPendingConfirmation?(message: MessageContent): boolean;
};

export type UrlFetcher = {
  extractUrls(text: string): string[];
  fetchAllUrls(urls: string[]): Promise<string>;
  fetchAllUrlDetails?(urls: string[]): Promise<FetchedUrl[]>;
};

const defaultReplyClient: ReplyClient = {
  replyToMessage,
  replyError,
  replyText,
};

const defaultUrlFetcher: UrlFetcher = {
  extractUrls,
  fetchAllUrls,
  fetchAllUrlDetails,
};

const defaultCodexChatRunner: CodexChatRunnerLike = {
  run: runCodexChat,
};

const ADMIN_COMMANDS = new Set([
  'new', 'detail', 'reload', 'retry', 'redo', 'retag', 'merge-tag',
  'errors', 'sessions', 'agent-sessions', 'backup', 'export', 'cleanup', 'output',
]);

const STATUS_CARD_UPDATE_INTERVAL_MS = 1000;
const STATUS_CARD_RUNNING_OUTPUT_CHARS = 3500;
const STATUS_CARD_FINAL_OUTPUT_CHARS = 6000;

type CodexStatusCardHandle = {
  messageId: string;
  startedAt: number;
  stop(): void;
  markOutputStarted(): Promise<void>;
  appendOutput(chunk: string, continuation?: boolean): Promise<void>;
  finish(sessionId: string | null): Promise<string | null>;
  interrupt(reason: string): Promise<string | null>;
  fail(error: Error): Promise<string | null>;
};

type ActiveCodexTurn = {
  messageId: string;
  controller: AbortController;
  inputTimestamp: number;
};

export class Router {
  private commands: Map<string, CommandHandler>;
  private aiPipeline: AIPipelineLike;
  private store: Store;
  private inFlight: Set<string>;
  private replyClient: ReplyClient;
  private reactionClient: ReactionClient | null;
  private urlFetcher: UrlFetcher;
  private privacy: PrivacyConfig;
  private attachmentDownloader: AttachmentDownloader | null;
  private attachmentExtractor: AttachmentExtractor | null;
  private answerPipeline: AnswerPipelineLike | null;
  private codexChatRunner: CodexChatRunnerLike;
  private codexChatOptions: Omit<CodexChatOptions, 'sessionKey'>;
  private defaultMessageMode: DefaultMessageMode;
  private botMentionConfig: BotMentionConfig;
  private activeCodexTurns = new Map<string, ActiveCodexTurn>();
  private latestCodexInputTimestamps = new Map<string, number>();
  private agentSessionIntentController: AgentSessionIntentControllerLike | null;
  private groupContextProvider: GroupContextProvider | null;
  private runtimeConfigSource: RuntimeConfigSource | null;
  private quotedMessageProvider: QuotedMessageProvider | null;

  constructor(
    commands: Map<string, CommandHandler>,
    aiPipeline: AIPipelineLike,
    store: Store,
    inFlight: Set<string>,
    replyClient: ReplyClient = defaultReplyClient,
    urlFetcher: UrlFetcher = defaultUrlFetcher,
    privacy: PrivacyConfig = DEFAULT_PRIVACY_CONFIG,
    attachmentDownloader: AttachmentDownloader | null = null,
    attachmentExtractor: AttachmentExtractor | null = null,
    answerPipeline: AnswerPipelineLike | null = null,
    codexChatRunner: CodexChatRunnerLike = defaultCodexChatRunner,
    codexChatOptions: Omit<CodexChatOptions, 'sessionKey'> = {
      model: process.env.CODEX_MODEL ?? '',
      workdir: process.env.DOUJIE_CODEX_WORKDIR ?? process.cwd(),
      sandbox: 'workspace-write',
      skipGitRepoCheck: process.env.DOUJIE_CODEX_SKIP_GIT_REPO_CHECK === 'true',
    },
    defaultMessageMode: DefaultMessageMode = 'digest',
    reactionClient: ReactionClient | null = null,
    botMentionConfig: BotMentionConfig = { ids: [], names: [] },
    agentSessionIntentController: AgentSessionIntentControllerLike | null = new AgentSessionIntentController(new HeadlessAgentRunner()),
    groupContextProvider: GroupContextProvider | null = null,
    runtimeConfigSource: RuntimeConfigSource | null = null,
    quotedMessageProvider: QuotedMessageProvider | null = null
  ) {
    this.commands = commands;
    this.aiPipeline = aiPipeline;
    this.store = store;
    this.inFlight = inFlight;
    this.replyClient = replyClient;
    this.reactionClient = reactionClient;
    this.urlFetcher = urlFetcher;
    this.privacy = privacy;
    this.attachmentDownloader = attachmentDownloader;
    this.attachmentExtractor = attachmentExtractor;
    this.answerPipeline = answerPipeline;
    this.codexChatRunner = codexChatRunner;
    this.codexChatOptions = codexChatOptions;
    this.defaultMessageMode = defaultMessageMode;
    this.botMentionConfig = botMentionConfig;
    this.agentSessionIntentController = agentSessionIntentController;
    this.groupContextProvider = groupContextProvider;
    this.runtimeConfigSource = runtimeConfigSource;
    this.quotedMessageProvider = quotedMessageProvider;
  }

  async handleEvent(event: FeishuEvent): Promise<void> {
    const runtimeSnapshot = this.runtimeConfigSource?.getSnapshot() ?? null;
    const message = this.extractMessage(event);
    if (!message) return;

    const messageId = message.messageId;
    const privacyDecision = evaluateMessagePrivacy(message, event, this.privacy);
    const messageToSave =
      privacyDecision.action === 'skip'
        ? { ...message, text: privacyDecision.safeText, rawContent: privacyDecision.safeText }
        : { ...message, text: privacyDecision.text, rawContent: privacyDecision.rawContent };

    const eventType = event.header?.event_type ?? '';
    const isEditedMessage = this.isMessageUpdatedEvent(eventType);
    const quoteRelationshipAffectsVersion = runtimeSnapshot
      ? resolveQuotedMessageFeature(runtimeSnapshot, messageToSave.chatId).enabled
      : false;
    const contentVersionKey = this.getMessageContentVersionKey(
      messageToSave,
      quoteRelationshipAffectsVersion
    );
    if (isEditedMessage) {
      const versionKey = this.getMessageEventVersionKey(event, messageToSave);
      const existingContent = this.store.getMessageContent(messageId);
      const previousMessage = existingContent === null ? null : this.loadStoredMessageForComparison(messageId);
      const existingJob = existingContent === null ? null : this.store.getProcessingJob(messageId);
      const isRelationshipOnlyChange = Boolean(
        previousMessage &&
        !previousMessage.parentId &&
        messageToSave.parentId &&
        this.getMessageContentVersionKey(previousMessage, false) ===
          this.getMessageContentVersionKey(messageToSave, false)
      );
      if (existingContent !== null) {
        const isNewEventVersion = this.store.recordMessageEventVersion(messageId, eventType, versionKey);
        if (!isNewEventVersion) {
          console.log('[router] Duplicate message edit skipped:', messageId, versionKey);
          return;
        }
        const isNewContentVersion = this.store.recordMessageEventVersion(
          messageId,
          'message.content_v1',
          contentVersionKey
        );
        if (!isNewContentVersion) {
          if (isRelationshipOnlyChange) {
            this.store.saveEditedMessage({
              id: messageId,
              chatId: messageToSave.chatId,
              senderId: messageToSave.senderId,
              content: messageToSave.text,
              messageType: messageToSave.messageType,
              rawEvent: privacyDecision.rawEvent,
            });
            console.log('[router] Reply relationship enrichment stored without reprocessing:', messageId);
            return;
          }
          console.log('[router] Unchanged message edit skipped:', messageId, contentVersionKey);
          return;
        }
      }
      this.store.saveEditedMessage({
        id: messageId,
        chatId: messageToSave.chatId,
        senderId: messageToSave.senderId,
        content: messageToSave.text,
        messageType: messageToSave.messageType,
        rawEvent: privacyDecision.rawEvent,
      });
      if (existingContent === null) {
        this.store.recordMessageEventVersion(messageId, eventType, versionKey);
        this.store.recordMessageEventVersion(messageId, 'message.content_v1', contentVersionKey);
      }
      if (isRelationshipOnlyChange && existingJob) {
        console.log('[router] Reply relationship enrichment stored without reprocessing:', messageId);
        return;
      }
    } else {
      // Dedup check: try to save, skip if duplicate
      const saved = this.store.saveMessage({
        id: messageId,
        chatId: messageToSave.chatId,
        senderId: messageToSave.senderId,
        content: messageToSave.text,
        messageType: messageToSave.messageType,
        rawEvent: privacyDecision.rawEvent,
      });

      if (!saved) {
        console.log('[router] Duplicate message skipped:', messageId);
        return;
      }
      this.store.recordMessageEventVersion(messageId, 'message.content_v1', contentVersionKey);
    }

    if (!this.shouldProcessMessage(messageToSave)) {
      console.log(
        isEditedMessage
          ? '[router] Edited group message stored without bot mention:'
          : '[router] Group message stored without bot mention:',
        messageId
      );
      return;
    }

    this.store.createProcessingJob(messageId);
    this.inFlight.add(messageId);
    if (privacyDecision.action === 'skip') {
      await this.handlePrivacySkippedMessage(messageToSave, privacyDecision.reason);
      return;
    }
    await this.downloadAndStoreAttachments(messageToSave);
    await this.processMessage(messageToSave, 'default', runtimeSnapshot);
  }

  async retryMessage(
    messageId: string,
    runtimeSnapshot: RuntimeConfigSnapshot | null = this.runtimeConfigSource?.getSnapshot() ?? null,
    requestedAt = Date.now()
  ): Promise<boolean> {
    const prepared = this.store.prepareRetry(messageId);
    if (!prepared) {
      return false;
    }

    const rawEvent = this.store.getMessageRawEvent(messageId);
    if (!rawEvent) {
      this.store.markFailed(messageId, 'retry', 'Stored raw event not found');
      return false;
    }

    let event: FeishuEvent;
    try {
      event = JSON.parse(rawEvent) as FeishuEvent;
    } catch (err) {
      this.store.markFailed(messageId, 'retry', `Stored raw event is invalid: ${(err as Error).message}`);
      return false;
    }

    const message = this.extractMessage(event);
    if (!message) {
      this.store.markFailed(messageId, 'retry', 'Stored raw event does not contain a message');
      return false;
    }

    this.inFlight.add(messageId);
    await this.processMessage({ ...message, inputTimestamp: requestedAt }, 'retry', runtimeSnapshot);
    return true;
  }

  private async processMessage(
    message: MessageContent,
    mode: ProcessingMode = 'default',
    runtimeSnapshot: RuntimeConfigSnapshot | null = null
  ): Promise<void> {
    const messageId = message.messageId;
    try {
      if (this.isCommand(message.text)) {
        await this.handleCommand(message, runtimeSnapshot);
      } else if (await this.handleGroupContextRequest(message, runtimeSnapshot)) {
        return;
      } else if (!canRunAgent(message, this.privacy)) {
        await this.replyClient.replyText(message.messageId, '你可以使用本群允许的上下文总结功能，但没有权限调度 Codex Agent。');
        this.store.markPrivacySkipped(message.messageId, 'privacy_skip:agent_not_allowed');
        return;
      } else if (await this.handleAgentSessionIntent(message)) {
        return;
      } else {
        await this.handleDefault(message, mode, runtimeSnapshot);
      }
    } catch (err) {
      console.error('[router] Error processing message:', this.redactLog((err as Error).message));
      const job = this.store.getProcessingJob(messageId);
      this.store.markFailed(messageId, job?.stage ?? 'unknown', (err as Error).message);
      try {
        await this.replyClient.replyError(messageId);
      } catch {
        console.error('[router] Failed to send error reply');
      }
    } finally {
      this.inFlight.delete(messageId);
    }
  }

  private async handlePrivacySkippedMessage(message: MessageContent, reason: string): Promise<void> {
    try {
      await this.replyClient.replyText(message.messageId, `Skipped by privacy rule: ${reason}`);
      this.store.markPrivacySkipped(message.messageId, reason);
    } catch (err) {
      this.store.markFailed(message.messageId, 'privacy_skip', this.redactLog((err as Error).message));
      try {
        await this.replyClient.replyError(message.messageId);
      } catch {
        console.error('[router] Failed to send error reply');
      }
    } finally {
      this.inFlight.delete(message.messageId);
    }
  }

  private async downloadAndStoreAttachments(message: MessageContent): Promise<void> {
    if (!this.attachmentDownloader) return;
    const attachments = extractAttachments(message);
    for (const attachment of attachments) {
      const result = await this.attachmentDownloader.download(message.messageId, attachment);
      this.store.saveAttachment({
        messageId: message.messageId,
        resourceKey: attachment.resourceKey,
        resourceType: attachment.resourceType,
        fileName: attachment.fileName,
        mime: attachment.mime,
        size: attachment.size,
        downloadStatus: result.status,
        localPath: result.status === 'downloaded' ? result.localPath : null,
        error: result.status === 'failed' ? result.error : null,
      });
      if (result.status === 'downloaded') {
        await this.extractAndStoreAttachmentText(message.messageId, attachment.resourceKey);
      }
    }
  }

  /** Check if text starts with a command (e.g., /help, /search) but not a URL */
  private isCommand(text: string): boolean {
    // Match / followed by a word character (letter/digit/underscore), not //
    return /^\/[a-zA-Z0-9_]/.test(text) && !text.startsWith('//');
  }

  private isMessageUpdatedEvent(eventType: string): boolean {
    return eventType !== MESSAGE_RECEIVE_EVENT && MESSAGE_UPDATED_EVENTS.includes(eventType as typeof MESSAGE_UPDATED_EVENTS[number]);
  }

  private getMessageEventVersionKey(event: FeishuEvent, message: MessageContent): string {
    const updateTime = extractFirstString(event, ['update_time', 'updateTime', 'updated_at', 'updatedAt']);
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify({
        text: message.text,
        rawContent: message.rawContent,
        mentions: message.mentions,
        parentId: message.parentId,
        rootId: message.rootId,
      }))
      .digest('hex')
      .slice(0, 24);
    return updateTime ? `update:${updateTime}:hash:${hash}` : `hash:${hash}`;
  }

  private getMessageContentVersionKey(message: MessageContent, includeQuoteRelationship = true): string {
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify({
        messageType: message.messageType,
        text: message.text,
        addressedToBot: this.hasBotMention(message),
        ...(includeQuoteRelationship ? {
          quoteRelationshipId: selectQuotedMessageId(message.parentId, message.rootId),
        } : {}),
      }))
      .digest('hex')
      .slice(0, 24);
    return `hash:${hash}`;
  }

  private extractMessage(event: FeishuEvent): MessageContent | null {
    const msg = event.event?.message;
    if (!msg) return null;

    let text = '';
    const rawContent = msg.content;

    try {
      const parsed = JSON.parse(rawContent) as Record<string, unknown>;
      if (msg.message_type === 'text') {
        text = (parsed.text as string) || '';
      } else {
        // For non-text messages, use the raw JSON as content
        text = `[${msg.message_type}] ${rawContent}`;
      }
    } catch {
      text = rawContent;
    }

    const mentions = this.extractMentions(msg, rawContent);
    const parentId = normalizeDirectParentId(msg.parent_id, msg.reply_to);
    const isEditedMessage = this.isMessageUpdatedEvent(event.header?.event_type ?? '');
    const parsedInputTimestamp = normalizeFeishuTimestamp(
      isEditedMessage ? msg.update_time : event.header?.create_time
    );
    const message: MessageContent = {
      messageId: msg.message_id,
      chatId: msg.chat_id,
      chatType: msg.chat_type,
      senderId: event.event?.sender?.sender_id?.open_id || msg.sender?.sender_id?.open_id || 'unknown',
      messageType: msg.message_type,
      text,
      rawContent,
      mentions,
      ...(parentId ? { parentId } : {}),
      ...(typeof msg.root_id === 'string' && msg.root_id.trim() ? { rootId: msg.root_id.trim() } : {}),
      ...(parsedInputTimestamp !== null ? { inputTimestamp: parsedInputTimestamp } : {}),
    };
    return {
      ...message,
      text: this.stripBotMentionText(message),
    };
  }

  private shouldProcessMessage(message: MessageContent): boolean {
    if (!this.isGroupChat(message.chatType)) return true;
    return this.hasBotMention(message) || Boolean(this.agentSessionIntentController?.hasPendingConfirmation?.(message));
  }

  private isGroupChat(chatType: string): boolean {
    return chatType === 'group';
  }

  private hasBotMention(message: MessageContent): boolean {
    if (message.mentions.length === 0) return false;
    const hasConfiguredMatcher = this.botMentionConfig.ids.length > 0 || this.botMentionConfig.names.length > 0;
    if (!hasConfiguredMatcher) return true;
    return message.mentions.some((mention) => this.isConfiguredBotMention(mention));
  }

  private isConfiguredBotMention(mention: FeishuMention): boolean {
    const configuredIds = new Set(this.botMentionConfig.ids.map((id) => id.trim()).filter(Boolean));
    const configuredNames = new Set(this.botMentionConfig.names.map(normalizeMentionName).filter(Boolean));
    return (
      this.extractMentionIds(mention).some((id) => configuredIds.has(id)) ||
      this.extractMentionNames(mention).some((name) => configuredNames.has(normalizeMentionName(name)))
    );
  }

  private stripBotMentionText(message: MessageContent): string {
    if (!this.isGroupChat(message.chatType) || !this.hasBotMention(message)) return message.text;
    let text = message.text;
    for (const mention of message.mentions) {
      if (!this.isConfiguredBotMention(mention) && (this.botMentionConfig.ids.length > 0 || this.botMentionConfig.names.length > 0)) {
        continue;
      }
      for (const key of [mention.key, ...this.extractMentionNames(mention).map((name) => `@${name}`)]) {
        if (!key) continue;
        text = text.split(key).join('');
      }
    }
    return text.replace(/<at\b[^>]*>.*?<\/at>/g, '').replace(/\s+/g, ' ').trim();
  }

  private extractMentions(
    message: FeishuEvent['event']['message'],
    rawContent: string
  ): FeishuMention[] {
    const candidates: unknown[] = [];
    if (Array.isArray(message.mentions)) {
      candidates.push(...message.mentions);
    }
    try {
      const parsed = JSON.parse(rawContent) as Record<string, unknown>;
      if (Array.isArray(parsed.mentions)) {
        candidates.push(...parsed.mentions);
      }
    } catch {
      // Ignore invalid content JSON; text extraction already falls back to raw content.
    }
    return candidates.filter(isMention);
  }

  private extractMentionIds(mention: FeishuMention): string[] {
    const ids: string[] = [];
    if (typeof mention.id === 'string') ids.push(mention.id);
    if (typeof mention.id === 'object' && mention.id !== null) {
      for (const value of [mention.id.open_id, mention.id.user_id, mention.id.union_id, mention.id.app_id]) {
        if (value) ids.push(value);
      }
    }
    for (const value of [mention.open_id, mention.user_id, mention.union_id, mention.app_id]) {
      if (value) ids.push(value);
    }
    return ids;
  }

  private extractMentionNames(mention: FeishuMention): string[] {
    return [mention.name, mention.key?.startsWith('@') ? mention.key.slice(1) : undefined]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }

  private async handleCommand(
    message: MessageContent,
    runtimeSnapshot: RuntimeConfigSnapshot | null
  ): Promise<void> {
    this.store.markProcessing(message.messageId, 'command');
    this.store.setProcessingMode(message.messageId, 'command');
    const parsed = this.parseCommand(message.text);
    const commandName = parsed?.name;
    const args = parsed?.args ?? '';

    if (!commandName) return;

    if (ADMIN_COMMANDS.has(commandName) && !isPrivacyAdmin(message.senderId, this.privacy)) {
      await this.replyClient.replyText(message.messageId, `/${commandName} 仅管理员可用。`);
      this.store.markPrivacySkipped(message.messageId, 'privacy_skip:admin_required');
      return;
    }
    if ((commandName === 'codex' || commandName === 'digest' || commandName === 'ask') && !canRunAgent(message, this.privacy)) {
      await this.replyClient.replyText(message.messageId, `/${commandName} 需要 Agent 调度权限。`);
      this.store.markPrivacySkipped(message.messageId, 'privacy_skip:agent_not_allowed');
      return;
    }

    if (commandName === 'retry') {
      await this.handleRetryCommand(message, args, runtimeSnapshot);
      return;
    }

    if (commandName === 'output') {
      await this.handleOutputCommand(message, args);
      return;
    }

    if (commandName === 'save') {
      await this.handleSaveCommand(message, args);
      return;
    }

    if (commandName === 'digest') {
      await this.handleDigestCommand(message, args);
      return;
    }

    if (commandName === 'skip') {
      await this.handleSkipCommand(message, args);
      return;
    }

    if (commandName === 'redo') {
      await this.handleRedoCommand(message, args);
      return;
    }

    if (commandName === 'retag') {
      await this.handleRetagCommand(message, args);
      return;
    }

    if (commandName === 'merge-tag') {
      await this.handleMergeTagCommand(message, args);
      return;
    }

    if (commandName === 'ask') {
      await this.handleAskCommand(message, args);
      return;
    }

    if (commandName === 'new') {
      await this.handleNewCommand(message, args, runtimeSnapshot);
      return;
    }

    if (commandName === 'detail') {
      await this.handleCodexCommand(message, args, true, undefined, undefined, runtimeSnapshot);
      return;
    }

    if (commandName === 'codex') {
      const detailArgs = this.extractDetailPrompt(args);
      await this.handleCodexCommand(message, detailArgs.prompt, detailArgs.detailed, undefined, undefined, runtimeSnapshot);
      return;
    }

    const handler = this.commands.get(commandName);
    if (handler) {
      const result = await handler(args, message);
      await this.replyClient.replyText(message.messageId, result);
      this.store.markReplied(message.messageId);
    } else {
      await this.replyClient.replyText(
        message.messageId,
        `Unknown command: /${commandName}. Use /help to see available commands.`
      );
      this.store.markReplied(message.messageId);
    }
  }

  private async handleAgentSessionIntent(message: MessageContent): Promise<boolean> {
    if (!this.agentSessionIntentController) return false;
    if (!isPrivacyAdmin(message.senderId, this.privacy)) {
      const pending = this.agentSessionIntentController.hasPendingConfirmation?.(message) ?? false;
      if (pending || /(codex|claude|agent|session|会话)/iu.test(message.text)) {
        await this.replyClient.replyText(message.messageId, '项目 Agent 创建和恢复仅管理员可用。');
        this.store.markPrivacySkipped(message.messageId, 'privacy_skip:admin_required');
        return true;
      }
      return false;
    }
    const result = await this.agentSessionIntentController.handle(message);
    if (!result) return false;
    this.store.setProcessingMode(message.messageId, 'agent_session');
    this.store.markProcessing(message.messageId, 'agent_session');
    await this.replyClient.replyText(message.messageId, result.text);
    this.store.markReplied(message.messageId);
    return true;
  }

  private async handleGroupContextRequest(
    message: MessageContent,
    runtimeSnapshot: RuntimeConfigSnapshot | null
  ): Promise<boolean> {
    if (message.chatType !== 'group' || !this.groupContextProvider) return false;
    const request = parseGroupContextRequest(message.text);
    if (!request) return false;
    const rule = findPrivacyGroupRule(message.chatId, this.privacy);
    if (!rule?.contextEnabled) return false;

    this.store.setProcessingMode(message.messageId, 'codex_chat');
    this.store.markProcessing(message.messageId, 'group_context_fetch');
    const messages = await this.groupContextProvider.fetch(message.chatId, rule, request);
    const filtered = messages.filter((item) => item.messageId !== message.messageId);
    if (filtered.length === 0) {
      await this.replyClient.replyText(message.messageId, '没有读取到可用于总结的群聊上下文。');
      this.store.markReplied(message.messageId);
      return true;
    }
    const prompt = formatGroupContextPrompt(message.text, filtered, rule.contextMaxChars);
    await this.handleCodexCommand(
      message,
      prompt,
      false,
      'read-only',
      `context:${message.chatId}:${message.messageId}`,
      runtimeSnapshot
    );
    return true;
  }

  private parseCommand(text: string): { name: string; args: string } | null {
    const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) return null;
    return {
      name: match[1].toLowerCase(),
      args: match[2] ?? '',
    };
  }

  private async handleRetryCommand(
    message: MessageContent,
    args: string,
    runtimeSnapshot: RuntimeConfigSnapshot | null
  ): Promise<void> {
    const retryMessageId = args.trim();
    if (!retryMessageId) {
      await this.replyClient.replyText(message.messageId, 'Usage: /retry <message_id>');
      this.store.markReplied(message.messageId);
      return;
    }
    const retried = await this.retryMessage(retryMessageId, runtimeSnapshot, message.inputTimestamp ?? Date.now());
    await this.replyClient.replyText(
      message.messageId,
      retried ? `Retry started for ${retryMessageId}.` : `Cannot retry ${retryMessageId}: job is not failed or does not exist.`
    );
    this.store.markReplied(message.messageId);
  }

  private async handleSaveCommand(message: MessageContent, args: string): Promise<void> {
    const text = args.trim();
    if (!text) {
      await this.replyClient.replyText(message.messageId, 'Usage: /save <text>');
      this.store.markReplied(message.messageId);
      return;
    }

    this.store.setProcessingMode(message.messageId, 'save');
    this.store.updateMessageContent(message.messageId, text);
    this.store.markProcessing(message.messageId, 'save');
    await this.replyClient.replyText(message.messageId, `Saved ${text.length} characters without AI digest.`);
    this.store.markReplied(message.messageId);
  }

  private async handleDigestCommand(message: MessageContent, args: string): Promise<void> {
    const text = args.trim();
    if (!text) {
      await this.replyClient.replyText(message.messageId, 'Usage: /digest <text>');
      this.store.markReplied(message.messageId);
      return;
    }

    this.store.updateMessageContent(message.messageId, text);
    await this.runDigest({ ...message, text }, text, 'digest', true);
  }

  private async handleSkipCommand(message: MessageContent, args: string): Promise<void> {
    const reason = args.trim();
    this.store.setProcessingMode(message.messageId, 'skip');
    this.store.markProcessing(message.messageId, 'skip');
    await this.replyClient.replyText(
      message.messageId,
      reason ? `Skipped processing. Reason: ${reason}` : 'Skipped processing.'
    );
    this.store.markReplied(message.messageId);
  }

  private async handleRedoCommand(message: MessageContent, args: string): Promise<void> {
    const targetMessageId = args.trim();
    if (!targetMessageId) {
      await this.replyClient.replyText(message.messageId, 'Usage: /redo <message_id>');
      this.store.markReplied(message.messageId);
      return;
    }

    const prepared = this.store.prepareRedo(targetMessageId);
    if (!prepared) {
      await this.replyClient.replyText(
        message.messageId,
        `Cannot redo ${targetMessageId}: job is active or does not exist.`
      );
      this.store.markReplied(message.messageId);
      return;
    }

    const targetMessage = this.loadStoredMessage(targetMessageId, 'redo');
    if (!targetMessage) {
      await this.replyClient.replyText(message.messageId, `Cannot redo ${targetMessageId}: stored message is unavailable.`);
      this.store.markReplied(message.messageId);
      return;
    }

    try {
      const result = await this.runDigest(targetMessage, targetMessage.text, 'redo', false);
      await this.replyClient.replyText(
        message.messageId,
        result ? `Redo complete for ${targetMessageId}.` : `Redo skipped for ${targetMessageId} by privacy rule.`
      );
      this.store.markReplied(message.messageId);
    } catch (err) {
      const job = this.store.getProcessingJob(targetMessageId);
      this.store.markFailed(targetMessageId, job?.stage ?? 'redo', (err as Error).message);
      await this.replyClient.replyText(message.messageId, `Redo failed for ${targetMessageId}: ${(err as Error).message}`);
      this.store.markReplied(message.messageId);
    }
  }

  private async handleRetagCommand(message: MessageContent, args: string): Promise<void> {
    const [targetMessageId, ...tagParts] = args.trim().split(/\s+/).filter(Boolean);
    const tags = this.parseTags(tagParts.join(' '));
    if (!targetMessageId || tags.length === 0) {
      await this.replyClient.replyText(message.messageId, 'Usage: /retag <message_id> <tag...>');
      this.store.markReplied(message.messageId);
      return;
    }

    const result = this.store.retagMessage(targetMessageId, tags, `retag:${message.messageId}`);
    if (!result.updated) {
      await this.replyClient.replyText(message.messageId, `Cannot retag ${targetMessageId}: processed message not found.`);
      this.store.markReplied(message.messageId);
      return;
    }

    await this.replyClient.replyText(
      message.messageId,
      `Retagged ${targetMessageId}: ${result.previousTags.join(', ') || '(none)'} -> ${result.newTags.join(', ')}`
    );
    this.store.markReplied(message.messageId);
  }

  private async handleMergeTagCommand(message: MessageContent, args: string): Promise<void> {
    const [alias, canonicalTag, ...extra] = args.trim().split(/\s+/).filter(Boolean);
    if (!alias || !canonicalTag || extra.length > 0) {
      await this.replyClient.replyText(message.messageId, 'Usage: /merge-tag <from> <to>');
      this.store.markReplied(message.messageId);
      return;
    }

    const result = this.store.mergeTag(alias, canonicalTag);
    if (!result.alias || !result.canonicalTag || result.alias === result.canonicalTag) {
      await this.replyClient.replyText(message.messageId, 'Usage: /merge-tag <from> <to> with different tags');
      this.store.markReplied(message.messageId);
      return;
    }

    await this.replyClient.replyText(
      message.messageId,
      `Merged tag ${result.alias} -> ${result.canonicalTag}. Updated ${result.updatedMessages} message(s).`
    );
    this.store.markReplied(message.messageId);
  }

  private async handleAskCommand(message: MessageContent, args: string): Promise<void> {
    const question = args.trim();
    if (!question) {
      await this.replyClient.replyText(message.messageId, 'Usage: /ask <question>');
      this.store.markReplied(message.messageId);
      return;
    }
    if (!this.answerPipeline) {
      throw new Error('Answer pipeline is not configured');
    }

    this.store.markProcessing(message.messageId, 'ask_search');
    const evidence = getAskEvidence(this.store, question, DEFAULT_ASK_EVIDENCE_LIMIT, message.messageId);
    if (evidence.length === 0) {
      await this.replyClient.replyText(message.messageId, formatNoEvidenceAnswer(question));
      this.store.markReplied(message.messageId);
      return;
    }

    let prompt = buildAskPrompt(question, evidence);
    const contentPrivacy = evaluateContentPrivacy(prompt, this.privacy);
    if (contentPrivacy.action === 'skip') {
      await this.replyClient.replyText(message.messageId, `Skipped by privacy rule: ${contentPrivacy.reason}`);
      this.store.markPrivacySkipped(message.messageId, contentPrivacy.reason);
      return;
    }
    if (contentPrivacy.action === 'redact') {
      prompt = contentPrivacy.text;
    }

    this.store.markProcessing(message.messageId, 'ask_codex');
    const result = await this.answerPipeline.answer(prompt);
    this.store.markProcessing(message.messageId, 'reply');
    await this.replyClient.replyText(message.messageId, formatAskAnswer(question, result, evidence));
    this.store.markReplied(message.messageId);
  }

  private extractDetailPrompt(args: string): { detailed: boolean; prompt: string } {
    const trimmed = args.trim();
    if (trimmed === '/detail') {
      return { detailed: true, prompt: '' };
    }
    if (trimmed.startsWith('/detail ')) {
      return { detailed: true, prompt: trimmed.slice('/detail'.length).trimStart() };
    }
    return { detailed: false, prompt: trimmed };
  }

  private async handleOutputCommand(message: MessageContent, args: string): Promise<void> {
    const requested = args.trim().toLowerCase();
    const current = this.runtimeConfigSource?.getSnapshot().config.output.transport ?? 'card';
    if (!requested || requested === 'status') {
      await this.replyClient.replyText(
        message.messageId,
        `当前输出模式：**${formatOutputTransport(current)}**。\n\n使用 \`/output post\` 或 \`/output card\` 切换；配置 \`output.transport\` 决定重启后的默认值。`
      );
      this.store.markReplied(message.messageId);
      return;
    }
    if (requested !== 'card' && requested !== 'post') {
      await this.replyClient.replyText(message.messageId, 'Usage: /output <status|post|card>');
      this.store.markReplied(message.messageId);
      return;
    }
    if (!this.runtimeConfigSource?.setOutputTransport) {
      await this.replyClient.replyText(message.messageId, '运行时输出模式切换未配置。');
      this.store.markReplied(message.messageId);
      return;
    }
    const snapshot = this.runtimeConfigSource.setOutputTransport(requested);
    await this.replyClient.replyText(
      message.messageId,
      `输出模式已切换为 **${formatOutputTransport(snapshot.config.output.transport)}**，从下一条任务开始生效。`
    );
    this.store.markReplied(message.messageId);
  }

  private async handleNewCommand(
    message: MessageContent,
    args: string,
    runtimeSnapshot: RuntimeConfigSnapshot | null
  ): Promise<void> {
    const sessionKey = this.getCodexSessionKey(message);
    if (this.isStaleCodexTurn(sessionKey, message.inputTimestamp)) {
      console.warn('[router] Stale /new generation skipped:', message.messageId);
      this.store.markReplied(message.messageId);
      return;
    }
    this.recordCodexInputTimestamp(sessionKey, message.inputTimestamp);
    this.interruptActiveCodexTurn(sessionKey);
    clearCodexSession(sessionKey, this.codexChatOptions.stateFile);
    deactivateControlSession(sessionKey, this.codexChatOptions.controlSessionDir);
    const prompt = args.trim();
    if (!prompt) {
      await this.replyClient.replyText(message.messageId, '已切换到新的 Codex session。下一条消息会使用新会话。');
      this.store.markReplied(message.messageId);
      return;
    }

    await this.replyClient.replyText(message.messageId, '已切换到新的 Codex session。');
    await this.handleCodexCommand(message, prompt, false, undefined, undefined, runtimeSnapshot);
  }

  private async handleCodexCommand(
    message: MessageContent,
    args: string,
    detailed: boolean,
    sandboxOverride?: CodexChatOptions['sandbox'],
    sessionKeyOverride?: string,
    runtimeSnapshot: RuntimeConfigSnapshot | null = this.runtimeConfigSource?.getSnapshot() ?? null
  ): Promise<void> {
    const prompt = args.trim();
    if (!prompt) {
      await this.replyClient.replyText(message.messageId, detailed ? 'Usage: /detail <prompt>' : 'Usage: /codex <prompt>');
      this.store.markReplied(message.messageId);
      return;
    }

    this.store.setProcessingMode(message.messageId, 'codex_chat');
    this.store.markProcessing(message.messageId, 'codex_chat');
    const sessionKey = sessionKeyOverride ?? this.getCodexSessionKey(message);
    const turn = this.startCodexTurn(sessionKey, message.messageId, message.inputTimestamp);
    if (!turn) {
      console.warn('[router] Stale message generation skipped:', message.messageId);
      this.store.markReplied(message.messageId);
      return;
    }
    await this.addStatusReaction(message.messageId, 'THINKING');
    const outputTransport = runtimeSnapshot?.config.output.transport ?? 'card';
    let fallbackOutput = '';
    let postChunksSent = 0;
    let pendingPostOutput = '';
    const flushPostOutput = async (): Promise<void> => {
      if (!pendingPostOutput) return;
      const output = pendingPostOutput;
      await this.replyClient.replyText(message.messageId, output);
      pendingPostOutput = '';
      postChunksSent += 1;
    };
    const statusCard = await this.createCodexStatusCard(
      message.messageId,
      detailed,
      outputTransport === 'card'
    );
    try {
      const result = await this.codexChatRunner.run(
        prompt,
        {
          ...this.codexChatOptions,
          ...(sandboxOverride ? { sandbox: sandboxOverride } : {}),
          sessionKey,
          outputMode: detailed ? 'detail' : 'answer',
          abortSignal: turn.controller.signal,
        },
        async (chunk: string, meta?: CodexChunkMeta): Promise<void> => {
          if (turn.controller.signal.aborted) {
            throw new CodexChatInterruptedError();
          }
          if (outputTransport === 'post') {
            await statusCard?.markOutputStarted();
            if (meta?.continuation) {
              pendingPostOutput += chunk;
            } else {
              await flushPostOutput();
              pendingPostOutput = chunk;
            }
          } else if (statusCard) {
            await statusCard.appendOutput(chunk, meta?.continuation);
          } else {
            fallbackOutput = appendOutputChunk(fallbackOutput, chunk, meta?.continuation);
          }
        }
      );

      this.store.markProcessing(message.messageId, 'reply');
      if (outputTransport === 'post') {
        await flushPostOutput();
        if (postChunksSent === 0) {
          await this.replyClient.replyText(message.messageId, 'Codex 没有返回可显示内容。');
        }
        await statusCard?.finish(result.sessionId);
      } else if (statusCard) {
        const overflow = await statusCard.finish(result.sessionId);
        if (overflow) await this.replyClient.replyText(message.messageId, overflow);
      } else {
        await this.replyClient.replyText(message.messageId, fallbackOutput || 'Codex 没有返回可显示内容。');
      }
      await this.addStatusReaction(message.messageId, 'DONE');
    } catch (err) {
      if (isCodexChatInterruptedError(err) || turn.controller.signal.aborted) {
        statusCard?.stop();
        if (outputTransport === 'post') {
          await flushPostOutput().catch((replyErr: Error) => {
            console.error('[router] Failed to flush Post output after interrupt:', replyErr.message);
          });
        }
        let interruptCardUpdated = false;
        if (statusCard) {
          try {
            const overflow = await statusCard.interrupt('被同一会话中的新消息打断。');
            if (overflow) await this.replyClient.replyText(message.messageId, overflow);
            interruptCardUpdated = true;
          } catch (cardErr) {
            console.error('[router] Failed to update status card after interrupt:', (cardErr as Error).message);
          }
        } else if (outputTransport === 'card' && fallbackOutput) {
          await this.replyClient.replyText(
            message.messageId,
            `${fallbackOutput}\n\n---\n\n已被新消息打断，正在处理最新消息。`
          ).then(() => {
            interruptCardUpdated = true;
          }).catch((replyErr: Error) => {
            console.error('[router] Failed to send fallback output after interrupt:', replyErr.message);
          });
        }
        this.store.markProcessing(message.messageId, 'interrupted');
        await this.addStatusReaction(message.messageId, 'ERROR');
        if (!interruptCardUpdated) {
          await this.replyClient.replyText(message.messageId, '已被新消息打断，正在处理最新消息。').catch((replyErr: Error) => {
            console.error('[router] Failed to send interrupt notice:', replyErr.message);
          });
        }
        this.store.markReplied(message.messageId);
        return;
      }
      statusCard?.stop();
      if (outputTransport === 'post') {
        await flushPostOutput().catch((replyErr: Error) => {
          console.error('[router] Failed to flush Post output after error:', replyErr.message);
        });
      } else if (!statusCard && fallbackOutput) {
        await this.replyClient.replyText(message.messageId, fallbackOutput).catch((replyErr: Error) => {
          console.error('[router] Failed to send fallback output after error:', replyErr.message);
        });
      }
      let errorCardUpdated = false;
      if (statusCard) {
        try {
          const overflow = await statusCard.fail(err as Error);
          if (overflow) await this.replyClient.replyText(message.messageId, overflow);
          errorCardUpdated = true;
        } catch (cardErr) {
          console.error('[router] Failed to update status card after error:', (cardErr as Error).message);
        }
      }
      await this.addStatusReaction(message.messageId, 'ERROR');
      if (errorCardUpdated) {
        this.store.markFailed(message.messageId, 'codex_chat', (err as Error).message);
        return;
      }
      throw err;
    } finally {
      this.finishCodexTurn(sessionKey, turn);
    }
    this.store.markReplied(message.messageId);
  }

  private startCodexTurn(
    sessionKey: string,
    messageId: string,
    inputTimestamp?: number
  ): ActiveCodexTurn | null {
    if (this.isStaleCodexTurn(sessionKey, inputTimestamp)) {
      return null;
    }
    this.interruptActiveCodexTurn(sessionKey);
    const turn = { messageId, controller: new AbortController(), inputTimestamp: inputTimestamp ?? Date.now() };
    this.recordCodexInputTimestamp(sessionKey, turn.inputTimestamp);
    this.activeCodexTurns.set(sessionKey, turn);
    return turn;
  }

  private isStaleCodexTurn(sessionKey: string, inputTimestamp?: number): boolean {
    const active = this.activeCodexTurns.get(sessionKey);
    if (active && inputTimestamp === undefined) return true;
    const latest = this.latestCodexInputTimestamps.get(sessionKey);
    return inputTimestamp !== undefined && latest !== undefined && inputTimestamp < latest;
  }

  private recordCodexInputTimestamp(sessionKey: string, inputTimestamp?: number): void {
    const timestamp = inputTimestamp ?? Date.now();
    const latest = this.latestCodexInputTimestamps.get(sessionKey);
    if (latest === undefined || timestamp > latest) this.latestCodexInputTimestamps.set(sessionKey, timestamp);
  }

  private interruptActiveCodexTurn(sessionKey: string): void {
    const active = this.activeCodexTurns.get(sessionKey);
    if (!active || active.controller.signal.aborted) return;
    console.log('[router] Interrupting active Codex chat:', active.messageId);
    active.controller.abort();
  }

  private finishCodexTurn(sessionKey: string, turn: ActiveCodexTurn): void {
    if (this.activeCodexTurns.get(sessionKey) === turn) {
      this.activeCodexTurns.delete(sessionKey);
    }
  }

  private getCodexSessionKey(message: MessageContent): string {
    if (this.isGroupChat(message.chatType)) return message.chatId;
    return `${message.chatId}:${message.senderId}`;
  }

  private async createCodexStatusCard(
    messageId: string,
    detailed: boolean,
    includeOutput: boolean
  ): Promise<CodexStatusCardHandle | null> {
    if (!this.replyClient.replyStatusCard || !this.replyClient.updateStatusCard) {
      return null;
    }

    const startedAt = Date.now();
    let dots = 1;
    let stage = '启动 Codex session';
    let stopped = false;
    let output = '';
    let externalOutputStarted = false;
    let lastPatchedOutput = '';
    let lastPatchedStage = stage;
    let lastPatchAt = 0;
    let scheduledUpdate: NodeJS.Timeout | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let updateQueue = Promise.resolve();
    const buildParams = (): StatusCardParams => ({
      state: output ? 'working' : 'thinking',
      stage,
      elapsedMs: Date.now() - startedAt,
      dots,
      detail: includeOutput
        ? (detailed ? '详细模式：展示 Agent 事件与工具输出。' : '中间结果会在本卡片中持续更新。')
        : '过程与结果会以 Markdown 消息持续发送。',
      ...buildBoundedCardOutput(output, STATUS_CARD_RUNNING_OUTPUT_CHARS),
    });

    let statusMessageId: string | null = null;
    try {
      statusMessageId = await this.replyClient.replyStatusCard(messageId, buildParams());
    } catch (err) {
      console.error('[router] Failed to send status card:', (err as Error).message);
      return null;
    }
    if (!statusMessageId) {
      console.error('[router] Status card reply did not return message_id');
      return null;
    }
    const updateStatusCard = this.replyClient.updateStatusCard;

    const patch = async (force = false): Promise<void> => {
      if (stopped || !updateStatusCard || (!force && output === lastPatchedOutput && stage === lastPatchedStage)) return;
      dots = dots >= 3 ? 1 : dots + 1;
      const snapshot = output;
      await retryStatusCardUpdate(() => updateStatusCard(statusMessageId, buildParams()));
      lastPatchedOutput = snapshot;
      lastPatchedStage = stage;
      lastPatchAt = Date.now();
    };
    const enqueuePatch = (force = false): Promise<void> => {
      updateQueue = updateQueue.then(() => patch(force)).catch((err: Error) => {
        console.error('[router] Failed to update status card:', err.message);
      });
      return updateQueue;
    };
    const schedulePatch = (): Promise<void> => {
      const waitMs = Math.max(0, STATUS_CARD_UPDATE_INTERVAL_MS - (Date.now() - lastPatchAt));
      if (waitMs === 0) return enqueuePatch();
      if (!scheduledUpdate) {
        scheduledUpdate = setTimeout(() => {
          scheduledUpdate = null;
          void enqueuePatch();
        }, waitMs);
      }
      return Promise.resolve();
    };
    const stop = (): void => {
      stopped = true;
      if (scheduledUpdate) clearTimeout(scheduledUpdate);
      if (heartbeat) clearInterval(heartbeat);
      scheduledUpdate = null;
      heartbeat = null;
    };
    heartbeat = setInterval(() => {
      void enqueuePatch(true);
    }, 2000);

    return {
      messageId: statusMessageId,
      startedAt,
      stop,
      async markOutputStarted(): Promise<void> {
        if (stopped || stage === 'Agent 正在输出') return;
        externalOutputStarted = true;
        stage = 'Agent 正在输出';
        await schedulePatch();
      },
      async appendOutput(chunk: string, continuation = false): Promise<void> {
        if (stopped) return;
        output = appendOutputChunk(output, chunk, continuation);
        stage = 'Agent 正在输出';
        await schedulePatch();
      },
      async finish(sessionId: string | null): Promise<string | null> {
        if (scheduledUpdate) clearTimeout(scheduledUpdate);
        scheduledUpdate = null;
        await enqueuePatch();
        stop();
        if (!updateStatusCard) return includeOutput ? (output || 'Codex 没有返回可显示内容。') : null;
        const bounded = buildBoundedCardOutput(output, STATUS_CARD_FINAL_OUTPUT_CHARS);
        try {
          await retryStatusCardUpdate(() => updateStatusCard(statusMessageId, {
            state: 'done',
            title: '豆姐完成了',
            stage: includeOutput
              ? (output ? (bounded.outputTruncated ? '完成，完整结果见后续消息' : '结果已完整写入') : '没有可显示输出')
              : (externalOutputStarted ? '结果已通过 Markdown 发送' : '没有可显示输出'),
            elapsedMs: Date.now() - startedAt,
            sessionId,
            ...bounded,
          }));
        } catch (err) {
          console.error('[router] Failed to finalize status card:', (err as Error).message);
          return includeOutput ? (output || 'Codex 没有返回可显示内容。') : null;
        }
        return bounded.outputTruncated ? output : null;
      },
      async interrupt(reason: string): Promise<string | null> {
        stop();
        if (!updateStatusCard) return output || null;
        await updateQueue;
        const bounded = buildBoundedCardOutput(output, STATUS_CARD_FINAL_OUTPUT_CHARS);
        try {
          await retryStatusCardUpdate(() => updateStatusCard(statusMessageId, {
            state: 'error',
            title: '豆姐已中断',
            stage: bounded.outputTruncated ? '被新消息打断，完整的已产生输出见后续消息' : '被新消息打断',
            elapsedMs: Date.now() - startedAt,
            detail: reason,
            ...bounded,
          }));
        } catch (err) {
          if (output) return `任务已被新消息打断。以下是中断前已产生的输出：\n\n${output}`;
          throw err;
        }
        return bounded.outputTruncated ? output : null;
      },
      async fail(error: Error): Promise<string | null> {
        stop();
        if (!updateStatusCard) return output || null;
        await updateQueue;
        const bounded = buildBoundedCardOutput(output, STATUS_CARD_FINAL_OUTPUT_CHARS);
        try {
          await retryStatusCardUpdate(() => updateStatusCard(statusMessageId, {
            state: 'error',
            title: '豆姐处理失败',
            stage: bounded.outputTruncated ? 'Agent 执行失败，完整的已产生输出见后续消息' : 'Agent 执行失败',
            elapsedMs: Date.now() - startedAt,
            detail: error.message,
            ...bounded,
          }));
        } catch (err) {
          if (output) return `Agent 执行失败：${error.message}\n\n以下是失败前已产生的输出：\n\n${output}`;
          throw err;
        }
        return bounded.outputTruncated ? output : null;
      },
    };
  }

  private async addStatusReaction(messageId: string, emojiType: ReactionEmoji): Promise<void> {
    if (!this.reactionClient) return;
    try {
      await this.reactionClient.addReaction(messageId, emojiType);
    } catch (err) {
      console.error('[router] Failed to add reaction:', emojiType, this.redactLog((err as Error).message));
    }
  }

  private parseTags(input: string): string[] {
    return input
      .split(/[\s,，、]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  private async handleDefault(
    message: MessageContent,
    mode: ProcessingMode = 'default',
    runtimeSnapshot: RuntimeConfigSnapshot | null = null
  ): Promise<void> {
    if (this.defaultMessageMode === 'codex_chat') {
      console.log('[router] Processing with Codex chat:', message.messageId);
      const prompt = await this.prepareDefaultCodexPrompt(message, runtimeSnapshot);
      if (prompt !== null) {
        await this.handleCodexCommand(message, prompt, false, undefined, undefined, runtimeSnapshot);
      }
      return;
    }

    console.log('[router] Processing with AI:', message.messageId);
    await this.runDigest(message, message.text, mode, true);
  }

  private async prepareDefaultCodexPrompt(
    message: MessageContent,
    runtimeSnapshot: RuntimeConfigSnapshot | null
  ): Promise<string | null> {
    let prompt = await this.addQuotedMessageContext(message, runtimeSnapshot);
    const attachmentText = this.formatExtractedAttachmentText(message.messageId);
    if (attachmentText) {
      prompt = `${prompt}\n\n--- 以下为附件内容 ---\n\n${attachmentText}`;
    }

    const urls = this.urlFetcher.extractUrls(message.text);
    if (urls.length > 0) {
      console.log(`[router] Found ${urls.length} URL(s), fetching content for Codex chat...`);
      this.store.markProcessing(message.messageId, 'fetch_url');
      const fetchedContent = await this.fetchAndStoreUrls(message.messageId, urls);
      prompt = `${prompt}\n\n--- 以下为链接内容 ---\n\n${fetchedContent}`;
    }

    const contentPrivacy = evaluateContentPrivacy(prompt, this.privacy);
    if (contentPrivacy.action === 'skip') {
      await this.replyClient.replyText(message.messageId, `Skipped by privacy rule: ${contentPrivacy.reason}`);
      this.store.markPrivacySkipped(message.messageId, contentPrivacy.reason);
      return null;
    }
    if (contentPrivacy.action === 'redact') {
      prompt = contentPrivacy.text;
    }

    return prompt;
  }

  private async addQuotedMessageContext(
    message: MessageContent,
    runtimeSnapshot: RuntimeConfigSnapshot | null
  ): Promise<string> {
    if (!runtimeSnapshot || !this.quotedMessageProvider) return message.text;
    const feature = resolveQuotedMessageFeature(runtimeSnapshot, message.chatId);
    if (!feature.enabled) return message.text;
    let relationshipId = selectQuotedMessageId(message.parentId, message.rootId);
    if (!message.parentId && this.quotedMessageProvider.resolveRelationship) {
      try {
        const relationship = await this.quotedMessageProvider.resolveRelationship(message.messageId);
        if (relationship?.parentId) message.parentId = relationship.parentId;
        if (relationship?.rootId) message.rootId = relationship.rootId;
        relationshipId = selectQuotedMessageId(message.parentId, message.rootId);
        if (relationshipId && this.persistResolvedRelationship(message)) {
          this.store.recordMessageEventVersion(
            message.messageId,
            'message.content_v1',
            this.getMessageContentVersionKey(message, true)
          );
        }
      } catch {
        console.warn('[router] Quoted-message relationship lookup failed; using current message only.');
        return message.text;
      }
    }
    if (!relationshipId) return message.text;

    try {
      const quoted = await this.quotedMessageProvider.fetch(relationshipId);
      if (!quoted) return message.text;
      return formatQuotedMessagePrompt(message.text, quoted.text, feature.maxChars);
    } catch {
      console.warn('[router] Quoted-message lookup failed; using current message only.');
      return message.text;
    }
  }

  private async runDigest(
    message: MessageContent,
    inputText: string,
    mode: ProcessingMode,
    sendSummaryReply: boolean
  ): Promise<AIResult | null> {
    this.store.setProcessingMode(message.messageId, mode);
    // If message contains URLs, fetch article content first
    let textForAI = inputText;
    const attachmentText = this.formatExtractedAttachmentText(message.messageId);
    if (attachmentText) {
      textForAI = `${textForAI}\n\n--- 以下为附件内容 ---\n\n${attachmentText}`;
    }
    const urls = this.urlFetcher.extractUrls(inputText);
    if (urls.length > 0) {
      console.log(`[router] Found ${urls.length} URL(s), fetching content...`);
      this.store.markProcessing(message.messageId, 'fetch_url');
      const fetchedContent = await this.fetchAndStoreUrls(message.messageId, urls);
      textForAI = `${textForAI}\n\n--- 以下为链接内容 ---\n\n${fetchedContent}`;
    }

    const contentPrivacy = evaluateContentPrivacy(textForAI, this.privacy);
    if (contentPrivacy.action === 'skip') {
      if (sendSummaryReply) {
        await this.replyClient.replyText(message.messageId, `Skipped by privacy rule: ${contentPrivacy.reason}`);
      }
      this.store.markPrivacySkipped(message.messageId, contentPrivacy.reason);
      return null;
    }
    if (contentPrivacy.action === 'redact') {
      textForAI = contentPrivacy.text;
    }

    const tagPromptContext = this.store.getTagPromptContext();
    if (tagPromptContext) {
      textForAI = `${tagPromptContext}\n\n--- Message ---\n${textForAI}`;
    }

    this.store.markProcessing(message.messageId, 'codex');
    const aiResult = await this.aiPipeline.process(textForAI);

    // Store processed result
    this.store.markProcessing(message.messageId, 'store_processed');
    this.store.saveProcessed({
      id: `${message.messageId}-processed`,
      messageId: message.messageId,
      summary: aiResult.summary,
      tags: aiResult.tags,
      keyPoints: aiResult.keyPoints,
      actionItems: aiResult.actionItems,
      entities: aiResult.entities,
      sourceType: aiResult.sourceType,
      confidence: aiResult.confidence,
      schemaVersion: aiResult.schemaVersion,
      processedAt: Date.now(),
    });
    this.store.markProcessed(message.messageId);

    if (sendSummaryReply) {
      // Reply with formatted result
      this.store.markProcessing(message.messageId, 'reply');
      await this.replyClient.replyToMessage(message.messageId, aiResult);
      this.store.markReplied(message.messageId);
    }

    return aiResult;
  }

  private redactLog(text: string): string {
    return redactForLog(text, this.privacy);
  }

  private async fetchAndStoreUrls(messageId: string, urls: string[]): Promise<string> {
    if (!this.urlFetcher.fetchAllUrlDetails) {
      return this.urlFetcher.fetchAllUrls(urls);
    }

    const details = await this.urlFetcher.fetchAllUrlDetails(urls);
    details.forEach((detail, index) => {
      this.store.saveSourceForMessage(messageId, detail, index);
    });
    return formatFetchedUrlDetails(details);
  }

  private async extractAndStoreAttachmentText(messageId: string, resourceKey: string): Promise<void> {
    if (!this.attachmentExtractor) return;
    const attachment = this.store
      .getAttachmentsForMessage(messageId)
      .find((row) => row.resourceKey === resourceKey);
    if (!attachment || attachment.downloadStatus !== 'downloaded') return;

    try {
      const result = await this.attachmentExtractor.extract(attachment);
      this.store.updateAttachmentExtraction(messageId, resourceKey, {
        status: result.status,
        text: result.status === 'extracted' ? result.text : null,
        error: result.status === 'extracted' ? null : result.error,
      });
    } catch (err) {
      this.store.updateAttachmentExtraction(messageId, resourceKey, {
        status: 'failed',
        text: null,
        error: (err as Error).message,
      });
    }
  }

  private formatExtractedAttachmentText(messageId: string): string {
    const attachments = this.store.getExtractedAttachmentText(messageId);
    return attachments
      .map((attachment, index) => {
        const name = attachment.fileName ?? 'unknown';
        return `[附件 ${index + 1}: ${name}]\n${attachment.text}`;
      })
      .join('\n\n');
  }

  private loadStoredMessage(messageId: string, stage: string): MessageContent | null {
    const rawEvent = this.store.getMessageRawEvent(messageId);
    if (!rawEvent) {
      this.store.markFailed(messageId, stage, 'Stored raw event not found');
      return null;
    }

    let event: FeishuEvent;
    try {
      event = JSON.parse(rawEvent) as FeishuEvent;
    } catch (err) {
      this.store.markFailed(messageId, stage, `Stored raw event is invalid: ${(err as Error).message}`);
      return null;
    }

    const message = this.extractMessage(event);
    if (!message) {
      this.store.markFailed(messageId, stage, 'Stored raw event does not contain a message');
      return null;
    }

    return {
      ...message,
      text: this.store.getMessageContent(messageId) ?? message.text,
    };
  }

  private loadStoredMessageForComparison(messageId: string): MessageContent | null {
    const rawEvent = this.store.getMessageRawEvent(messageId);
    if (!rawEvent) return null;
    try {
      return this.extractMessage(JSON.parse(rawEvent) as FeishuEvent);
    } catch {
      return null;
    }
  }

  private persistResolvedRelationship(message: MessageContent): boolean {
    const rawEvent = this.store.getMessageRawEvent(message.messageId);
    if (!rawEvent) return false;
    try {
      const event = JSON.parse(rawEvent) as FeishuEvent;
      const storedMessage = event.event?.message;
      if (!storedMessage) return false;
      if (message.parentId) storedMessage.parent_id = message.parentId;
      if (message.rootId) storedMessage.root_id = message.rootId;
      return this.store.updateMessageRawEvent(message.messageId, JSON.stringify(event));
    } catch {
      return false;
    }
  }
}

function appendOutputChunk(current: string, chunk: string, continuation = false): string {
  if (!chunk) return current;
  if (continuation) return `${current}${chunk}`;
  return current ? `${current}\n\n${chunk}` : chunk;
}

function normalizeFeishuTimestamp(value: string | undefined): number | null {
  let timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  if (timestamp >= 1e17) timestamp /= 1e6;
  else if (timestamp >= 1e14) timestamp /= 1e3;
  else if (timestamp >= 1e8 && timestamp < 1e11) timestamp *= 1e3;
  return timestamp;
}

function formatOutputTransport(transport: OutputTransport): string {
  return transport === 'post' ? 'Post Markdown 分段' : '动态状态卡';
}

function buildBoundedCardOutput(
  output: string,
  maxChars: number
): Pick<StatusCardParams, 'output' | 'outputTruncated'> {
  const characters = [...output];
  if (characters.length <= maxChars) return output ? { output } : {};
  const fenceRepairReserve = 12;
  let start = characters.length - Math.max(1, maxChars - fenceRepairReserve);
  const nearbyNewline = characters.slice(start, Math.min(characters.length, start + 200)).indexOf('\n');
  if (nearbyNewline >= 0) start += nearbyNewline + 1;

  const omittedPrefix = characters.slice(0, start).join('');
  const retainedTail = characters.slice(start).join('');
  const startsInsideFence = countMarkdownCodeFences(omittedPrefix) % 2 === 1;
  const endsInsideFence = (countMarkdownCodeFences(retainedTail) + Number(startsInsideFence)) % 2 === 1;
  const repairedTail = [
    startsInsideFence ? '```text\n' : '',
    retainedTail,
    endsInsideFence ? '\n```' : '',
  ].join('');
  return {
    output: repairedTail,
    outputTruncated: true,
  };
}

function countMarkdownCodeFences(content: string): number {
  return [...content.matchAll(/(?:^|\n)[ \t]{0,3}`{3,}(?=[^`]|$)/g)].length;
}

async function retryStatusCardUpdate(update: () => Promise<void>): Promise<void> {
  try {
    await update();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await update();
  }
}

function normalizeMentionName(name: string): string {
  return name.replace(/^@+/, '').trim().toLowerCase();
}

function isMention(value: unknown): value is FeishuMention {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractFirstString(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractFirstString(item, keys);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = record[key];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    if (typeof direct === 'number') return String(direct);
  }
  for (const child of Object.values(record)) {
    const found = extractFirstString(child, keys);
    if (found) return found;
  }
  return null;
}
