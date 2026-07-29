import type { CommandHandler, MessageContent } from '../types.js';
import type { Store } from '../store.js';

function parseLimit(args: string): number {
  const parsed = Number.parseInt(args.trim(), 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(Math.max(parsed, 1), 20);
}

function preview(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').slice(0, 80) || '(no error)';
}

export function createErrorsHandler(store: Store): CommandHandler {
  return async (args: string, _message: MessageContent): Promise<string> => {
    const rows = store.getRecentFailedJobs(parseLimit(args));
    if (rows.length === 0) return 'No recent errors.';
    return rows.map((row, index) => {
      const date = new Date(row.updatedAt).toLocaleString();
      return `${index + 1}. ${row.messageId} mode=${row.mode} stage=${row.stage} retries=${row.retryCount} ${date} ${preview(row.lastError)}`;
    }).join('\n');
  };
}
