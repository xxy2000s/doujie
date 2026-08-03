import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordControlSession } from '../control-sessions.js';

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexOutputMode = 'answer' | 'detail';

export type CodexChatOptions = {
  model: string;
  workdir: string;
  sandbox: CodexSandbox;
  skipGitRepoCheck: boolean;
  sessionKey: string;
  outputMode?: CodexOutputMode;
  stateFile?: string;
  controlSessionDir?: string;
  flushChars?: number;
  flushIntervalMs?: number;
  abortSignal?: AbortSignal;
};

export type CodexChatResult = {
  sessionId: string | null;
};

export class CodexChatInterruptedError extends Error {
  constructor(message = 'Codex chat interrupted by a newer message') {
    super(message);
    this.name = 'CodexChatInterruptedError';
  }
}

export function isCodexChatInterruptedError(error: unknown): error is CodexChatInterruptedError {
  return error instanceof CodexChatInterruptedError;
}

type SessionState = {
  sessions?: Record<string, string>;
};

const DEFAULT_STATE_FILE = path.join(os.homedir(), '.doujie', 'codex-sessions.json');
const MAX_EVENT_OUTPUT_CHARS = 3500;
const SUPPRESSED_CODEX_NOISE_PATTERNS = [
  /^clamping SessionEnd hook timeout to \d+s in .*\/\.codex\/hooks\.json$/,
];

export type CodexChunkMeta = { continuation: boolean };
export type CodexChunkHandler = (text: string, meta?: CodexChunkMeta) => Promise<void>;

export function buildCodexChatArgs(
  prompt: string,
  options: CodexChatOptions,
  sessionId?: string | null
): string[] {
  if (sessionId) {
    const args = ['exec', 'resume', '--json', '--ignore-user-config'];
    if (options.model) {
      args.push('--model', options.model);
    }
    pushSandboxArgs(args, options.sandbox);
    if (options.skipGitRepoCheck) {
      args.push('--skip-git-repo-check');
    }
    args.push(sessionId, prompt);
    return args;
  }

  const args = [
    'exec',
    '--json',
    '--ignore-user-config',
    '--cd',
    options.workdir,
  ];
  pushSandboxArgs(args, options.sandbox);
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.skipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }
  args.push(prompt);
  return args;
}

function pushSandboxArgs(args: string[], sandbox: CodexSandbox): void {
  if (sandbox === 'danger-full-access') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
    return;
  }
  args.push('--sandbox', sandbox);
}

