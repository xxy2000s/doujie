import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import type { AppConfig, FeishuIdentity, PrivacyPattern } from './types.js';

export const CONFIG_DIR = path.join(os.homedir(), '.doujie');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');
const DEFAULT_DB_PATH = path.join(CONFIG_DIR, 'data.db');
const DEFAULT_BACKUP_DIR = path.join(CONFIG_DIR, 'backups');
const DEFAULT_EXPORT_DIR = path.join(CONFIG_DIR, 'exports');
const DEFAULT_ATTACHMENT_CACHE_DIR = path.join(CONFIG_DIR, 'attachments');
const DEFAULT_CONTROL_SESSION_DIR = path.join(CONFIG_DIR, 'sessions');

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

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadYamlConfig(): Record<string, unknown> {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }
  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  const parsed = yaml.load(raw);
  if (typeof parsed === 'object' && parsed !== null) {
    return parsed as Record<string, unknown>;
  }
  return {};
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

export function loadConfig(): AppConfig {
  const yamlConfig = loadYamlConfig();
  return buildConfig(yamlConfig, process.env);
}

export function buildConfig(
  yamlConfig: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): AppConfig {
  const feishuAs =
    validateFeishuIdentity(getNestedValue(yamlConfig, 'feishu', 'as'), 'feishu.as') || 'bot';
  return {
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
        'workspace-write',
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
