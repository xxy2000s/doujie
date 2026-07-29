import type {
  FeishuEvent,
  FeishuMention,
  MessageContent,
  CommandHandler,
  AIResult,
  ProcessingMode,
  PrivacyConfig,
} from './types.js';
import type { Store } from './store.js';
import { replyToMessage, replyError, replyText } from './reply.js';
import type { ReactionEmoji } from './reaction.js';
import {
  DEFAULT_PRIVACY_CONFIG,
  evaluateContentPrivacy,
  evaluateMessagePrivacy,
  redactForLog,
} from './privacy.js';
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
  clearCodexSession,
  runCodexChat,
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
    onChunk: (text: string) => Promise<void>
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
};

export type ReactionClient = {
  addReaction(messageId: string, emojiType: ReactionEmoji): Promise<void>;
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
      workdir: process.env.DOUJIE_CODEX_WORKDIR ?? process.env.INFOHUNTER_CODEX_WORKDIR ?? process.cwd(),
      sandbox: 'workspace-write',
      skipGitRepoCheck:
        process.env.DOUJIE_CODEX_SKIP_GIT_REPO_CHECK === 'true' ||
        process.env.INFOHUNTER_CODEX_SKIP_GIT_REPO_CHECK === 'true',
    },
    defaultMessageMode: DefaultMessageMode = 'digest',
    reactionClient: ReactionClient | null = null,
    botMentionConfig: BotMentionConfig = { ids: [], names: [] }
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
  }

  async handleEvent(event: FeishuEvent): Promise<void> {
    const message = this.extractMessage(event);
    if (!message) return;

    const messageId = message.messageId;
    const privacyDecision = evaluateMessagePrivacy(message, event, this.privacy);
    const messageToSave =
      privacyDecision.action === 'skip'
        ? { ...message, text: privacyDecision.safeText, rawContent: privacyDecision.safeText }
        : { ...message, text: privacyDecision.text, rawContent: privacyDecision.rawContent };

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

    if (!this.shouldProcessMessage(messageToSave)) {
      console.log('[router] Group message stored without bot mention:', messageId);
      return;
    }

    this.store.createProcessingJob(messageId);
    this.inFlight.add(messageId);
    if (privacyDecision.action === 'skip') {
      await this.handlePrivacySkippedMessage(messageToSave, privacyDecision.reason);
      return;
    }
    await this.downloadAndStoreAttachments(messageToSave);
    await this.processMessage(messageToSave);
  }

  async retryMessage(messageId: string): Promise<boolean> {
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
    await this.processMessage(message, 'retry');
    return true;
  }

  private async processMessage(message: MessageContent, mode: ProcessingMode = 'default'): Promise<void> {
    const messageId = message.messageId;
    try {
      if (this.isCommand(message.text)) {
        await this.handleCommand(message);
      } else {
        await this.handleDefault(message, mode);
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
    const message: MessageContent = {
      messageId: msg.message_id,
      chatId: msg.chat_id,
      chatType: msg.chat_type,
      senderId: event.event?.sender?.sender_id?.open_id || msg.sender?.sender_id?.open_id || 'unknown',
      messageType: msg.message_type,
      text,
      rawContent,
      mentions,
    };
    return {
      ...message,
      text: this.stripBotMentionText(message),
    };
  }

  private shouldProcessMessage(message: MessageContent): boolean {
    if (!this.isGroupChat(message.chatType)) return true;
    return this.hasBotMention(message);
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

  private async handleCommand(message: MessageContent): Promise<void> {
    this.store.markProcessing(message.messageId, 'command');
    this.store.setProcessingMode(message.messageId, 'command');
    const parsed = this.parseCommand(message.text);
    const commandName = parsed?.name;
    const args = parsed?.args ?? '';

    if (!commandName) return;

    if (commandName === 'retry') {
      await this.handleRetryCommand(message, args);
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
      await this.handleNewCommand(message, args);
      return;
    }

    if (commandName === 'detail') {
      await this.handleCodexCommand(message, args, true);
      return;
    }

    if (commandName === 'codex') {
      const detailArgs = this.extractDetailPrompt(args);
      await this.handleCodexCommand(message, detailArgs.prompt, detailArgs.detailed);
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

  private parseCommand(text: string): { name: string; args: string } | null {
    const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) return null;
    return {
      name: match[1].toLowerCase(),
      args: match[2] ?? '',
    };
  }

  private async handleRetryCommand(message: MessageContent, args: string): Promise<void> {
    const retryMessageId = args.trim();
    if (!retryMessageId) {
      await this.replyClient.replyText(message.messageId, 'Usage: /retry <message_id>');
      this.store.markReplied(message.messageId);
      return;
    }
    const retried = await this.retryMessage(retryMessageId);
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

  private async handleNewCommand(message: MessageContent, args: string): Promise<void> {
    const sessionKey = this.getCodexSessionKey(message);
    clearCodexSession(sessionKey, this.codexChatOptions.stateFile);
    deactivateControlSession(sessionKey, this.codexChatOptions.controlSessionDir);
    const prompt = args.trim();
    if (!prompt) {
      await this.replyClient.replyText(message.messageId, '已切换到新的 Codex session。下一条消息会使用新会话。');
      this.store.markReplied(message.messageId);
      return;
    }

    await this.replyClient.replyText(message.messageId, '已切换到新的 Codex session。');
    await this.handleCodexCommand(message, prompt, false);
  }

  private async handleCodexCommand(message: MessageContent, args: string, detailed: boolean): Promise<void> {
    const prompt = args.trim();
    if (!prompt) {
      await this.replyClient.replyText(message.messageId, detailed ? 'Usage: /detail <prompt>' : 'Usage: /codex <prompt>');
      this.store.markReplied(message.messageId);
      return;
    }

    this.store.setProcessingMode(message.messageId, 'codex_chat');
    this.store.markProcessing(message.messageId, 'codex_chat');
    await this.addStatusReaction(message.messageId, 'THINKING');
    if (detailed) {
      await this.replyClient.replyText(message.messageId, 'Codex 已开始处理。');
    }

    let chunksSent = 0;
    try {
      const result = await this.codexChatRunner.run(
        prompt,
        {
          ...this.codexChatOptions,
          sessionKey: this.getCodexSessionKey(message),
          outputMode: detailed ? 'detail' : 'answer',
        },
        async (chunk: string): Promise<void> => {
          chunksSent += 1;
          await this.replyClient.replyText(message.messageId, chunk);
        }
      );

      this.store.markProcessing(message.messageId, 'reply');
      if (detailed) {
        await this.replyClient.replyText(
          message.messageId,
          result.sessionId ? `Codex 任务结束。session: ${result.sessionId}` : 'Codex 任务结束。'
        );
      } else if (chunksSent === 0) {
        await this.replyClient.replyText(message.messageId, 'Codex 没有返回可显示内容。');
      }
      await this.addStatusReaction(message.messageId, 'DONE');
    } catch (err) {
      await this.addStatusReaction(message.messageId, 'ERROR');
      throw err;
    }
    this.store.markReplied(message.messageId);
  }

  private getCodexSessionKey(message: MessageContent): string {
    if (this.isGroupChat(message.chatType)) return message.chatId;
    return `${message.chatId}:${message.senderId}`;
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

  private async handleDefault(message: MessageContent, mode: ProcessingMode = 'default'): Promise<void> {
    if (this.defaultMessageMode === 'codex_chat') {
      console.log('[router] Processing with Codex chat:', message.messageId);
      const prompt = await this.prepareDefaultCodexPrompt(message);
      if (prompt !== null) {
        await this.handleCodexCommand(message, prompt, false);
      }
      return;
    }

    console.log('[router] Processing with AI:', message.messageId);
    await this.runDigest(message, message.text, mode, true);
  }

  private async prepareDefaultCodexPrompt(message: MessageContent): Promise<string | null> {
    let prompt = message.text;
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
}

function normalizeMentionName(name: string): string {
  return name.replace(/^@+/, '').trim().toLowerCase();
}

function isMention(value: unknown): value is FeishuMention {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
