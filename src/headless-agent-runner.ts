import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentSessionRegistryStore,
  type AgentProvider,
  type AgentSessionRecord,
} from './agent-session-registry.js';
import { findCodexSessionFile } from './control-sessions.js';

export type CreateAgentSessionDraft = {
  provider: AgentProvider;
  alias: string;
  cwd: string;
  prompt: string;
  model?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  permissionMode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan';
  createdBy: {
    chatId: string;
    senderId: string;
  };
};

export type DispatchAgentSessionInput = {
  record: AgentSessionRecord;
  prompt: string;
};

export type ProviderProcessResult = {
  sessionId: string | null;
  text: string;
};

export type HeadlessAgentRunnerLike = {
  create(draft: CreateAgentSessionDraft): Promise<AgentSessionRecord>;
  dispatch(input: DispatchAgentSessionInput): Promise<{ record: AgentSessionRecord; text: string }>;
};

export class HeadlessAgentRunner implements HeadlessAgentRunnerLike {
  constructor(private readonly registry: AgentSessionRegistryStore = new AgentSessionRegistryStore()) {}

  async create(draft: CreateAgentSessionDraft): Promise<AgentSessionRecord> {
    const cwd = resolveExistingDirectory(draft.cwd);
    const result =
      draft.provider === 'codex'
        ? await runProviderCommand('codex', buildCodexCreateArgs({ ...draft, cwd }), cwd)
        : await runProviderCommand('claude', buildClaudeCreateArgs({ ...draft, cwd }), cwd);
    if (!result.sessionId) {
      throw new Error(`${draft.provider} did not return a native session id`);
    }
    const now = new Date().toISOString();
    const record: AgentSessionRecord = {
      alias: draft.alias,
      provider: draft.provider,
      nativeSessionId: result.sessionId,
      cwd,
      jsonlPath: findProviderJsonlPath(draft.provider, result.sessionId),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      createdBy: draft.createdBy,
      launch: {
        model: draft.model ?? '',
        sandbox: draft.provider === 'codex' ? draft.sandbox ?? 'workspace-write' : '',
        permissionMode: draft.provider === 'claude' ? draft.permissionMode ?? 'default' : '',
        outputFormat: draft.provider === 'codex' ? 'json' : 'json',
      },
    };
    return this.registry.upsert(record);
  }

  async dispatch(input: DispatchAgentSessionInput): Promise<{ record: AgentSessionRecord; text: string }> {
    const cwd = resolveExistingDirectory(input.record.cwd);
    const result =
      input.record.provider === 'codex'
        ? await runProviderCommand('codex', buildCodexResumeArgs(input.record, input.prompt), cwd)
        : await runProviderCommand('claude', buildClaudeResumeArgs(input.record, input.prompt), cwd);
    const updated = this.registry.upsert({
      ...input.record,
      jsonlPath: findProviderJsonlPath(input.record.provider, input.record.nativeSessionId) ?? input.record.jsonlPath,
      lastUsedAt: new Date().toISOString(),
    });
    return { record: updated, text: result.text };
  }
}

export function buildCodexCreateArgs(draft: CreateAgentSessionDraft): string[] {
  const args = ['exec', '--json', '--ignore-user-config', '--cd', draft.cwd];
  pushCodexSandboxArgs(args, draft.sandbox ?? 'workspace-write');
  if (draft.model) args.push('--model', draft.model);
  args.push(draft.prompt);
  return args;
}

export function buildCodexResumeArgs(record: AgentSessionRecord, prompt: string): string[] {
  return ['exec', 'resume', '--json', '--ignore-user-config', record.nativeSessionId, prompt];
}

export function buildClaudeCreateArgs(draft: CreateAgentSessionDraft): string[] {
  const args = ['-p', '--output-format', 'json', '--name', draft.alias];
  if (draft.model) args.push('--model', draft.model);
  args.push('--permission-mode', draft.permissionMode ?? 'default', draft.prompt);
  return args;
}

export function buildClaudeResumeArgs(record: AgentSessionRecord, prompt: string): string[] {
  return ['-p', '--resume', record.nativeSessionId, '--output-format', 'json', prompt];
}

export function extractProviderResult(provider: AgentProvider, stdout: string): ProviderProcessResult {
  let sessionId: string | null = null;
  const textParts: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === 'Reading additional input from stdin...') continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      sessionId = extractSessionId(provider, event) ?? sessionId;
      const text = extractResultText(provider, event);
      if (text) textParts.push(text);
    } catch {
      textParts.push(line);
    }
  }
  return { sessionId, text: textParts.join('\n').trim() };
}

export function findProviderJsonlPath(provider: AgentProvider, sessionId: string): string | null {
  if (provider === 'codex') return findCodexSessionFile(sessionId);
  const claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
  const projectsDir = path.join(claudeHome, 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  return findFileContaining(projectsDir, sessionId);
}

function pushCodexSandboxArgs(args: string[], sandbox: NonNullable<CreateAgentSessionDraft['sandbox']>): void {
  if (sandbox === 'danger-full-access') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
    return;
  }
  args.push('--sandbox', sandbox);
}

async function runProviderCommand(command: string, args: string[], cwd: string): Promise<ProviderProcessResult> {
  const provider = command === 'codex' ? 'codex' : 'claude';
  const { stdout, stderr, exitCode } = await spawnCollect(command, args, cwd);
  if (exitCode !== 0) {
    throw new Error(`${command} exited with code ${exitCode}: ${stderr.trim() || 'no stderr'}`);
  }
  return extractProviderResult(provider, stdout);
}

function spawnCollect(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}

function resolveExistingDirectory(input: string): string {
  const expanded = input === '~' ? os.homedir() : input.startsWith('~/') ? path.join(os.homedir(), input.slice(2)) : input;
  const resolved = path.resolve(expanded);
  if (!fs.existsSync(resolved)) throw new Error(`cwd does not exist: ${resolved}`);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`cwd is not a directory: ${resolved}`);
  return resolved;
}

function extractSessionId(provider: AgentProvider, event: Record<string, unknown>): string | null {
  for (const key of provider === 'codex'
    ? ['thread_id', 'threadId', 'session_id', 'sessionId']
    : ['session_id', 'sessionId']) {
    const value = event[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function extractResultText(provider: AgentProvider, event: Record<string, unknown>): string {
  if (provider === 'claude') {
    for (const key of ['result', 'text']) {
      const value = event[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  const item = event.item;
  if (isRecord(item) && String(item.type ?? '') === 'agent_message') {
    const text = item.text;
    if (typeof text === 'string') return text.trim();
  }
  for (const key of ['result', 'text', 'content', 'message']) {
    const value = event[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function findFileContaining(root: string, needle: string): string | null {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const head = fs.readFileSync(entryPath, 'utf-8');
        if (head.includes(needle)) return entryPath;
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
