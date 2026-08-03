import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import type {
  AppConfig,
  FeatureOverrides,
  FeishuIdentity,
  OutputTransport,
  PrivacyPattern,
  QuotedMessageFeatureConfig,
} from './types.js';

export const CONFIG_DIR = path.join(os.homedir(), '.doujie');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');
const DEFAULT_DB_PATH = path.join(CONFIG_DIR, 'data.db');
const DEFAULT_BACKUP_DIR = path.join(CONFIG_DIR, 'backups');
const DEFAULT_EXPORT_DIR = path.join(CONFIG_DIR, 'exports');
const DEFAULT_ATTACHMENT_CACHE_DIR = path.join(CONFIG_DIR, 'attachments');
const DEFAULT_CONTROL_SESSION_DIR = path.join(CONFIG_DIR, 'sessions');
export const DEFAULT_QUOTED_MESSAGE_MAX_CHARS = 20000;
export const DEFAULT_QUOTED_MESSAGE_MAX_DEPTH = 1;
export const MAX_QUOTED_MESSAGE_DEPTH = 20;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Expand ~ to home directory in a path string */
function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function ensureConfigDir(configFile = CONFIG_FILE): void {
  const directory = path.dirname(configFile);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function loadYamlConfig(requireFile = false, configFile = CONFIG_FILE): Record<string, unknown> {
  ensureConfigDir(configFile);
  if (!fs.existsSync(configFile)) {
    if (requireFile) throw new ConfigError('config file is temporarily unavailable');
    return {};
  }
  const raw = fs.readFileSync(configFile, 'utf-8');
  if (requireFile && raw.trim().length === 0) {
    throw new ConfigError('config file is empty or incomplete');
  }
  const parsed = yaml.load(raw);
  if (parsed === undefined || parsed === null) {
    if (requireFile) throw new ConfigError('config file is empty or incomplete');
    return {};
  }
  if (typeof parsed === 'object' && !Array.isArray(parsed)) {
    const config = parsed as Record<string, unknown>;
    if (requireFile) validateRequiredFileShape(config);
    return config;
  }
  throw new ConfigError('config root must be an object');
}

function validateRequiredFileShape(config: Record<string, unknown>): void {
  if (Object.keys(config).length === 0) {
    throw new ConfigError('config file is empty or incomplete');
  }
  rejectExplicitNulls(config, 'config');
  const objectNodes = ['features', 'output', 'codex', 'feishu', 'storage', 'privacy', 'attachments'];
  for (const key of objectNodes) {
    if (Object.hasOwn(config, key)) validateObject(config[key], key);
  }
  validatePresentObjectNode(config.features, 'quoted_message', 'features.quoted_message');
  validatePresentObjectNode(config.feishu, 'edit_polling', 'feishu.edit_polling');
  validatePresentObjectNode(config.privacy, 'private', 'privacy.private');
}

function rejectExplicitNulls(value: unknown, label: string): void {
  if (value === null) {
    throw new ConfigError(`${label} must not be null during automatic reload`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectExplicitNulls(item, `${label}[${index}]`));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    rejectExplicitNulls(child, `${label}.${key}`);
  }
}

function validatePresentObjectNode(parent: unknown, key: string, label: string): void {
  if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) return;
  const record = parent as Record<string, unknown>;
  if (Object.hasOwn(record, key)) validateObject(record[key], label);
}

function getNestedValue(
  obj: Record<string, unknown>,
  ...keys: string[]
): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function loadConfig(options: {
  requireFile?: boolean;
  configFile?: string;
  env?: NodeJS.ProcessEnv;
} = {}): AppConfig {
  const yamlConfig = loadYamlConfig(options.requireFile ?? false, options.configFile ?? CONFIG_FILE);
  return buildConfig(yamlConfig, options.env ?? process.env);
}

