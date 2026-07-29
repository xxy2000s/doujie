import type { CommandHandler, MessageContent } from '../types.js';
import type { Store } from '../store.js';

function parseLimit(args: string): number {
  const parsed = Number.parseInt(args.trim(), 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(Math.max(parsed, 1), 20);
}

function preview(value: string): string {
  return value.replace(/\s+/g, ' ').slice(0, 60);
}

export function createRecentHandler(store: Store): CommandHandler {
  return async (args: string, _message: MessageContent): Promise<string> => {
    const rows = store.getRecentMessages(parseLimit(args));
    if (rows.length === 0) return 'No recent messages.';
    return rows.map((row, index) => {
      const date = new Date(row.receivedAt).toLocaleString();
      return `${index + 1}. ${row.id} [${row.messageType}] ${date} ${preview(row.content)}`;
    }).join('\n');
  };
}

