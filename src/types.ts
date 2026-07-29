/**
 * Core type definitions for Doujie.
 */

/** Raw NDJSON event from lark-cli event +subscribe */
export interface FeishuEvent {
  schema: string;
  header: {
    event_id: string;
    event_type: string;
    create_time: string;
  };
  event: {
    sender?: {
      sender_id?: {
        open_id?: string;
      };
    };
    message: {
      message_id: string;
      chat_id: string;
      chat_type: string;
      sender?: { sender_id?: { open_id?: string } };
      message_type: string;
      content: string;
      mentions?: FeishuMention[];
    };
  };
}

export type FeishuMention = {
  key?: string;
  name?: string;
  id?: string | {
    open_id?: string;
    user_id?: string;
    union_id?: string;
    app_id?: string;
  };
  open_id?: string;
  user_id?: string;
  union_id?: string;
  app_id?: string;
};

/** Parsed and normalized message content */
export interface MessageContent {
  messageId: string;
  chatId: string;
  chatType: string;
  senderId: string;
  messageType: string;
  text: string;
  rawContent: string;
  mentions: FeishuMention[];
}

/** Result from AI processing (summary + classification) */
export interface AIResult {
  summary: string;
  tags: string[];
  keyPoints: string[];
  actionItems: string[];
  entities: string[];
  sourceType: string;
  confidence: number;
  schemaVersion: number;
}

/** Stored processed message record */
export interface ProcessedMessage {
  id: string;
  messageId: string;
  summary: string;
  tags: string[];
  keyPoints?: string[];
  actionItems?: string[];
  entities?: string[];
  sourceType?: string;
  confidence?: number;
  schemaVersion?: number;
  processedAt: number;
}

export type ProcessingStatus =
  | 'pending'
  | 'processing'
  | 'retrying'
  | 'processed'
  | 'replied'
  | 'failed';

export type ProcessingMode =
  | 'default'
  | 'command'
  | 'codex_chat'
  | 'save'
  | 'digest'
  | 'skip'
  | 'retry'
  | 'redo';

export interface ProcessingJob {
  messageId: string;
  status: ProcessingStatus;
  stage: string;
  mode: ProcessingMode;
  retryCount: number;
  lastError: string | null;
  lockedAt: number | null;
  completedAt: number | null;
  replySentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type SourceFetchStatus = 'fetched' | 'failed';

export interface SourceInput {
  originalUrl: string;
  canonicalUrl: string;
  finalUrl: string | null;
  domain: string;
  title: string | null;
  fetchStatus: SourceFetchStatus;
  contentLength: number;
  error: string | null;
}

export interface SourceRecord extends SourceInput {
  id: string;
  messageId?: string;
  position?: number;
  createdAt: number;
  updatedAt: number;
}

/** Command handler function signature */
export type CommandHandler = (
  args: string,
  message: MessageContent
) => Promise<string>;

export type CommandDefinition = {
  name: string;
  usage: string;
  description: string;
  handler: CommandHandler;
};

/** Application configuration */
export type FeishuIdentity = 'bot' | 'user';

export type PrivacyPattern = {
  name: string;
  pattern: string;
  replacement?: string;
};

export interface PrivacyConfig {
  allowChatIds: string[];
  denyChatIds: string[];
  allowUserIds: string[];
  denyUserIds: string[];
  skipPatterns: PrivacyPattern[];
  redactPatterns: PrivacyPattern[];
}

export interface AppConfig {
  codex: {
    model: string;
    workdir: string;
    sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
    skipGitRepoCheck: boolean;
    controlSessionDir: string;
  };
  feishu: {
    chatIds: string[];
    as: FeishuIdentity;
    botMentionIds: string[];
    botMentionNames: string[];
  };
  storage: {
    dbPath: string;
    backupDir: string;
    exportDir: string;
    attachmentCacheDir: string;
  };
  privacy: PrivacyConfig;
  attachments: {
    ocrCommand: string | null;
  };
}
