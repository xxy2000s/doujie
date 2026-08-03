import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatAgentSessionRecord, validateAgentAlias, type AgentProvider } from './agent-session-registry.js';
import {
  DEFAULT_CODEX_AGENT_SANDBOX,
  DEFAULT_CODEX_AGENT_SKIP_GIT_REPO_CHECK,
  type CreateAgentSessionDraft,
  type HeadlessAgentRuntimeDefaults,
  type HeadlessAgentRunnerLike,
} from './headless-agent-runner.js';
import type { MessageContent } from './types.js';

export type AgentSessionDraft = Omit<CreateAgentSessionDraft, 'createdBy'>;

export type ParseAgentSessionIntentResult =
  | { kind: 'none' }
  | { kind: 'missing'; missing: string[]; draft: Partial<AgentSessionDraft> }
  | { kind: 'draft'; draft: AgentSessionDraft };

export type PendingAgentAction = {
  id: string;
  kind: 'create_agent_session';
  chatId: string;
  senderId: string;
  createdAt: string;
  expiresAt: string;
  draft: AgentSessionDraft;
  codexDefaults?: HeadlessAgentRuntimeDefaults;
};

export type PendingAgentActionFile = {
  version: 1;
  updatedAt: string;
  actions: Record<string, PendingAgentAction>;
};

export type AgentSessionIntentResult = {
  text: string;
};

const DEFAULT_PROMPT = '请先熟悉当前项目，回复你的 session 已创建，并说明你准备如何协作。';
const DEFAULT_PENDING_ACTION_PATH = path.join(os.homedir(), '.doujie', 'pending-agent-actions.json');
const PENDING_TTL_MS = 10 * 60 * 1000;

export class PendingAgentActionStore {
  constructor(private readonly filePath: string = DEFAULT_PENDING_ACTION_PATH) {}

  read(now: Date = new Date()): PendingAgentActionFile {
    let file: PendingAgentActionFile = { version: 1, updatedAt: new Date(0).toISOString(), actions: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<PendingAgentActionFile>;
      if (parsed.version === 1 && isRecord(parsed.actions)) {
        file = {
          version: 1,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
          actions: parsed.actions as Record<string, PendingAgentAction>,
        };
      }
    } catch {
      // Missing or invalid state is rebuilt on next write.
    }
    const nowMs = now.getTime();
    const actions = Object.fromEntries(
      Object.entries(file.actions).filter(([, action]) => Date.parse(action.expiresAt) > nowMs)
    );
    return { ...file, actions };
  }

  put(action: PendingAgentAction): void {
    const file = this.read();
    file.actions[pendingKey(action.chatId, action.senderId)] = action;
    this.write(file);
  }

  get(chatId: string, senderId: string, now: Date = new Date()): PendingAgentAction | null {
    return this.read(now).actions[pendingKey(chatId, senderId)] ?? null;
  }

  consume(chatId: string, senderId: string): PendingAgentAction | null {
    const file = this.read();
    const key = pendingKey(chatId, senderId);
    const action = file.actions[key] ?? null;
    delete file.actions[key];
    this.write(file);
    return action;
  }

  clear(chatId: string, senderId: string): boolean {
    const file = this.read();
    const key = pendingKey(chatId, senderId);
    const existed = Boolean(file.actions[key]);
    delete file.actions[key];
    this.write(file);
    return existed;
  }

  private write(file: PendingAgentActionFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), actions: file.actions }, null, 2),
      { encoding: 'utf-8', mode: 0o600 }
    );
  }
}

export class AgentSessionIntentController {
  constructor(
    private readonly runner: HeadlessAgentRunnerLike,
    private readonly pendingStore: PendingAgentActionStore = new PendingAgentActionStore(),
    private readonly clock: () => Date = () => new Date()
  ) {}

