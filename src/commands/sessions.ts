import type { CommandHandler, MessageContent } from '../types.js';
import { type ControlSessionRecord, readControlSessionIndex } from '../control-sessions.js';
import type { CommandRuntime } from './index.js';
import { commandSection, commandTitle, compact, field, joinBlocks, numbered, shortId } from './format.js';

export function createSessionsHandler(runtime: CommandRuntime): CommandHandler {
  return async (_args: string, message: MessageContent): Promise<string> => {
    const index = readControlSessionIndex(runtime.controlSessionDir);
    const currentKey = getCurrentSessionKey(message);
    const records = Object.values(index.sessions).sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (a.sessionKey === currentKey) return -1;
      if (b.sessionKey === currentKey) return 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    if (records.length === 0) {
      return joinBlocks([
        commandTitle('Codex Sessions'),
        commandSection('目录', [field('Control dir', `\`${runtime.controlSessionDir}\``)]),
        '还没有注册的 Codex control session。',
      ]);
    }
    const items = records.map((record, index) => {
      const labels = [record.active ? 'active' : 'inactive', record.sessionKey === currentKey ? 'current' : '']
        .filter(Boolean)
        .join(' ');
      const updated = new Date(record.updatedAt).toLocaleString();
      return numbered(index + 1, `${record.sessionKey} [${labels}]`, [
        field('Session', `\`${shortId(record.sessionId, 8, 8)}\``),
        field('Workdir', `\`${compact(record.workdir, 70)}\``),
        field('Updated', updated),
        field('File', record.codexJsonlPath ? `\`${compact(record.codexJsonlPath, 84)}\`` : '(jsonl not found yet)'),
      ]);
    }).join('\n');
    return joinBlocks([
      commandTitle('Codex Sessions', `共 ${records.length} 个绑定`),
      commandSection('目录', [field('Control dir', `\`${runtime.controlSessionDir}\``)]),
      commandSection('列表', [items]),
    ]);
  };
}

export function createSessionHandler(runtime: CommandRuntime): CommandHandler {
  return async (_args: string, message: MessageContent): Promise<string> => {
    const index = readControlSessionIndex(runtime.controlSessionDir);
    const currentKey = getCurrentSessionKey(message);
    const record = index.sessions[currentKey];
    if (!record) {
      return joinBlocks([
        commandTitle('当前 Codex Session'),
        commandSection('当前绑定', [
          field('Session key', `\`${currentKey}\``),
          field('Status', '未绑定'),
          field('Control dir', `\`${runtime.controlSessionDir}\``),
        ]),
        '当前飞书会话还没有登记过 Codex session。发送一条 Codex 请求后会自动创建绑定。',
      ]);
    }
    return formatCurrentSession(record, currentKey, runtime.controlSessionDir);
  };
}

function formatCurrentSession(record: ControlSessionRecord, currentKey: string, controlSessionDir: string): string {
  return joinBlocks([
    commandTitle('当前 Codex Session'),
    commandSection('绑定', [
      field('Session key', `\`${currentKey}\``),
      field('Status', record.active ? 'active' : 'inactive'),
      field('Session ID', `\`${record.sessionId}\``),
      field('Workdir', `\`${record.workdir}\``),
      field('Project', projectName(record.workdir)),
      field('Updated', new Date(record.updatedAt).toLocaleString()),
    ]),
    commandSection('文件', [
      field('JSONL', record.codexJsonlPath ? `\`${record.codexJsonlPath}\`` : '(jsonl not found yet)'),
      field('Link', record.linkPath ? `\`${record.linkPath}\`` : '(link not found yet)'),
      field('Control dir', `\`${controlSessionDir}\``),
    ]),
  ]);
}

function getCurrentSessionKey(message: MessageContent): string {
  if (message.chatType === 'group') return message.chatId;
  return `${message.chatId}:${message.senderId}`;
}

function projectName(workdir: string): string {
  const parts = workdir.split('/').filter(Boolean);
  return parts.at(-1) ?? workdir;
}