export function buildConfig(
  yamlConfig: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): AppConfig {
  const feishuAs =
    validateFeishuIdentity(getNestedValue(yamlConfig, 'feishu', 'as'), 'feishu.as') || 'bot';
  return {
    features: validateGlobalFeatures(getNestedValue(yamlConfig, 'features')),
    output: {
      transport:
        validateOutputTransport(env.DOUJIE_OUTPUT_TRANSPORT, 'DOUJIE_OUTPUT_TRANSPORT') ||
        validateOutputTransport(getNestedValue(yamlConfig, 'output', 'transport'), 'output.transport') ||
        'card',
    },
    codex: {
      model:
        validateOptionalString(env.CODEX_MODEL, 'CODEX_MODEL') ||
        validateOptionalString(getNestedValue(yamlConfig, 'codex', 'model'), 'codex.model') ||
        '',
      workdir: expandTilde(
        validateOptionalString(env.DOUJIE_CODEX_WORKDIR, 'DOUJIE_CODEX_WORKDIR') ||
        validateOptionalString(getNestedValue(yamlConfig, 'codex', 'workdir'), 'codex.workdir') ||
        process.cwd()
      ),
      sandbox:
        validateCodexSandbox(env.DOUJIE_CODEX_SANDBOX, 'DOUJIE_CODEX_SANDBOX') ||
        validateCodexSandbox(getNestedValue(yamlConfig, 'codex', 'sandbox'), 'codex.sandbox') ||
        'danger-full-access',
      skipGitRepoCheck:
        validateOptionalBoolean(env.DOUJIE_CODEX_SKIP_GIT_REPO_CHECK, 'DOUJIE_CODEX_SKIP_GIT_REPO_CHECK') ??
        validateOptionalBoolean(getNestedValue(yamlConfig, 'codex', 'skip_git_repo_check'), 'codex.skip_git_repo_check') ??
        false,
      controlSessionDir: expandTilde(
        validateOptionalString(env.DOUJIE_CODEX_CONTROL_SESSION_DIR, 'DOUJIE_CODEX_CONTROL_SESSION_DIR') ||
        validateOptionalString(getNestedValue(yamlConfig, 'codex', 'control_session_dir'), 'codex.control_session_dir') ||
        DEFAULT_CONTROL_SESSION_DIR
      ),
    },
    feishu: {
      chatIds:
        validateOptionalStringArray(getNestedValue(yamlConfig, 'feishu', 'chat_ids'), 'feishu.chat_ids') || [],
      as: feishuAs,
      botMentionIds:
        validateOptionalStringList(env.DOUJIE_FEISHU_BOT_MENTION_IDS, 'DOUJIE_FEISHU_BOT_MENTION_IDS') ||
        validateOptionalStringList(getNestedValue(yamlConfig, 'feishu', 'bot_mention_ids'), 'feishu.bot_mention_ids') ||
        [],
      botMentionNames:
        validateOptionalStringList(env.DOUJIE_FEISHU_BOT_MENTION_NAMES, 'DOUJIE_FEISHU_BOT_MENTION_NAMES') ||
        validateOptionalStringList(getNestedValue(yamlConfig, 'feishu', 'bot_mention_names'), 'feishu.bot_mention_names') ||
        [],
      editPolling: {
        enabled:
          validateOptionalBoolean(getNestedValue(yamlConfig, 'feishu', 'edit_polling', 'enabled'), 'feishu.edit_polling.enabled') ??
          false,
        chatIds:
          validateOptionalStringArray(getNestedValue(yamlConfig, 'feishu', 'edit_polling', 'chat_ids'), 'feishu.edit_polling.chat_ids') ||
          [],
        as:
          validateFeishuIdentity(getNestedValue(yamlConfig, 'feishu', 'edit_polling', 'as'), 'feishu.edit_polling.as') ||
          feishuAs,
        intervalMs:
          validateOptionalPositiveInteger(getNestedValue(yamlConfig, 'feishu', 'edit_polling', 'interval_ms'), 'feishu.edit_polling.interval_ms') ||
          10000,
        pageSize:
          validateOptionalPositiveInteger(getNestedValue(yamlConfig, 'feishu', 'edit_polling', 'page_size'), 'feishu.edit_polling.page_size') ||
          20,
      },
    },
    storage: {
      dbPath: expandTilde(
        validateOptionalString(env.DOUJIE_DB_PATH, 'DOUJIE_DB_PATH') ||
        validateOptionalString(getNestedValue(yamlConfig, 'storage', 'db_path'), 'storage.db_path') ||
        DEFAULT_DB_PATH
      ),
      backupDir: expandTilde(
        validateOptionalString(getNestedValue(yamlConfig, 'storage', 'backup_dir'), 'storage.backup_dir') ||
        DEFAULT_BACKUP_DIR
      ),
      exportDir: expandTilde(
        validateOptionalString(getNestedValue(yamlConfig, 'storage', 'export_dir'), 'storage.export_dir') ||
        DEFAULT_EXPORT_DIR
      ),
      attachmentCacheDir: expandTilde(
        validateOptionalString(getNestedValue(yamlConfig, 'storage', 'attachment_cache_dir'), 'storage.attachment_cache_dir') ||
        DEFAULT_ATTACHMENT_CACHE_DIR
      ),
    },
    privacy: {
      allowChatIds:
        validateOptionalStringArray(getNestedValue(yamlConfig, 'privacy', 'allow_chat_ids'), 'privacy.allow_chat_ids') || [],
      denyChatIds:
        validateOptionalStringArray(getNestedValue(yamlConfig, 'privacy', 'deny_chat_ids'), 'privacy.deny_chat_ids') || [],
      allowUserIds:
        validateOptionalStringArray(getNestedValue(yamlConfig, 'privacy', 'allow_user_ids'), 'privacy.allow_user_ids') || [],
      denyUserIds:
        validateOptionalStringArray(getNestedValue(yamlConfig, 'privacy', 'deny_user_ids'), 'privacy.deny_user_ids') || [],
      adminUserIds:
        validateOptionalStringArray(getNestedValue(yamlConfig, 'privacy', 'admin_user_ids'), 'privacy.admin_user_ids') || [],
      privateAllowUserIds: validatePrivateAllowUsers(getNestedValue(yamlConfig, 'privacy', 'private')),
      groups: validatePrivacyGroups(getNestedValue(yamlConfig, 'privacy', 'groups')),
      skipPatterns:
        validatePrivacyPatterns(getNestedValue(yamlConfig, 'privacy', 'skip_patterns'), 'privacy.skip_patterns', false) || [],
      redactPatterns:
        validatePrivacyPatterns(getNestedValue(yamlConfig, 'privacy', 'redact_patterns'), 'privacy.redact_patterns', true) || [],
    },
    attachments: {
      ocrCommand: validateOptionalString(getNestedValue(yamlConfig, 'attachments', 'ocr_command'), 'attachments.ocr_command') || null,
    },
  };
}

