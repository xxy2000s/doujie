import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { CleanupResult, ExportMessagesOptions, SearchMessageResult, Store } from './store.js';

export type BackupResult = {
  path: string;
  integrity: string;
};

export type ExportFormat = 'jsonl' | 'md';

export type ExportResult = {
  path: string;
  format: ExportFormat;
  count: number;
};

export type CleanupOptions = {
  cutoff: number;
  dryRun: boolean;
};

export async function createVerifiedBackup(
  store: Store,
  backupDir: string,
  clock: () => number = () => Date.now()
): Promise<BackupResult> {
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `doujie-${clock()}.db`);
  await store.backupDatabase(backupPath);
  const integrity = verifySqliteDatabase(backupPath);
  if (integrity !== 'ok') {
    throw new Error(`Backup integrity check failed: ${integrity}`);
  }
  return { path: backupPath, integrity };
}

export function exportMessages(
  store: Store,
  exportDir: string,
  options: ExportMessagesOptions & { format: ExportFormat },
  clock: () => number = () => Date.now()
): ExportResult {
  fs.mkdirSync(exportDir, { recursive: true });
  const rows = store.getMessagesForExport(options);
  const extension = options.format === 'md' ? 'md' : 'jsonl';
  const exportPath = path.join(exportDir, `doujie-export-${clock()}.${extension}`);
  const body = options.format === 'md' ? renderMarkdown(rows) : renderJsonl(rows);
  fs.writeFileSync(exportPath, body, 'utf-8');
  return { path: exportPath, format: options.format, count: rows.length };
}

export function cleanupOldMessages(store: Store, options: CleanupOptions): CleanupResult {
  return store.cleanupMessagesBefore(options.cutoff, options.dryRun);
}

function verifySqliteDatabase(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
    return row?.integrity_check ?? 'missing integrity_check result';
  } finally {
    db.close();
  }
}

function renderJsonl(rows: SearchMessageResult[]): string {
  return rows.map((row) => JSON.stringify(exportRow(row))).join('\n') + (rows.length > 0 ? '\n' : '');
}

function renderMarkdown(rows: SearchMessageResult[]): string {
  const parts = ['# Doujie Export', ''];
  for (const row of rows) {
    parts.push(`## ${row.id}`, '');
    parts.push(`- Received: ${new Date(row.receivedAt).toISOString()}`);
    if (row.tags) parts.push(`- Tags: ${parseJsonArray(row.tags).join(', ')}`);
    if (row.sources) parts.push(`- Sources: ${row.sources}`);
    parts.push('');
    parts.push(row.summary ? `**Summary:** ${row.summary}` : '**Summary:**');
    parts.push('');
    parts.push(row.content);
    parts.push('');
  }
  return parts.join('\n');
}

function exportRow(row: SearchMessageResult): Record<string, unknown> {
  return {
    id: row.id,
    receivedAt: row.receivedAt,
    content: row.content,
    summary: row.summary,
    tags: parseJsonArray(row.tags),
    keyPoints: parseJsonArray(row.keyPoints),
    actionItems: parseJsonArray(row.actionItems),
    entities: parseJsonArray(row.entities),
    sourceType: row.sourceType,
    confidence: row.confidence,
    schemaVersion: row.schemaVersion,
    sources: row.sources ? row.sources.split(',') : [],
  };
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}
