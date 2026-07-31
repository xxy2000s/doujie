import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AgentProvider = 'codex' | 'claude';

export type AgentSessionLaunch = {
  model: string;
  sandbox: string;
  skipGitRepoCheck?: boolean;
  permissionMode: string;
  outputFormat: string;
};

export type AgentSessionRecord = {
  alias: string;
  provider: AgentProvider;
  nativeSessionId: string;
  cwd: string;
  jsonlPath: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  createdBy: {
    chatId: string;
    senderId: string;
  };
  launch: AgentSessionLaunch;
};

export type AgentSessionRegistry = {
  version: 1;
  updatedAt: string;
  sessions: Record<string, AgentSessionRecord>;
};

export const DEFAULT_AGENT_SESSION_REGISTRY_PATH = path.join(os.homedir(), '.doujie', 'agent-sessions.json');

export class AgentSessionRegistryStore {
  constructor(private readonly registryPath: string = DEFAULT_AGENT_SESSION_REGISTRY_PATH) {}

  get path(): string {
    return this.registryPath;
  }

  read(): AgentSessionRegistry {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8')) as Partial<AgentSessionRegistry>;
      if (parsed.version === 1 && isRecord(parsed.sessions)) {
        return {
          version: 1,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
          sessions: parsed.sessions as Record<string, AgentSessionRecord>,
        };
      }
    } catch {
      // Missing or invalid registries are replaced on next successful write.
    }
    return { version: 1, updatedAt: new Date(0).toISOString(), sessions: {} };
  }

  list(): AgentSessionRecord[] {
    return Object.values(this.read().sessions).sort((left, right) => {
      return right.updatedAt.localeCompare(left.updatedAt) || left.alias.localeCompare(right.alias);
    });
  }

  get(alias: string): AgentSessionRecord | null {
    return this.read().sessions[normalizeAlias(alias)] ?? null;
  }

  upsert(record: AgentSessionRecord): AgentSessionRecord {
    const registry = this.read();
    const now = new Date().toISOString();
    const key = normalizeAlias(record.alias);
    const existing = registry.sessions[key];
    const next: AgentSessionRecord = {
      ...record,
      alias: key,
      createdAt: existing?.createdAt ?? record.createdAt,
      updatedAt: now,
    };
    registry.sessions[key] = next;
    this.write(registry);
    return next;
  }

  markUsed(alias: string, now: Date = new Date()): AgentSessionRecord | null {
    const registry = this.read();
    const key = normalizeAlias(alias);
    const record = registry.sessions[key];
    if (!record) return null;
    const updated = now.toISOString();
    registry.sessions[key] = {
      ...record,
      updatedAt: updated,
      lastUsedAt: updated,
    };
    this.write(registry);
    return registry.sessions[key];
  }

  private write(registry: AgentSessionRegistry): void {
    const next: AgentSessionRegistry = {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: registry.sessions,
    };
    fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
    fs.writeFileSync(this.registryPath, JSON.stringify(next, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }
}

export function normalizeAlias(alias: string): string {
  return alias.trim();
}

export function validateAgentAlias(alias: string): string | null {
  const normalized = normalizeAlias(alias);
  if (!normalized) return 'alias is required';
  if (normalized.length > 80) return 'alias must be 80 characters or fewer';
  if (!/^[\p{L}\p{N}._-]+$/u.test(normalized)) {
    return 'alias may only contain letters, numbers, dot, underscore, and hyphen';
  }
  return null;
}

export function formatAgentSessionRecord(record: AgentSessionRecord): string {
  return [
    `**Alias:** \`${record.alias}\``,
    `**Provider:** ${record.provider}`,
    `**Session:** \`${record.nativeSessionId}\``,
    `**CWD:** \`${record.cwd}\``,
    `**Permission:** ${record.provider === 'codex' ? record.launch.sandbox : record.launch.permissionMode}`,
    `**JSONL:** ${record.jsonlPath ? `\`${record.jsonlPath}\`` : '(not found yet)'}`,
    `**Updated:** ${record.updatedAt}`,
  ].join('\n');
}

export function formatAgentSessionList(records: AgentSessionRecord[]): string {
  if (records.length === 0) return '还没有登记的项目 Agent session。';
  return records
    .map((record) => {
      return [
        `- \`${record.alias}\` [${record.provider}]`,
        `  session: \`${record.nativeSessionId}\``,
        `  cwd: \`${record.cwd}\``,
        `  updated: ${record.updatedAt}`,
      ].join('\n');
    })
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