function validatePrivateAllowUsers(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('privacy.private must be an object');
  }
  return validateOptionalStringArray((value as Record<string, unknown>).allow_user_ids, 'privacy.private.allow_user_ids') || [];
}

function validatePrivacyGroups(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ConfigError('privacy.groups must be an array');
  return value.map((item, index) => {
    const label = `privacy.groups[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ConfigError(`${label} must be an object`);
    }
    const record = item as Record<string, unknown>;
    const chatId = validateOptionalString(record.chat_id, `${label}.chat_id`);
    if (!chatId) throw new ConfigError(`${label}.chat_id must be a non-empty string`);
    const context = typeof record.context === 'object' && record.context !== null && !Array.isArray(record.context)
      ? record.context as Record<string, unknown>
      : {};
    const features = validateFeatureOverrides(record.features, `${label}.features`);
    return {
      chatId,
      allowUserIds: validateOptionalStringArray(record.allow_user_ids, `${label}.allow_user_ids`) || [],
      allowAgentUserIds: validateOptionalStringArray(record.allow_agent_user_ids, `${label}.allow_agent_user_ids`) || [],
      contextEnabled: validateOptionalBoolean(context.enabled, `${label}.context.enabled`) ?? false,
      contextMaxMessages: validateOptionalPositiveInteger(context.max_messages, `${label}.context.max_messages`) || 50,
      contextMaxChars: validateOptionalPositiveInteger(context.max_chars, `${label}.context.max_chars`) || 30000,
      ...(features ? { features } : {}),
    };
  });
}

function validateQuotedMessageConfig(value: unknown, label: string): QuotedMessageFeatureConfig {
  if (value === undefined || value === null) {
    return {
      enabled: false,
      maxChars: DEFAULT_QUOTED_MESSAGE_MAX_CHARS,
      maxDepth: DEFAULT_QUOTED_MESSAGE_MAX_DEPTH,
      includeAttachments: false,
    };
  }
  const record = validateObject(value, label);
  return {
    enabled: validateOptionalBoolean(record.enabled, `${label}.enabled`) ?? false,
    maxChars: validateOptionalPositiveInteger(record.max_chars, `${label}.max_chars`) ?? DEFAULT_QUOTED_MESSAGE_MAX_CHARS,
    maxDepth: validateQuotedMessageDepth(record.max_depth, `${label}.max_depth`) ?? DEFAULT_QUOTED_MESSAGE_MAX_DEPTH,
    includeAttachments: validateOptionalBoolean(record.include_attachments, `${label}.include_attachments`) ?? false,
  };
}

function validateGlobalFeatures(value: unknown): AppConfig['features'] {
  if (value === undefined || value === null) {
    return { quotedMessage: validateQuotedMessageConfig(undefined, 'features.quoted_message') };
  }
  const record = validateObject(value, 'features');
  return {
    quotedMessage: validateQuotedMessageConfig(record.quoted_message, 'features.quoted_message'),
  };
}

function validateFeatureOverrides(value: unknown, label: string): FeatureOverrides | undefined {
  if (value === undefined || value === null) return undefined;
  const record = validateObject(value, label);
  if (record.quoted_message === undefined || record.quoted_message === null) return undefined;
  const quoted = validateObject(record.quoted_message, `${label}.quoted_message`);
  const enabled = validateOptionalBoolean(quoted.enabled, `${label}.quoted_message.enabled`);
  const maxChars = validateOptionalPositiveInteger(quoted.max_chars, `${label}.quoted_message.max_chars`);
  const maxDepth = validateQuotedMessageDepth(quoted.max_depth, `${label}.quoted_message.max_depth`);
  const includeAttachments = validateOptionalBoolean(
    quoted.include_attachments,
    `${label}.quoted_message.include_attachments`
  );
  if (enabled === undefined && maxChars === undefined && maxDepth === undefined && includeAttachments === undefined) return undefined;
  return {
    quotedMessage: {
      ...(enabled === undefined ? {} : { enabled }),
      ...(maxChars === undefined ? {} : { maxChars }),
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(includeAttachments === undefined ? {} : { includeAttachments }),
    },
  };
}

function validateQuotedMessageDepth(value: unknown, label: string): number | undefined {
  const depth = validateOptionalPositiveInteger(value, label);
  if (depth !== undefined && depth > MAX_QUOTED_MESSAGE_DEPTH) {
    throw new ConfigError(`${label} must be at most ${MAX_QUOTED_MESSAGE_DEPTH}`);
  }
  return depth;
}

function validateObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ConfigError(`${label} must be a string`);
  }
  return value;
}

function validateOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ConfigError(`${label} must be an array of strings`);
  }
  return value;
}

function validateOptionalStringList(value: unknown, label: string): string[] | undefined {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return validateOptionalStringArray(value, label);
}

function validateFeishuIdentity(value: unknown, label: string): FeishuIdentity | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== 'bot' && value !== 'user') {
    throw new ConfigError(`${label} must be either "bot" or "user"`);
  }
  return value;
}

function validateOutputTransport(value: unknown, label: string): OutputTransport | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value !== 'card' && value !== 'post') {
    throw new ConfigError(`${label} must be card or post`);
  }
  return value;
}

function validateCodexSandbox(
  value: unknown,
  label: string
): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value !== 'read-only' && value !== 'workspace-write' && value !== 'danger-full-access') {
    throw new ConfigError(`${label} must be read-only, workspace-write, or danger-full-access`);
  }
  return value;
}

function validateOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  throw new ConfigError(`${label} must be a boolean`);
}

function validateOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${label} must be a positive integer`);
  }
  return value;
}

function validatePrivacyPatterns(
  value: unknown,
  label: string,
  allowReplacement: boolean
): PrivacyPattern[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ConfigError(`${label} must be an array of pattern objects`);
  }
  return value.map((item, index) => validatePrivacyPattern(item, `${label}[${index}]`, allowReplacement));
}

function validatePrivacyPattern(value: unknown, label: string, allowReplacement: boolean): PrivacyPattern {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const name = validateOptionalString(record.name, `${label}.name`);
  const pattern = validateOptionalString(record.pattern, `${label}.pattern`);
  if (!name) {
    throw new ConfigError(`${label}.name must be a non-empty string`);
  }
  if (!pattern) {
    throw new ConfigError(`${label}.pattern must be a non-empty string`);
  }
  try {
    new RegExp(pattern, 'gu');
  } catch (err) {
    throw new ConfigError(`${label}.pattern is not a valid regex: ${(err as Error).message}`);
  }
  const replacement = validateOptionalString(record.replacement, `${label}.replacement`);
  if (replacement !== undefined && !allowReplacement) {
    throw new ConfigError(`${label}.replacement is only supported for redact patterns`);
  }
  return replacement === undefined ? { name, pattern } : { name, pattern, replacement };
}