export function extractCodexSessionId(event: Record<string, unknown>): string | null {
  for (const key of ['thread_id', 'threadId', 'session_id', 'sessionId', 'conversation_id', 'conversationId']) {
    const value = event[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }

  const item = event.item;
  if (isRecord(item)) {
    for (const key of ['session_id', 'sessionId']) {
      const value = item[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return null;
}

export function extractCodexText(event: Record<string, unknown>, outputMode: CodexOutputMode = 'detail'): string {
  const eventType = String(event.type ?? event.event ?? event.method ?? '');
  const detailed = outputMode === 'detail';

  if (eventType === 'thread.started') {
    if (!detailed) return '';
    const sessionId = extractCodexSessionId(event);
    return sessionId ? `[thread] started ${sessionId}` : '[thread] started';
  }

  if (eventType === 'turn.started') {
    if (!detailed) return '';
    return '[turn] started';
  }

  if (eventType === 'turn.completed') {
    if (!detailed) return '';
    return formatUsage(event.usage);
  }

  const item = event.item;
  if (isRecord(item)) {
    const itemType = String(item.type ?? 'item');
    if (itemType === 'agent_message') {
      return textFromUnknown(item.text ?? item.content ?? item.message);
    }
    if (itemType === 'command_execution') {
      if (!detailed) return '';
      return formatCommandExecution(eventType, item);
    }
    if (itemType.includes('reasoning')) {
      if (!detailed) return '';
      const summary = textFromUnknown(item.summary ?? item.text ?? item.content);
      return summary ? `[reasoning-summary]\n${summary}` : '';
    }
    for (const key of ['delta', 'text', 'content', 'message']) {
      const text = textFromUnknown(item[key]);
      if (isSuppressedCodexNoise(text)) return '';
      if (text) return detailed && item.type ? `[${itemType}]\n${text}` : text;
    }
  }

  if (/usage|token|session/.test(eventType)) return '';

  for (const key of ['delta', 'text', 'content', 'message', 'msg']) {
    const value = event[key];
    const text = textFromUnknown(value);
    if (isSuppressedCodexNoise(text)) return '';
    if (text) return text;
  }

  return '';
}

export async function runCodexChat(
  prompt: string,
  options: CodexChatOptions,
  onChunk: CodexChunkHandler
): Promise<CodexChatResult> {
  if (!fs.existsSync(options.workdir)) {
    throw new Error(`Codex workdir does not exist: ${options.workdir}`);
  }
  if (options.abortSignal?.aborted) {
    throw new CodexChatInterruptedError();
  }

  const statePath = options.stateFile ?? DEFAULT_STATE_FILE;
  const state = loadSessionState(statePath);
  const previousSessionId = state.sessions?.[options.sessionKey] ?? null;
  const args = buildCodexChatArgs(prompt, options, previousSessionId);
  const proc = spawn('codex', args, {
    cwd: options.workdir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  let stderr = '';
  let sessionId = previousSessionId;
  let lineBuffer = '';
  let pendingSend = Promise.resolve();
  let previousOutputWasDelta = false;
  let streamedDeltaText = '';
  let aborted = false;
  let forceKillTimer: NodeJS.Timeout | null = null;

  const abort = (): void => {
    aborted = true;
    terminateProcessTree(proc.pid, 'SIGTERM');
    forceKillTimer = setTimeout(() => {
      terminateProcessTree(proc.pid, 'SIGKILL');
    }, 3000);
    forceKillTimer.unref();
  };
  options.abortSignal?.addEventListener('abort', abort, { once: true });
  if (options.abortSignal?.aborted) {
    abort();
  }

  function queueChunk(text: string, isDelta = false): void {
    const normalized = isDelta ? text : text.trim();
    if (!normalized && !isDelta) return;
    if (isDelta && text.length === 0) return;
    const continuesPrevious = isDelta && previousOutputWasDelta;
    previousOutputWasDelta = isDelta;
    for (const [index, chunk] of splitForMessage(normalized).entries()) {
      pendingSend = pendingSend.then(() => onChunk(chunk, { continuation: continuesPrevious || index > 0 }));
    }
  }

  const stdoutDone = new Promise<void>((resolve, reject) => {
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        handleCodexOutputLine(line);
      }
    });
    proc.stdout?.on('error', reject);
    proc.stdout?.on('end', () => {
      if (lineBuffer.trim()) {
        handleCodexOutputLine(lineBuffer);
      }
      lineBuffer = '';
      resolve();
    });
  });

  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', resolve);
    });
    await stdoutDone;
    await pendingSend;
  } catch (err) {
    if (aborted || options.abortSignal?.aborted || isCodexChatInterruptedError(err)) {
      throw new CodexChatInterruptedError();
    }
    throw err;
  } finally {
    options.abortSignal?.removeEventListener('abort', abort);
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
  }

  if (aborted || options.abortSignal?.aborted) {
    throw new CodexChatInterruptedError();
  }

  if (exitCode !== 0) {
    throw new Error(`codex exited with code ${exitCode}: ${stderr.trim() || 'no stderr'}`);
  }

  return { sessionId };

  function handleCodexOutputLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'Reading additional input from stdin...' || isSuppressedCodexNoise(trimmed)) return;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const nextSessionId = extractCodexSessionId(event);
      if (nextSessionId) {
        sessionId = nextSessionId;
        saveSession(statePath, options.sessionKey, nextSessionId, options.workdir, options.controlSessionDir);
      }
      const outputMode = options.outputMode ?? 'answer';
      const deltaEvent = isCodexDeltaEvent(event);
      const emitDelta = deltaEvent && (outputMode === 'detail' || isAnswerTextDeltaEvent(event));
      const piece = deltaEvent
        ? (emitDelta ? extractCodexDeltaText(event) : '')
        : extractCodexText(event, outputMode);
      if (piece) {
        if (!deltaEvent && shouldSuppressCompletedDeltaEcho(streamedDeltaText, event, piece)) {
          streamedDeltaText = '';
          previousOutputWasDelta = false;
          return;
        }
        streamedDeltaText = deltaEvent ? `${streamedDeltaText}${piece}` : '';
        queueChunk(piece, deltaEvent);
      }
    } catch {
      queueChunk(trimmed);
    }
  }
}

export function isCodexDeltaEvent(event: Record<string, unknown>): boolean {
  const eventType = String(event.type ?? '').toLowerCase();
  if (eventType.includes('delta') || Object.hasOwn(event, 'delta')) return true;
  const item = event.item;
  if (!isRecord(item)) return false;
  return String(item.type ?? '').toLowerCase().includes('delta') || Object.hasOwn(item, 'delta');
}

export function isAnswerTextDeltaEvent(event: Record<string, unknown>): boolean {
  const eventType = String(event.type ?? '').toLowerCase();
  if (/reasoning|tool|command|session|usage|token/.test(eventType)) return false;
  if (
    eventType === 'response.delta' ||
    /(?:output_text|answer|agent_message|message)\.delta/.test(eventType)
  ) return true;
  const item = event.item;
  if (!isRecord(item)) return !eventType && Object.hasOwn(event, 'delta');
  const itemType = String(item.type ?? '').toLowerCase();
  if (/reasoning|tool|command|session|usage|token/.test(itemType)) return false;
  if (itemType === 'text_delta' || /agent_message|output_text|answer/.test(itemType)) return true;
  return !eventType && !itemType && Object.hasOwn(event, 'delta');
}

