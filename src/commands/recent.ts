import type { CommandHandler, MessageContent } from '../types.js';
import type { Store } from '../store.js';
import { commandSection, commandTitle, compact, field, joinBlocks, numbered, shortId } from './format.js';

function parseLimit(args: string): number {
  const parsed = Number.parseInt(args.trim(), 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(Math.max(parsed, 1), 20);
}

export function createRecentHandler(store: Store): CommandHandler {
  return async (args: string, _message: MessageContent): Promise<string> => {
    const rows = store.getRecentMessages(parseLimit(args));
    if (rows.length === 0) return joinBlocks([commandTitle('最近消息'), '没有最近消息。']);
    const items = rows.map((row, index) => {
      const date = new Date(row.receivedAt).toLocaleString();
      return numbered(index + 1, compact(row.content, 72), [
        field('ID', `\`${shortId(row.id)}\``),
        field('Type', row.messageType),
        field('Time', date),
      ]);
    }).join('\n');
    return joinBlocks([
      commandTitle('最近消息', `显示 ${rows.length} 条`),
      commandSection('列表', [items]),
    ]);
  };
}
