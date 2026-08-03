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
      parent_id?: string;
      reply_to?: string;
      root_id?: string;
      update_time?: string;
      updated?: boolean;
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
  parentId?: string;
  rootId?: string;
  /** Platform message/update time used to order competing control turns. */
  inputTimestamp?: number;
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
  | 'redo'
  | 'agent_session';

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
export type OutputTransport = 'card' | 'post';

export type PrivacyPattern = {
  name: string;
  pattern: string;
  replacement?: string;
};

export type PrivacyGroupRule = {
  chatId: string;
  allowUserIds: string[];
  allowAgentUserIds?: string[];
  contextEnabled: boolean;
  contextMaxMessages: number;
  contextMaxChars: number;
  features?: FeatureOverrides;
};

export type QuotedMessageFeatureConfig = {
  enabled: boolean;
  maxChars: number;
};

export type FeatureConfig = {
  quotedMessage: QuotedMessageFeatureConfig;
};

export type FeatureOverrides = {
  quotedMessage?: Partial<QuotedMessageFeatureConfig>;
};

export interface PrivacyConfig {
  allowChatIds: string[];
  denyChatIds: string[];
  allowUserIds: string[];
  denyUserIds: string[];
  adminUserIds?: string[];
  privateAllowUserIds?: string[] | null;
  groups?: PrivacyGroupRule[];
  skipPatterns: PrivacyPattern[];
  redactPatterns: PrivacyPattern[];
}

export interface AppConfig {
  features: FeatureConfig;
  output: {
    transport: OutputTransport;
  };
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
    editPolling: {
      enabled: boolean;
      chatIds: string[];
      as: FeishuIdentity;
      intervalMs: number;
      pageSize: number;
    };
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