export function extractCodexDeltaText(event: Record<string, unknown>): string {
  if (Object.hasOwn(event, 'delta')) return textFromUnknownPreservingWhitespace(event.delta);
  const item = event.item;
  if (!isRecord(item)) return '';
  for (const key of ['delta', 'text', 'content', 'message']) {
    if (!Object.hasOwn(item, key)) continue;
    return textFromUnknownPreservingWhitespace(item[key]);
  }
  return '';
}

export function shouldSuppressCompletedDeltaEcho(
  streamedDeltaText: string,
  event: Record<string, unknown>,
  completedText: string
): boolean {
  if (!streamedDeltaText) return false;
  if (streamedDeltaText.trim() !== completedText.trim()) return false;
  const eventType = String(event.type ?? '').toLowerCase();
  if (/(?:output_text|answer|agent_message|message)\.(?:done|completed)$/.test(eventType)) return true;
  const item = event.item;
  if (!isRecord(item) || String(item.type ?? '') !== 'agent_message') return false;
  if (eventType && !eventType.includes('completed')) return false;
  return true;
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      process.kill(pid, signal);
      return;
    }
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

export function clearCodexSession(sessionKey: string, stateFile: string = DEFAULT_STATE_FILE): string | null {
  const state = loadSessionState(stateFile);
  const sessions = state.sessions ?? {};
  const previousSessionId = sessions[sessionKey] ?? null;
  if (!previousSessionId) {
    return null;
  }

  delete sessions[sessionKey];
  writeSessionState(stateFile, sessions);
  return previousSessionId;
}

function isSuppressedCodexNoise(text: string): boolean {
  return text.length > 0 && SUPPRESSED_CODEX_NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

function formatCommandExecution(eventType: string, item: Record<string, unknown>): string {
  const command = textFromUnknown(item.command) || '(unknown command)';
  const status = textFromUnknown(item.status);
  const exitCode = item.exit_code;
  if (eventType === 'item.started' || status === 'in_progress') {
    return `[tool:start command_execution]\n$ ${command}`;
  }

  const header =
    typeof exitCode === 'number'
      ? `[tool:done command_execution exit=${exitCode}]`
      : '[tool:done command_execution]';
  const output = textFromUnknown(item.aggregated_output);
  if (!output) return `${header}\n$ ${command}`;
  return `${header}\n$ ${command}\n${truncateForMessage(output)}`;
}

function formatUsage(value: unknown): string {
  if (!isRecord(value)) return '[turn] completed';
  const input = value.input_tokens;
  const output = value.output_tokens;
  const cached = value.cached_input_tokens;
  const reasoning = value.reasoning_output_tokens;
  const parts = [
    typeof input === 'number' ? `input=${input}` : '',
    typeof cached === 'number' ? `cached=${cached}` : '',
    typeof output === 'number' ? `output=${output}` : '',
    typeof reasoning === 'number' ? `reasoning=${reasoning}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `[turn] completed ${parts.join(' ')}` : '[turn] completed';
}

function truncateForMessage(text: string): string {
  if (text.length <= MAX_EVENT_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_EVENT_OUTPUT_CHARS)}\n[output truncated: ${text.length - MAX_EVENT_OUTPUT_CHARS} chars]`;
}

function splitForMessage(text: string): string[] {
  if (text.length <= MAX_EVENT_OUTPUT_CHARS) return [text];
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += MAX_EVENT_OUTPUT_CHARS) {
    chunks.push(text.slice(start, start + MAX_EVENT_OUTPUT_CHARS));
  }
  return chunks;
}

function loadSessionState(stateFile: string): SessionState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as SessionState;
    return isRecord(parsed.sessions) ? parsed : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

function saveSession(
  stateFile: string,
  key: string,
  sessionId: string,
  workdir: string,
  controlSessionDir?: string
): void {
  const state = loadSessionState(stateFile);
  const sessions = state.sessions ?? {};
  sessions[key] = sessionId;
  writeSessionState(stateFile, sessions);
  try {
    recordControlSession({
      sessionKey: key,
      sessionId,
      workdir,
      registryDir: controlSessionDir,
    });
  } catch (err) {
    console.error('[codex-chat] Failed to update control session index:', (err as Error).message);
  }
}

function writeSessionState(stateFile: string, sessions: Record<string, string>): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ sessions }, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (isRecord(value)) {
    for (const key of ['text', 'content', 'message']) {
      const text = textFromUnknown(value[key]);
      if (text) return text;
    }
  }
  if (Array.isArray(value)) {
    const joined = value.map(textFromUnknown).filter(Boolean).join('\n');
    return joined.trim();
  }
  return '';
}

function textFromUnknownPreservingWhitespace(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    for (const key of ['text', 'content', 'message']) {
      if (!Object.hasOwn(value, key)) continue;
      const text = textFromUnknownPreservingWhitespace(value[key]);
      if (text) return text;
    }
  }
  if (Array.isArray(value)) {
    return value.map(textFromUnknownPreservingWhitespace).join('');
  }
  return '';
}