  async handle(
    message: MessageContent,
    defaults?: HeadlessAgentRuntimeDefaults
  ): Promise<AgentSessionIntentResult | null> {
    const normalized = normalizeText(message.text);
    if (isConfirmText(normalized)) {
      const action = this.pendingStore.consume(message.chatId, message.senderId);
      if (!action) return null;
      const record = await this.runner.create({
        ...action.draft,
        createdBy: { chatId: message.chatId, senderId: message.senderId },
      }, action.codexDefaults ?? defaults);
      return {
        text: [
          '已创建并登记 Agent session。',
          '',
          formatAgentSessionRecord(record),
        ].join('\n'),
      };
    }

    if (isCancelText(normalized)) {
      const cleared = this.pendingStore.clear(message.chatId, message.senderId);
      if (!cleared) return null;
      return { text: '已取消待确认的 Agent session 创建动作。' };
    }

    const parsed = parseCreateAgentSessionIntent(message.text);
    if (parsed.kind === 'none') return null;
    if (parsed.kind === 'missing') {
      return { text: formatMissingDraft(parsed.missing, parsed.draft) };
    }

    const now = this.clock();
    const action: PendingAgentAction = {
      id: `create-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'create_agent_session',
      chatId: message.chatId,
      senderId: message.senderId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
      draft: parsed.draft,
      ...(parsed.draft.provider === 'codex'
        ? { codexDefaults: captureCodexDefaults(parsed.draft, defaults) }
        : {}),
    };
    this.pendingStore.put(action);
    return { text: formatConfirmation(action) };
  }

  hasPendingConfirmation(message: MessageContent): boolean {
    const normalized = normalizeText(message.text);
    if (!isConfirmText(normalized) && !isCancelText(normalized)) return false;
    return this.pendingStore.get(message.chatId, message.senderId) !== null;
  }
}

export function parseCreateAgentSessionIntent(text: string): ParseAgentSessionIntentResult {
  const normalized = normalizeText(text);
  if (!looksLikeCreateSessionIntent(normalized)) return { kind: 'none' };

  const provider = extractProvider(normalized);
  const cwd = extractCwd(text);
  const alias = extractAlias(text);
  const prompt = extractPrompt(text);
  const missing: string[] = [];
  if (!provider) missing.push('provider(codex/claude)');
  if (!cwd) missing.push('cwd/工作区路径');
  if (!alias) missing.push('alias/别名');
  const aliasError = alias ? validateAgentAlias(alias) : null;
  if (aliasError) missing.push(`valid alias(${aliasError})`);
  if (missing.length > 0 || !provider || !cwd || !alias || aliasError) {
    return { kind: 'missing', missing, draft: { provider: provider ?? undefined, cwd: cwd ?? undefined, alias: alias ?? undefined, prompt } };
  }

  return {
    kind: 'draft',
    draft: {
      provider,
      cwd,
      alias,
      prompt,
      sandbox: provider === 'codex' ? DEFAULT_CODEX_AGENT_SANDBOX : undefined,
      skipGitRepoCheck: provider === 'codex' ? DEFAULT_CODEX_AGENT_SKIP_GIT_REPO_CHECK : undefined,
      permissionMode: provider === 'claude' ? 'default' : undefined,
    },
  };
}

function looksLikeCreateSessionIntent(text: string): boolean {
  return (
    /(创建|新建|开|启动|起)(一个|个)?/.test(text) &&
    /(session|会话)/i.test(text) &&
    /(codex|claude|cloud\s*code|cloudcode|agent)/i.test(text)
  );
}

function extractProvider(text: string): AgentProvider | null {
  if (/codex/i.test(text)) return 'codex';
  if (/claude|cloud\s*code|cloudcode/i.test(text)) return 'claude';
  return null;
}

function extractCwd(text: string): string | null {
  const quoted = /(?:cwd|工作区|目录|项目|在|去|到)\s*[:：]?\s*["'`“”]?((?:~|\/)[^"'`“”\s，。；,;]+)/i.exec(text);
  if (quoted) return quoted[1];
  const anyPath = /((?:~|\/)[^\s，。；,;]+)/.exec(text);
  return anyPath?.[1] ?? null;
}

function extractAlias(text: string): string | null {
  const match = /(?:别名|alias|命名为|名字叫|叫)\s*[:：]?\s*["'`“”]?([\p{L}\p{N}._-]{1,80})/iu.exec(text);
  return match?.[1] ?? null;
}

function extractPrompt(text: string): string {
  for (const pattern of [
    /(?:prompt|任务)\s*[:：]\s*([\s\S]+)$/i,
    /让[它他她]?\s*([\s\S]+)$/i,
    /先\s*([\s\S]+)$/i,
  ]) {
    const match = pattern.exec(text);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return DEFAULT_PROMPT;
}

function formatConfirmation(action: PendingAgentAction): string {
  const codexDefaults = action.codexDefaults;
  return [
    '请确认是否创建新的 Agent session：',
    '',
    `**Provider:** ${action.draft.provider}`,
    `**Alias:** \`${action.draft.alias}\``,
    `**CWD:** \`${action.draft.cwd}\``,
    `**Prompt:** ${action.draft.prompt}`,
    ...(action.draft.provider === 'codex' ? [
      `**Model:** ${codexDefaults?.model || '(CLI default)'}`,
      `**Sandbox:** ${codexDefaults?.sandbox ?? DEFAULT_CODEX_AGENT_SANDBOX}`,
      `**Skip Git Repo Check:** ${codexDefaults?.skipGitRepoCheck ?? DEFAULT_CODEX_AGENT_SKIP_GIT_REPO_CHECK}`,
    ] : [`**Permission Mode:** ${action.draft.permissionMode ?? 'default'}`]),
    '',
    '回复「确认」执行，回复「取消」放弃。10 分钟后自动过期。',
  ].join('\n');
}

function captureCodexDefaults(
  draft: AgentSessionDraft,
  defaults?: HeadlessAgentRuntimeDefaults
): HeadlessAgentRuntimeDefaults {
  return {
    model: draft.model ?? defaults?.model ?? '',
    workdir: draft.cwd,
    sandbox: defaults?.sandbox ?? draft.sandbox ?? DEFAULT_CODEX_AGENT_SANDBOX,
    skipGitRepoCheck: defaults?.skipGitRepoCheck ?? draft.skipGitRepoCheck ?? DEFAULT_CODEX_AGENT_SKIP_GIT_REPO_CHECK,
  };
}

function formatMissingDraft(missing: string[], draft: Partial<AgentSessionDraft>): string {
  const known = [
    draft.provider ? `provider=${draft.provider}` : '',
    draft.alias ? `alias=${draft.alias}` : '',
    draft.cwd ? `cwd=${draft.cwd}` : '',
  ].filter(Boolean);
  return [
    '我识别到你想创建 Agent session，但信息不完整。',
    `缺少：${missing.join(', ')}`,
    known.length > 0 ? `已识别：${known.join(', ')}` : '',
    '',
    '可以这样说：去 /home/doujie/service/doujie 开个 codex session，叫 doujie-main，让它先熟悉项目。',
  ].filter(Boolean).join('\n');
}

function isConfirmText(text: string): boolean {
  return /^(确认|确认执行|执行|ok|yes|y)$/i.test(text);
}

function isCancelText(text: string): boolean {
  return /^(取消|算了|cancel|no|n)$/i.test(text);
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function pendingKey(chatId: string, senderId: string): string {
  return `${chatId}:${senderId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
