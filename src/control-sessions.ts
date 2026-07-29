import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ControlSessionRecord = {
  sessionKey: string;
  sessionId: string;
  workdir: string;
  codexJsonlPath: string | null;
  linkPath: string | null;
  active: boolean;
  firstSeenAt: string;
  updatedAt: string;
};

export type ControlSessionIndex = {
  version: 1;
  updatedAt: string;
  sessions: Record<string, ControlSessionRecord>;
};

export type RecordControlSessionOptions = {
  sessionKey: string;
  sessionId: string;
  workdir: string;
  registryDir?: string;
  codexHome?: string;
  now?: () => Date;
};

export const DEFAULT_CONTROL_SESSION_DIR = path.join(os.homedir(), '.doujie', 'sessions');
const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');

export function recordControlSession(options: RecordControlSessionOptions): ControlSessionRecord {
  const registryDir = options.registryDir ?? DEFAULT_CONTROL_SESSION_DIR;
  const now = (options.now ?? (() => new Date()))().toISOString();
  const index = readControlSessionIndex(registryDir);
  const existing = index.sessions[options.sessionKey];
  const codexJsonlPath = findCodexSessionFile(options.sessionId, options.codexHome ?? DEFAULT_CODEX_HOME);
  const linkPath = codexJsonlPath
    ? path.join(registryDir, 'links', `${safeFileName(options.sessionKey)}.jsonl`)
    : null;

  const record: ControlSessionRecord = {
    sessionKey: options.sessionKey,
    sessionId: options.sessionId,
    workdir: options.workdir,
    codexJsonlPath,
    linkPath,
    active: true,
    firstSeenAt: existing?.sessionId === options.sessionId ? existing.firstSeenAt : now,
    updatedAt: now,
  };

  index.sessions[options.sessionKey] = record;
  writeControlSessionIndex(registryDir, index);
  updateSessionLink(linkPath, codexJsonlPath);
  writeControlSessionReadme(registryDir, index);
  return record;
}

export function deactivateControlSession(sessionKey: string, registryDir: string = DEFAULT_CONTROL_SESSION_DIR): void {
  const index = readControlSessionIndex(registryDir);
  const record = index.sessions[sessionKey];
  if (!record) return;
  index.sessions[sessionKey] = {
    ...record,
    active: false,
    updatedAt: new Date().toISOString(),
  };
  writeControlSessionIndex(registryDir, index);
  writeControlSessionReadme(registryDir, index);
}

export function readControlSessionIndex(registryDir: string = DEFAULT_CONTROL_SESSION_DIR): ControlSessionIndex {
  const indexPath = path.join(registryDir, 'index.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as Partial<ControlSessionIndex>;
    if (parsed.version === 1 && isRecord(parsed.sessions)) {
      return {
        version: 1,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
        sessions: parsed.sessions as Record<string, ControlSessionRecord>,
      };
    }
  } catch {
    // A missing or invalid index is rebuilt from future session updates.
  }
  return { version: 1, updatedAt: new Date(0).toISOString(), sessions: {} };
}

export function findCodexSessionFile(sessionId: string, codexHome: string = DEFAULT_CODEX_HOME): string | null {
  const sessionsDir = path.join(codexHome, 'sessions');
  if (!fs.existsSync(sessionsDir)) return null;
  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
        return entryPath;
      }
    }
  }
  return null;
}

export function formatControlSessions(index: ControlSessionIndex): string {
  const records = Object.values(index.sessions).sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
  if (records.length === 0) {
    return 'No Codex control sessions are registered yet.';
  }
  return records
    .map((record) => {
      const status = record.active ? 'active' : 'inactive';
      const file = record.codexJsonlPath ?? '(jsonl not found yet)';
      return [
        `${record.sessionKey} [${status}]`,
        `  session: ${record.sessionId}`,
        `  workdir: ${record.workdir}`,
        `  file: ${file}`,
      ].join('\n');
    })
    .join('\n\n');
}

function writeControlSessionIndex(registryDir: string, index: ControlSessionIndex): void {
  fs.mkdirSync(registryDir, { recursive: true });
  const nextIndex: ControlSessionIndex = {
    version: 1,
    updatedAt: new Date().toISOString(),
    sessions: index.sessions,
  };
  fs.writeFileSync(path.join(registryDir, 'index.json'), JSON.stringify(nextIndex, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

function updateSessionLink(linkPath: string | null, targetPath: string | null): void {
  if (!linkPath || !targetPath) return;
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.rmSync(linkPath, { force: true });
    fs.symlinkSync(targetPath, linkPath);
  } catch {
    fs.copyFileSync(targetPath, linkPath);
  }
}

function writeControlSessionReadme(registryDir: string, index: ControlSessionIndex): void {
  const body = [
    '# Doujie Control Sessions',
    '',
    'Codex stores the original session jsonl files under ~/.codex/sessions by creation date.',
    'This directory is the Doujie control-plane index for the active Feishu bindings.',
    '',
    '```',
    formatControlSessions(index),
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(registryDir, 'README.md'), body, 'utf-8');
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
