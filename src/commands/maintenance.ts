import type { CommandHandler, MessageContent } from '../types.js';
import type { ExportMessagesOptions, Store } from '../store.js';
import {
  cleanupOldMessages,
  createVerifiedBackup,
  exportMessages,
  type ExportFormat,
} from '../maintenance.js';

export type MaintenanceRuntime = {
  backupDir: string;
  exportDir: string;
  clock?: () => number;
};

type ParsedExport =
  | { ok: true; options: ExportMessagesOptions & { format: ExportFormat } }
  | { ok: false; error: string };

type ParsedCleanup =
  | { ok: true; dryRun: boolean; cutoff: number; days: number }
  | { ok: false; error: string };

export function createBackupHandler(store: Store, runtime: MaintenanceRuntime): CommandHandler {
  return async (_args: string, _message: MessageContent): Promise<string> => {
    const result = await createVerifiedBackup(store, runtime.backupDir, runtime.clock);
    return `Backup complete: ${result.path}\nIntegrity: ${result.integrity}`;
  };
}

export function createExportHandler(store: Store, runtime: MaintenanceRuntime): CommandHandler {
  return async (args: string, _message: MessageContent): Promise<string> => {
    const parsed = parseExportArgs(args);
    if (!parsed.ok) return parsed.error;
    const result = exportMessages(store, runtime.exportDir, parsed.options, runtime.clock);
    return `Export complete: ${result.path}\nFormat: ${result.format}\nRecords: ${result.count}`;
  };
}

export function createCleanupHandler(store: Store, runtime: MaintenanceRuntime): CommandHandler {
  return async (args: string, _message: MessageContent): Promise<string> => {
    const parsed = parseCleanupArgs(args, runtime.clock ?? (() => Date.now()));
    if (!parsed.ok) return parsed.error;
    const result = cleanupOldMessages(store, { cutoff: parsed.cutoff, dryRun: parsed.dryRun });
    const mode = result.dryRun ? 'Cleanup dry-run' : 'Cleanup complete';
    return [
      `${mode}: messages older than ${parsed.days} day(s)`,
      `Messages: ${result.messages}`,
      `Processed: ${result.processed}`,
      `Jobs: ${result.processingJobs}`,
      `Message sources: ${result.messageSources}`,
      `Orphan sources: ${result.orphanSources}`,
    ].join('\n');
  };
}

function parseExportArgs(args: string): ParsedExport {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const keywordParts: string[] = [];
  const options: ExportMessagesOptions & { format: ExportFormat } = { keyword: '', format: 'jsonl', limit: 100 };

  for (const token of tokens) {
    const separator = token.indexOf(':');
    const key = separator > 0 ? token.slice(0, separator).toLowerCase() : '';
    const value = separator > 0 ? token.slice(separator + 1) : '';

    if (key === 'format') {
      if (value !== 'jsonl' && value !== 'md') return { ok: false, error: 'Usage: format:<jsonl|md>' };
      options.format = value;
    } else if (key === 'tag') {
      if (!value) return { ok: false, error: 'Usage: tag:<tag>' };
      options.tag = value;
    } else if (key === 'source') {
      if (!value) return { ok: false, error: 'Usage: source:<domain-or-url>' };
      options.source = value;
    } else if (key === 'limit') {
      const limit = Number.parseInt(value, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return { ok: false, error: 'Usage: limit:<1-1000>' };
      options.limit = limit;
    } else if (key === 'since') {
      const since = parseDate(value, false);
      if (since === null) return { ok: false, error: 'Usage: since:<YYYY-MM-DD>' };
      options.since = since;
    } else if (key === 'until') {
      const until = parseDate(value, true);
      if (until === null) return { ok: false, error: 'Usage: until:<YYYY-MM-DD>' };
      options.until = until;
    } else {
      keywordParts.push(token);
    }
  }

  options.keyword = keywordParts.join(' ');
  return { ok: true, options };
}

function parseCleanupArgs(args: string, clock: () => number): ParsedCleanup {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let dryRun = true;
  let days: number | null = null;
  for (const token of tokens) {
    if (token === 'dry-run') {
      dryRun = true;
    } else if (token === 'run') {
      dryRun = false;
    } else if (token.startsWith('messages:')) {
      const value = Number.parseInt(token.slice('messages:'.length), 10);
      if (!Number.isInteger(value) || value < 1) return { ok: false, error: 'Usage: messages:<days>' };
      days = value;
    } else {
      return { ok: false, error: 'Usage: /cleanup dry-run|run messages:<days>' };
    }
  }
  if (days === null) return { ok: false, error: 'Usage: /cleanup dry-run|run messages:<days>' };
  return { ok: true, dryRun, days, cutoff: clock() - days * 24 * 60 * 60 * 1000 };
}

function parseDate(value: string, endOfDay: boolean): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  const timestamp = Date.parse(`${value}${suffix}`);
  return Number.isFinite(timestamp) ? timestamp : null;
}
