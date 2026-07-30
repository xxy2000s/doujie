import type { CommandHandler, MessageContent } from '../types.js';
import type { Store } from '../store.js';
import { commandSection, commandTitle, compact, field, joinBlocks, numbered, shortId } from './format.js';

function parseLimit(args: string): number {
  const parsed = Number.parseInt(args.trim(), 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(Math.max(parsed, 1), 20);
}

export function createErrorsHandler(store: Store): CommandHandler {
  return async (args: string, _message: MessageContent): Promise<string> => {
    const rows = store.getRecentFailedJobs(parseLimit(args));
    if (rows.length === 0) return joinBlocks([commandTitle('最近错误'), '没有最近错误。']);
    const items = rows.map((row, index) => {
      const date = new Date(row.updatedAt).toLocaleString();
      return numbered(index + 1, compact(row.lastError, 90), [
        field('ID', `\`${shortId(row.messageId)}\``),
        field('Mode', row.mode),
        field('Stage', row.stage),
        field('Retries', row.retryCount),
        field('Updated', date),
      ]);
    }).join('\n');
    return joinBlocks([
      commandTitle('最近错误', `显示 ${rows.length} 条失败任务`),
      commandSection('列表', [items]),
    ]);
  };
}
