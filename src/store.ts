import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import type {
  ProcessedMessage,
  ProcessingJob,
  ProcessingMode,
  ProcessingStatus,
  SourceInput,
  SourceRecord,
} from './types.js';

export const CURRENT_SCHEMA_VERSION = 9;

type Migration = {
  version: number;
  name: string;
  up(db: Database.Database): void;
};

type StoreOptions = {
  disableFts?: boolean;
};

export type SearchMessagesOptions = {
  keyword: string;
  limit?: number;
  tag?: string;
  since?: number;
  until?: number;
  source?: string;
};

export type ExportMessagesOptions = SearchMessagesOptions;

export type SearchMessageResult = {
  id: string;
  content: string;
  summary: string | null;
  tags: string | null;
  keyPoints: string | null;
  actionItems: string | null;
  entities: string | null;
  sourceType: string | null;
  confidence: number | null;
  schemaVersion: number | null;
  sources: string | null;
  receivedAt: number;
};

export type MessageDetail = {
  id: string;
  chatId: string;
  senderId: string;
  content: string;
  messageType: string;
  receivedAt: number;
  processed: {
    id: string;
    summary: string | null;
    tags: string | null;
    keyPoints: string | null;
    actionItems: string | null;
    entities: string | null;
    sourceType: string | null;
    confidence: number | null;
    schemaVersion: number | null;
    processedAt: number;
  } | null;
  sources: SourceRecord[];
  attachments: AttachmentRecord[];
};

export type RetagMessageResult = {
  updated: boolean;
  previousTags: string[];
  newTags: string[];
};

export type MergeTagResult = {
  alias: string;
  canonicalTag: string;
  updatedMessages: number;
};

export type TagAliasRecord = {
  alias: string;
  canonicalTag: string;
  createdAt: number;
  updatedAt: number;
};

export type CleanupResult = {
  dryRun: boolean;
  cutoff: number;
  messages: number;
  processed: number;
  processingJobs: number;
  messageSources: number;
  orphanSources: number;
};

export type AttachmentInput = {
  messageId: string;
  resourceKey: string;
  resourceType: 'image' | 'file';
  fileName: string | null;
  mime: string | null;
  size: number | null;
  downloadStatus: 'pending' | 'downloaded' | 'failed';
  localPath: string | null;
  error: string | null;
  extractionStatus?: 'pending' | 'extracted' | 'skipped' | 'failed';
  extractedText?: string | null;
  extractionError?: string | null;
};

export type AttachmentRecord = AttachmentInput & {
  id: string;
  createdAt: number;
  updatedAt: number;
};

type NormalizedSearchOptions = {
  keyword: string;
  keywordLike: string;
  limit: number;
  tag: string | null;
  tagLike: string | null;
  since: number | null;
  until: number | null;
  source: string | null;
  sourceLike: string | null;
};

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').trim();
}

function parseTagJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .map(normalizeTag)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function serializeTags(tags: string[]): string {
  return JSON.stringify(tags);
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'create_mvp_schema',
    up(db: Database.Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          content TEXT NOT NULL,
          message_type TEXT NOT NULL,
          raw_event TEXT,
          received_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS processed (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id),
          summary TEXT,
          tags TEXT,
          processed_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    name: 'create_processing_jobs',
    up(db: Database.Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS processing_jobs (
          message_id TEXT PRIMARY KEY REFERENCES messages(id),
          status TEXT NOT NULL,
          stage TEXT NOT NULL,
          retry_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          locked_at INTEGER,
          completed_at INTEGER,
          reply_sent_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    name: 'add_processing_mode',
    up(db: Database.Database): void {
      db.exec(`
        ALTER TABLE processing_jobs
        ADD COLUMN mode TEXT NOT NULL DEFAULT 'default';
      `);
    },
  },
  {
    version: 4,
    name: 'create_sources',
    up(db: Database.Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sources (
          id TEXT PRIMARY KEY,
          canonical_url TEXT NOT NULL UNIQUE,
          original_url TEXT NOT NULL,
          final_url TEXT,
          domain TEXT NOT NULL,
          title TEXT,
          fetch_status TEXT NOT NULL,
          content_length INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS message_sources (
          message_id TEXT NOT NULL REFERENCES messages(id),
          source_id TEXT NOT NULL REFERENCES sources(id),
          original_url TEXT NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY (message_id, source_id)
        );
      `);
    },
  },
  {
    version: 5,
    name: 'create_message_fts',
    up(db: Database.Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS search_diagnostics (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      const now = Date.now();
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
            message_id UNINDEXED,
            content,
            summary,
            tags,
            tokenize='unicode61'
          );

          DELETE FROM message_fts;

          INSERT INTO message_fts (message_id, content, summary, tags)
          SELECT
            m.id,
            m.content,
            COALESCE(p.summary, ''),
            COALESCE(p.tags, '')
          FROM messages m
          LEFT JOIN processed p ON p.message_id = m.id;
        `);
        db.prepare(`
          INSERT OR REPLACE INTO search_diagnostics (key, value, updated_at)
          VALUES ('fts_available', 'true', @now)
        `).run({ now });
      } catch (err) {
        db.prepare(`
          INSERT OR REPLACE INTO search_diagnostics (key, value, updated_at)
          VALUES ('fts_available', 'false', @now)
        `).run({ now });
        db.prepare(`
          INSERT OR REPLACE INTO search_diagnostics (key, value, updated_at)
          VALUES ('fts_error', @error, @now)
        `).run({ error: (err as Error).message, now });
      }
    },
  },
  {
    version: 6,
    name: 'add_structured_processed_fields',
    up(db: Database.Database): void {
      db.exec(`
        ALTER TABLE processed ADD COLUMN key_points TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE processed ADD COLUMN action_items TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE processed ADD COLUMN entities TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE processed ADD COLUMN source_type TEXT;
        ALTER TABLE processed ADD COLUMN confidence REAL;
        ALTER TABLE processed ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
      `);

      const now = Date.now();
      try {
        db.exec(`
          DROP TABLE IF EXISTS message_fts;
          CREATE VIRTUAL TABLE message_fts USING fts5(
            message_id UNINDEXED,
            content,
            summary,
            tags,
            action_items,
            entities,
            tokenize='unicode61'
          );

          INSERT INTO message_fts (message_id, content, summary, tags, action_items, entities)
          SELECT
            m.id,
            m.content,
            COALESCE(p.summary, ''),
            COALESCE(p.tags, ''),
            COALESCE(p.action_items, ''),
            COALESCE(p.entities, '')
          FROM messages m
          LEFT JOIN processed p ON p.message_id = m.id;
        `);
        db.prepare(`
          INSERT OR REPLACE INTO search_diagnostics (key, value, updated_at)
          VALUES ('fts_available', 'true', @now)
        `).run({ now });
      } catch (err) {
        db.prepare(`
          INSERT OR REPLACE INTO search_diagnostics (key, value, updated_at)
          VALUES ('fts_available', 'false', @now)
        `).run({ now });
        db.prepare(`
          INSERT OR REPLACE INTO search_diagnostics (key, value, updated_at)
          VALUES ('fts_error', @error, @now)
        `).run({ error: (err as Error).message, now });
      }
    },
  },
  {
    version: 7,
    name: 'create_tag_feedback',
    up(db: Database.Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tag_aliases (
          alias TEXT PRIMARY KEY,
          canonical_tag TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tag_feedback (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id),
          previous_tags TEXT NOT NULL,
          new_tags TEXT NOT NULL,
          reason TEXT,
          created_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 8,
    name: 'create_attachments',
    up(db: Database.Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS attachments (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id),
          resource_key TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          file_name TEXT,
          mime TEXT,
          size INTEGER,
          download_status TEXT NOT NULL,
          local_path TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
      `);
    },
  },
  {
    version: 9,
    name: 'add_attachment_extraction',
    up(db: Database.Database): void {
      db.exec(`
        ALTER TABLE attachments ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'pending';
        ALTER TABLE attachments ADD COLUMN extracted_text TEXT;
        ALTER TABLE attachments ADD COLUMN extraction_error TEXT;
      `);
    },
  },
];

export class Store {
  private db: Database.Database;
  private clock: () => number;
  private disableFts: boolean;

  constructor(dbPath: string, clock: () => number = () => Date.now(), options: StoreOptions = {}) {
    this.clock = clock;
    this.disableFts = options.disableFts ?? false;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.runMigrations();
    if (this.disableFts) {
      this.setSearchDiagnostic('fts_available', 'false');
      this.setSearchDiagnostic('fts_error', 'disabled by Store options');
    }
  }

  private ensureMigrationTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
  }

  private getSchemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  private setSchemaVersion(version: number): void {
    this.db.pragma(`user_version = ${version}`);
  }

  private runMigrations(): void {
    this.ensureMigrationTable();
    const currentVersion = this.getSchemaVersion();
    if (currentVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${currentVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`
      );
    }

    for (const migration of MIGRATIONS) {
      if (migration.version > currentVersion) {
        this.applyMigration(migration);
      }
    }
  }

  private applyMigration(migration: Migration): void {
    const apply = this.db.transaction(() => {
      migration.up(this.db);
      this.db.prepare(`
        INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
        VALUES (@version, @name, @appliedAt)
      `).run({
        version: migration.version,
        name: migration.name,
        appliedAt: this.clock(),
      });
      this.setSchemaVersion(migration.version);
    });
    apply();
  }

  /** Save a raw message. Silently skips duplicates (UNIQUE constraint). */
  saveMessage(params: {
    id: string;
    chatId: string;
    senderId: string;
    content: string;
    messageType: string;
    rawEvent: string;
  }): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (id, chat_id, sender_id, content, message_type, raw_event, received_at)
      VALUES (@id, @chatId, @senderId, @content, @messageType, @rawEvent, @receivedAt)
    `);
    const result = stmt.run({
      id: params.id,
      chatId: params.chatId,
      senderId: params.senderId,
      content: params.content,
      messageType: params.messageType,
      rawEvent: params.rawEvent,
      receivedAt: this.clock(),
    });
    if (result.changes > 0) {
      this.syncSearchIndex(params.id);
    }
    return result.changes > 0;
  }

  /** Replace message content while keeping the original raw event for audit/retry. */
  updateMessageContent(messageId: string, content: string): void {
    this.db.prepare(`
      UPDATE messages
      SET content = @content
      WHERE id = @messageId
    `).run({ messageId, content });
    this.syncSearchIndex(messageId);
  }

  /** Save a processed result. */
  saveProcessed(result: ProcessedMessage): void {
    const tags = this.canonicalizeTags(result.tags);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO processed (
        id, message_id, summary, tags, key_points, action_items, entities,
        source_type, confidence, schema_version, processed_at
      )
      VALUES (
        @id, @messageId, @summary, @tags, @keyPoints, @actionItems, @entities,
        @sourceType, @confidence, @schemaVersion, @processedAt
      )
    `);
    stmt.run({
      id: result.id,
      messageId: result.messageId,
      summary: result.summary,
      tags: serializeTags(tags),
      keyPoints: JSON.stringify(result.keyPoints ?? []),
      actionItems: JSON.stringify(result.actionItems ?? []),
      entities: JSON.stringify(result.entities ?? []),
      sourceType: result.sourceType ?? null,
      confidence: result.confidence ?? null,
      schemaVersion: result.schemaVersion ?? 1,
      processedAt: result.processedAt,
    });
    this.syncSearchIndex(result.messageId);
  }

  resolveTag(tag: string): string {
    const normalized = normalizeTag(tag);
    if (!normalized) return '';
    const row = this.db.prepare(`
      SELECT canonical_tag as canonicalTag
      FROM tag_aliases
      WHERE alias = @alias
    `).get({ alias: normalized }) as { canonicalTag: string } | undefined;
    return row?.canonicalTag ?? normalized;
  }

  canonicalizeTags(tags: string[]): string[] {
    const canonicalTags: string[] = [];
    const seen = new Set<string>();
    for (const tag of tags) {
      const canonical = this.resolveTag(tag);
      if (!canonical || seen.has(canonical)) continue;
      seen.add(canonical);
      canonicalTags.push(canonical);
    }
    return canonicalTags;
  }

  retagMessage(messageId: string, tags: string[], reason: string | null = null): RetagMessageResult {
    const row = this.db.prepare(`
      SELECT tags
      FROM processed
      WHERE message_id = @messageId
    `).get({ messageId }) as { tags: string | null } | undefined;
    if (!row) {
      return { updated: false, previousTags: [], newTags: [] };
    }

    const previousTags = parseTagJson(row.tags);
    const newTags = this.canonicalizeTags(tags);
    const now = this.clock();
    const feedbackCount = this.db.prepare('SELECT COUNT(*) as count FROM tag_feedback').get() as { count: number };
    const update = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE processed
        SET tags = @tags
        WHERE message_id = @messageId
      `).run({ messageId, tags: serializeTags(newTags) });
      this.db.prepare(`
        INSERT INTO tag_feedback (id, message_id, previous_tags, new_tags, reason, created_at)
        VALUES (@id, @messageId, @previousTags, @newTags, @reason, @createdAt)
      `).run({
        id: `${messageId}-tag-feedback-${now}-${feedbackCount.count + 1}`,
        messageId,
        previousTags: serializeTags(previousTags),
        newTags: serializeTags(newTags),
        reason,
        createdAt: now,
      });
    });
    update();
    this.syncSearchIndex(messageId);
    return { updated: true, previousTags, newTags };
  }

  mergeTag(alias: string, canonical: string): MergeTagResult {
    const normalizedAlias = normalizeTag(alias);
    const canonicalTag = this.resolveTag(canonical);
    if (!normalizedAlias || !canonicalTag || normalizedAlias === canonicalTag) {
      return { alias: normalizedAlias, canonicalTag, updatedMessages: 0 };
    }

    const now = this.clock();
    const rows = this.db.prepare(`
      SELECT message_id as messageId, tags
      FROM processed
      ORDER BY message_id ASC
    `).all() as Array<{ messageId: string; tags: string | null }>;
    const changedRows: Array<{ messageId: string; tags: string[] }> = [];

    const merge = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO tag_aliases (alias, canonical_tag, created_at, updated_at)
        VALUES (@alias, @canonicalTag, @now, @now)
        ON CONFLICT(alias) DO UPDATE SET
          canonical_tag = excluded.canonical_tag,
          updated_at = excluded.updated_at
      `).run({ alias: normalizedAlias, canonicalTag, now });

      for (const row of rows) {
        const currentTags = parseTagJson(row.tags);
        const nextTags = this.canonicalizeTags(currentTags);
        if (serializeTags(currentTags) === serializeTags(nextTags)) continue;
        this.db.prepare(`
          UPDATE processed
          SET tags = @tags
          WHERE message_id = @messageId
        `).run({ messageId: row.messageId, tags: serializeTags(nextTags) });
        changedRows.push({ messageId: row.messageId, tags: nextTags });
      }
    });
    merge();

    for (const row of changedRows) {
      this.syncSearchIndex(row.messageId);
    }
    return { alias: normalizedAlias, canonicalTag, updatedMessages: changedRows.length };
  }

  getTagAliases(): TagAliasRecord[] {
    return this.db.prepare(`
      SELECT alias, canonical_tag as canonicalTag, created_at as createdAt, updated_at as updatedAt
      FROM tag_aliases
      ORDER BY alias ASC
    `).all() as TagAliasRecord[];
  }

  getTagFeedback(messageId?: string): Array<{
    id: string;
    messageId: string;
    previousTags: string;
    newTags: string;
    reason: string | null;
    createdAt: number;
  }> {
    const where = messageId ? 'WHERE message_id = @messageId' : '';
    const params = messageId ? { messageId } : {};
    return this.db.prepare(`
      SELECT
        id,
        message_id as messageId,
        previous_tags as previousTags,
        new_tags as newTags,
        reason,
        created_at as createdAt
      FROM tag_feedback
      ${where}
      ORDER BY created_at ASC, id ASC
    `).all(params) as Array<{
      id: string;
      messageId: string;
      previousTags: string;
      newTags: string;
      reason: string | null;
      createdAt: number;
    }>;
  }

  getFrequentTags(limit: number = 8): Array<{ tag: string; count: number }> {
    const counts = new Map<string, number>();
    const rows = this.db.prepare('SELECT tags FROM processed').all() as Array<{ tags: string | null }>;
    for (const row of rows) {
      for (const tag of this.canonicalizeTags(parseTagJson(row.tags))) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, Math.max(0, limit));
  }

  getTagPromptContext(): string | null {
    const tags = this.getFrequentTags(8);
    const aliases = this.getTagAliases().slice(0, 8);
    if (tags.length === 0 && aliases.length === 0) return null;

    const lines = ['[Doujie tag hints]'];
    if (tags.length > 0) {
      lines.push(`Frequent tags: ${tags.map((item) => `${this.promptSafeTag(item.tag)}(${item.count})`).join(', ')}`);
    }
    if (aliases.length > 0) {
      lines.push(
        `Aliases: ${aliases
          .map((item) => `${this.promptSafeTag(item.alias)} -> ${this.promptSafeTag(item.canonicalTag)}`)
          .join(', ')}`
      );
    }
    lines.push('Prefer existing tags when they fit; create a new concise tag only when needed.');
    return lines.join('\n');
  }

  private promptSafeTag(tag: string): string {
    return tag.replace(/[\r\n\t]+/g, ' ').trim();
  }

  /** Persist a source URL and link it to a message. */
  saveSourceForMessage(messageId: string, source: SourceInput, position: number): void {
    const now = this.clock();
    const save = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO sources (
          id, canonical_url, original_url, final_url, domain, title, fetch_status,
          content_length, error, created_at, updated_at
        )
        VALUES (
          @id, @canonicalUrl, @originalUrl, @finalUrl, @domain, @title, @fetchStatus,
          @contentLength, @error, @now, @now
        )
        ON CONFLICT(id) DO UPDATE SET
          original_url = excluded.original_url,
          final_url = excluded.final_url,
          domain = excluded.domain,
          title = excluded.title,
          fetch_status = excluded.fetch_status,
          content_length = excluded.content_length,
          error = excluded.error,
          updated_at = excluded.updated_at
      `).run({
        id: source.canonicalUrl,
        canonicalUrl: source.canonicalUrl,
        originalUrl: source.originalUrl,
        finalUrl: source.finalUrl,
        domain: source.domain,
        title: source.title,
        fetchStatus: source.fetchStatus,
        contentLength: source.contentLength,
        error: source.error,
        now,
      });

      this.db.prepare(`
        INSERT OR IGNORE INTO message_sources (message_id, source_id, original_url, position)
        VALUES (@messageId, @sourceId, @originalUrl, @position)
      `).run({
        messageId,
        sourceId: source.canonicalUrl,
        originalUrl: source.originalUrl,
        position,
      });
    });
    save();
  }

  getSourcesForMessage(messageId: string): SourceRecord[] {
    return this.db.prepare(`
      SELECT
        s.id,
        ms.message_id as messageId,
        ms.position,
        s.canonical_url as canonicalUrl,
        s.original_url as originalUrl,
        s.final_url as finalUrl,
        s.domain,
        s.title,
        s.fetch_status as fetchStatus,
        s.content_length as contentLength,
        s.error,
        s.created_at as createdAt,
        s.updated_at as updatedAt
      FROM message_sources ms
      JOIN sources s ON s.id = ms.source_id
      WHERE ms.message_id = @messageId
      ORDER BY ms.position ASC, s.canonical_url ASC
    `).all({ messageId }) as SourceRecord[];
  }

  saveAttachment(input: AttachmentInput): void {
    const now = this.clock();
    this.db.prepare(`
      INSERT INTO attachments (
        id, message_id, resource_key, resource_type, file_name, mime, size,
        download_status, local_path, error, extraction_status, extracted_text, extraction_error, created_at, updated_at
      )
      VALUES (
        @id, @messageId, @resourceKey, @resourceType, @fileName, @mime, @size,
        @downloadStatus, @localPath, @error, @extractionStatus, @extractedText, @extractionError, @now, @now
      )
      ON CONFLICT(id) DO UPDATE SET
        resource_type = excluded.resource_type,
        file_name = excluded.file_name,
        mime = excluded.mime,
        size = excluded.size,
        download_status = excluded.download_status,
        local_path = excluded.local_path,
        error = excluded.error,
        extraction_status = excluded.extraction_status,
        extracted_text = excluded.extracted_text,
        extraction_error = excluded.extraction_error,
        updated_at = excluded.updated_at
    `).run({
      id: `${input.messageId}:${input.resourceKey}`,
      ...input,
      extractionStatus: input.extractionStatus ?? 'pending',
      extractedText: input.extractedText ?? null,
      extractionError: input.extractionError ?? null,
      now,
    });
  }

  updateAttachmentExtraction(
    messageId: string,
    resourceKey: string,
    params: { status: 'extracted' | 'skipped' | 'failed'; text?: string | null; error?: string | null }
  ): void {
    this.db.prepare(`
      UPDATE attachments
      SET extraction_status = @status,
          extracted_text = @text,
          extraction_error = @error,
          updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id: `${messageId}:${resourceKey}`,
      status: params.status,
      text: params.text ?? null,
      error: params.error ?? null,
      updatedAt: this.clock(),
    });
  }

  getExtractedAttachmentText(messageId: string): Array<{ fileName: string | null; text: string }> {
    return this.db.prepare(`
      SELECT file_name as fileName, extracted_text as text
      FROM attachments
      WHERE message_id = @messageId
        AND extraction_status = 'extracted'
        AND extracted_text IS NOT NULL
      ORDER BY resource_key ASC
    `).all({ messageId }) as Array<{ fileName: string | null; text: string }>;
  }

  getAttachmentsForMessage(messageId: string): AttachmentRecord[] {
    return this.db.prepare(`
      SELECT
        id,
        message_id as messageId,
        resource_key as resourceKey,
        resource_type as resourceType,
        file_name as fileName,
        mime,
        size,
        download_status as downloadStatus,
        local_path as localPath,
        error,
        extraction_status as extractionStatus,
        extracted_text as extractedText,
        extraction_error as extractionError,
        created_at as createdAt,
        updated_at as updatedAt
      FROM attachments
      WHERE message_id = @messageId
      ORDER BY resource_key ASC
    `).all({ messageId }) as AttachmentRecord[];
  }

  /** Create a processing job for a newly received message. */
  createProcessingJob(messageId: string): void {
    const now = this.clock();
    this.db.prepare(`
      INSERT OR IGNORE INTO processing_jobs (
        message_id, status, stage, mode, retry_count, created_at, updated_at
      )
      VALUES (@messageId, 'pending', 'received', 'default', 0, @now, @now)
    `).run({ messageId, now });
  }

  /** Record the high-level processing mode for diagnostics. */
  setProcessingMode(messageId: string, mode: ProcessingMode): void {
    const now = this.clock();
    this.db.prepare(`
      UPDATE processing_jobs
      SET mode = @mode,
          updated_at = @now
      WHERE message_id = @messageId
    `).run({ messageId, mode, now });
  }

  /** Mark a message as actively processing at a specific stage. */
  markProcessing(messageId: string, stage: string): void {
    const now = this.clock();
    this.updateProcessingJob(messageId, {
      status: 'processing',
      stage,
      lockedAt: now,
      updatedAt: now,
    });
  }

  /** Mark AI/storage processing as complete before reply. */
  markProcessed(messageId: string): void {
    const now = this.clock();
    this.updateProcessingJob(messageId, {
      status: 'processed',
      stage: 'store_processed',
      completedAt: now,
      updatedAt: now,
    });
  }

  /** Mark the final reply as sent. */
  markReplied(messageId: string): void {
    const now = this.clock();
    this.updateProcessingJob(messageId, {
      status: 'replied',
      stage: 'reply',
      completedAt: now,
      replySentAt: now,
      lockedAt: null,
      lastError: null,
      updatedAt: now,
    });
  }

  /** Mark a message intentionally skipped by privacy rules and preserve the reason. */
  markPrivacySkipped(messageId: string, reason: string): void {
    const now = this.clock();
    this.updateProcessingJob(messageId, {
      status: 'replied',
      stage: 'privacy_skip',
      mode: 'skip',
      completedAt: now,
      replySentAt: now,
      lockedAt: null,
      lastError: reason,
      updatedAt: now,
    });
  }

  /** Record processing failure and increment retry count. */
  markFailed(messageId: string, stage: string, error: string): void {
    const now = this.clock();
    this.db.prepare(`
      UPDATE processing_jobs
      SET status = 'failed',
          stage = @stage,
          retry_count = retry_count + 1,
          last_error = @error,
          locked_at = NULL,
          updated_at = @now
      WHERE message_id = @messageId
    `).run({ messageId, stage, error, now });
  }

  /** Prepare a failed job for retry. Returns false when retry is not allowed. */
  prepareRetry(messageId: string): boolean {
    const now = this.clock();
    const result = this.db.prepare(`
      UPDATE processing_jobs
      SET status = 'retrying',
          stage = 'retry',
          mode = 'retry',
          last_error = NULL,
          locked_at = NULL,
          updated_at = @now
      WHERE message_id = @messageId AND status = 'failed'
    `).run({ messageId, now });
    return result.changes > 0;
  }

  /** Prepare any non-active existing job for manual redo. */
  prepareRedo(messageId: string): boolean {
    const now = this.clock();
    const result = this.db.prepare(`
      UPDATE processing_jobs
      SET status = 'retrying',
          stage = 'redo',
          mode = 'redo',
          last_error = NULL,
          locked_at = NULL,
          updated_at = @now
      WHERE message_id = @messageId
        AND status IN ('failed', 'processed', 'replied')
    `).run({ messageId, now });
    return result.changes > 0;
  }

  /** Return a processing job by message id. */
  getProcessingJob(messageId: string): ProcessingJob | null {
    const row = this.db.prepare(`
      SELECT
        message_id as messageId,
        status,
        stage,
        mode,
        retry_count as retryCount,
        last_error as lastError,
        locked_at as lockedAt,
        completed_at as completedAt,
        reply_sent_at as replySentAt,
        created_at as createdAt,
        updated_at as updatedAt
      FROM processing_jobs
      WHERE message_id = @messageId
    `).get({ messageId }) as ProcessingJob | undefined;
    return row ?? null;
  }

  /** Return the raw event JSON for retry. */
  getMessageRawEvent(messageId: string): string | null {
    const row = this.db.prepare(`
      SELECT raw_event as rawEvent
      FROM messages
      WHERE id = @messageId
    `).get({ messageId }) as { rawEvent: string | null } | undefined;
    return row?.rawEvent ?? null;
  }

  /** Return stored message content for processing commands and redo. */
  getMessageContent(messageId: string): string | null {
    const row = this.db.prepare(`
      SELECT content
      FROM messages
      WHERE id = @messageId
    `).get({ messageId }) as { content: string } | undefined;
    return row?.content ?? null;
  }

  private updateProcessingJob(
    messageId: string,
    params: {
      status: ProcessingStatus;
      stage: string;
      mode?: ProcessingMode;
      lockedAt?: number | null;
      completedAt?: number | null;
      replySentAt?: number | null;
      lastError?: string | null;
      updatedAt: number;
    }
  ): void {
    const current = this.getProcessingJob(messageId);
    if (!current) return;
    this.db.prepare(`
      UPDATE processing_jobs
      SET status = @status,
          stage = @stage,
          mode = @mode,
          locked_at = @lockedAt,
          completed_at = @completedAt,
          reply_sent_at = @replySentAt,
          last_error = @lastError,
          updated_at = @updatedAt
      WHERE message_id = @messageId
    `).run({
      messageId,
      status: params.status,
      stage: params.stage,
      mode: params.mode === undefined ? current.mode : params.mode,
      lockedAt: params.lockedAt === undefined ? current.lockedAt : params.lockedAt,
      completedAt: params.completedAt === undefined ? current.completedAt : params.completedAt,
      replySentAt: params.replySentAt === undefined ? current.replySentAt : params.replySentAt,
      lastError: params.lastError === undefined ? current.lastError : params.lastError,
      updatedAt: params.updatedAt,
    });
  }

  private isFtsAvailable(): boolean {
    if (this.disableFts) return false;
    const row = this.db.prepare(`
      SELECT value
      FROM search_diagnostics
      WHERE key = 'fts_available'
    `).get() as { value: string } | undefined;
    return row?.value === 'true' && this.hasTable('message_fts');
  }

  private hasTable(name: string): boolean {
    const row = this.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE name = @name
    `).get({ name }) as { name: string } | undefined;
    return Boolean(row);
  }

  private setSearchDiagnostic(key: string, value: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO search_diagnostics (key, value, updated_at)
      VALUES (@key, @value, @updatedAt)
    `).run({ key, value, updatedAt: this.clock() });
  }

  getSearchDiagnostics(): Record<string, string> {
    const rows = this.db.prepare(`
      SELECT key, value
      FROM search_diagnostics
      ORDER BY key
    `).all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  rebuildSearchIndex(): void {
    if (!this.isFtsAvailable()) return;
    this.db.exec('DELETE FROM message_fts;');
    const messageIds = this.db.prepare('SELECT id FROM messages ORDER BY received_at ASC').all() as Array<{ id: string }>;
    for (const row of messageIds) {
      this.syncSearchIndex(row.id);
    }
    this.setSearchDiagnostic('fts_last_rebuild', String(this.clock()));
  }

  private syncSearchIndex(messageId: string): void {
    if (!this.isFtsAvailable()) return;
    try {
      const row = this.db.prepare(`
        SELECT
          m.id as messageId,
          m.content,
          COALESCE(p.summary, '') as summary,
          COALESCE(p.tags, '') as tags,
          COALESCE(p.action_items, '') as actionItems,
          COALESCE(p.entities, '') as entities
        FROM messages m
        LEFT JOIN processed p ON p.message_id = m.id
        WHERE m.id = @messageId
      `).get({ messageId }) as {
        messageId: string;
        content: string;
        summary: string;
        tags: string;
        actionItems: string;
        entities: string;
      } | undefined;
      if (!row) return;

      this.db.prepare('DELETE FROM message_fts WHERE message_id = @messageId').run({ messageId });
      this.db.prepare(`
        INSERT INTO message_fts (message_id, content, summary, tags, action_items, entities)
        VALUES (@messageId, @content, @summary, @tags, @actionItems, @entities)
      `).run(row);
    } catch (err) {
      this.setSearchDiagnostic('fts_last_error', (err as Error).message);
    }
  }

  private buildFtsQuery(keyword: string): string {
    return keyword
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(' ');
  }

  private normalizeSearchOptions(
    input: string | SearchMessagesOptions,
    legacyLimit: number,
    maxLimit: number = 20
  ): NormalizedSearchOptions {
    const options = typeof input === 'string' ? { keyword: input, limit: legacyLimit } : input;
    const keyword = options.keyword.trim();
    const limit = Math.min(Math.max(options.limit ?? legacyLimit, 1), maxLimit);
    const tag = options.tag ? this.resolveTag(options.tag) : null;
    const source = options.source?.trim() || null;
    return {
      keyword,
      keywordLike: `%${keyword}%`,
      limit,
      tag,
      tagLike: tag ? `%${tag}%` : null,
      since: options.since ?? null,
      until: options.until ?? null,
      source,
      sourceLike: source ? `%${source}%` : null,
    };
  }

  /** Search messages by keyword/content filters. Returns recent matches. */
  searchMessages(input: string | SearchMessagesOptions, limit: number = 10, maxLimit: number = 20): SearchMessageResult[] {
    const options = this.normalizeSearchOptions(input, limit, maxLimit);
    const ftsQuery = this.buildFtsQuery(options.keyword);
    if (ftsQuery && this.isFtsAvailable()) {
      try {
        const ftsRows = this.searchMessagesFts(ftsQuery, options);
        if (ftsRows.length > 0) {
          this.setSearchDiagnostic('last_backend', 'fts');
          return ftsRows;
        }
        this.setSearchDiagnostic('last_backend', 'like_after_empty_fts');
      } catch (err) {
        this.setSearchDiagnostic('last_backend', 'like_after_fts_error');
        this.setSearchDiagnostic('fts_last_error', (err as Error).message);
      }
    } else {
      this.setSearchDiagnostic('last_backend', 'like');
    }

    return this.searchMessagesLike(options);
  }

  getMessagesForExport(input: ExportMessagesOptions): SearchMessageResult[] {
    const options = this.normalizeSearchOptions(input, input.limit ?? 100, 1000);
    const ftsQuery = this.buildFtsQuery(options.keyword);
    if (ftsQuery && this.isFtsAvailable()) {
      try {
        const ftsRows = this.searchMessagesFts(ftsQuery, options);
        if (ftsRows.length > 0) return ftsRows;
      } catch {
        // Export falls back to LIKE below.
      }
    }
    return this.searchMessagesLike(options);
  }

  async backupDatabase(destination: string): Promise<void> {
    await this.db.backup(destination);
  }

  cleanupMessagesBefore(cutoff: number, dryRun: boolean): CleanupResult {
    const messageRows = this.db.prepare(`
      SELECT id
      FROM messages
      WHERE received_at < @cutoff
      ORDER BY received_at ASC
    `).all({ cutoff }) as Array<{ id: string }>;
    const messageIds = messageRows.map((row) => row.id);
    const result = this.countCleanupRows(messageIds, cutoff, dryRun);
    if (dryRun || messageIds.length === 0) {
      return result;
    }

    const cleanup = this.db.transaction(() => {
      for (const messageId of messageIds) {
        this.db.prepare('DELETE FROM processed WHERE message_id = @messageId').run({ messageId });
        this.db.prepare('DELETE FROM processing_jobs WHERE message_id = @messageId').run({ messageId });
        this.db.prepare('DELETE FROM message_sources WHERE message_id = @messageId').run({ messageId });
        this.db.prepare('DELETE FROM messages WHERE id = @messageId').run({ messageId });
        if (this.isFtsAvailable()) {
          this.db.prepare('DELETE FROM message_fts WHERE message_id = @messageId').run({ messageId });
        }
      }
      this.db.prepare(`
        DELETE FROM sources
        WHERE id NOT IN (SELECT source_id FROM message_sources)
      `).run();
    });
    cleanup();
    return result;
  }

  private countCleanupRows(messageIds: string[], cutoff: number, dryRun: boolean): CleanupResult {
    if (messageIds.length === 0) {
      const orphanSources = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM sources
        WHERE id NOT IN (SELECT source_id FROM message_sources)
      `).get() as { count: number };
      return { dryRun, cutoff, messages: 0, processed: 0, processingJobs: 0, messageSources: 0, orphanSources: orphanSources.count };
    }

    let processed = 0;
    let processingJobs = 0;
    let messageSources = 0;
    for (const messageId of messageIds) {
      processed += (this.db.prepare('SELECT COUNT(*) as count FROM processed WHERE message_id = @messageId').get({ messageId }) as { count: number }).count;
      processingJobs += (this.db.prepare('SELECT COUNT(*) as count FROM processing_jobs WHERE message_id = @messageId').get({ messageId }) as { count: number }).count;
      messageSources += (this.db.prepare('SELECT COUNT(*) as count FROM message_sources WHERE message_id = @messageId').get({ messageId }) as { count: number }).count;
    }
    const orphanSources = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM sources s
      WHERE NOT EXISTS (
        SELECT 1
        FROM message_sources ms
        WHERE ms.source_id = s.id
          AND ms.message_id NOT IN (
            SELECT id FROM messages WHERE received_at < @cutoff
          )
      )
    `).get({ cutoff }) as { count: number };

    return {
      dryRun,
      cutoff,
      messages: messageIds.length,
      processed,
      processingJobs,
      messageSources,
      orphanSources: orphanSources.count,
    };
  }

  private searchMessagesFts(keyword: string, options: NormalizedSearchOptions): SearchMessageResult[] {
    return this.db.prepare(`
      SELECT
        m.id,
        m.content,
        p.summary,
        p.tags,
        p.key_points as keyPoints,
        p.action_items as actionItems,
        p.entities,
        p.source_type as sourceType,
        p.confidence,
        p.schema_version as schemaVersion,
        (
          SELECT group_concat(DISTINCT s.domain)
          FROM message_sources ms
          JOIN sources s ON s.id = ms.source_id
          WHERE ms.message_id = m.id
        ) as sources,
        m.received_at as receivedAt
      FROM message_fts f
      JOIN messages m ON m.id = f.message_id
      LEFT JOIN processed p ON p.message_id = m.id
      WHERE message_fts MATCH @keyword
        AND (@tagLike IS NULL OR p.tags LIKE @tagLike)
        AND (@since IS NULL OR m.received_at >= @since)
        AND (@until IS NULL OR m.received_at <= @until)
        AND (
          @sourceLike IS NULL OR EXISTS (
            SELECT 1
            FROM message_sources ms
            JOIN sources s ON s.id = ms.source_id
            WHERE ms.message_id = m.id
              AND (s.domain LIKE @sourceLike OR s.canonical_url LIKE @sourceLike OR s.final_url LIKE @sourceLike)
          )
        )
      ORDER BY bm25(message_fts), m.received_at DESC
      LIMIT @limit
    `).all({ ...options, keyword }) as SearchMessageResult[];
  }

  private searchMessagesLike(options: NormalizedSearchOptions): SearchMessageResult[] {
    const stmt = this.db.prepare(`
      SELECT
        m.id,
        m.content,
        p.summary,
        p.tags,
        p.key_points as keyPoints,
        p.action_items as actionItems,
        p.entities,
        p.source_type as sourceType,
        p.confidence,
        p.schema_version as schemaVersion,
        (
          SELECT group_concat(DISTINCT s.domain)
          FROM message_sources ms
          JOIN sources s ON s.id = ms.source_id
          WHERE ms.message_id = m.id
        ) as sources,
        m.received_at as receivedAt
      FROM messages m
      LEFT JOIN processed p ON p.message_id = m.id
      WHERE
        (
          @keyword = ''
          OR m.content LIKE @keywordLike
          OR p.summary LIKE @keywordLike
          OR p.tags LIKE @keywordLike
          OR p.key_points LIKE @keywordLike
          OR p.action_items LIKE @keywordLike
          OR p.entities LIKE @keywordLike
        )
        AND (@tagLike IS NULL OR p.tags LIKE @tagLike)
        AND (@since IS NULL OR m.received_at >= @since)
        AND (@until IS NULL OR m.received_at <= @until)
        AND (
          @sourceLike IS NULL OR EXISTS (
            SELECT 1
            FROM message_sources ms
            JOIN sources s ON s.id = ms.source_id
            WHERE ms.message_id = m.id
              AND (s.domain LIKE @sourceLike OR s.canonical_url LIKE @sourceLike OR s.final_url LIKE @sourceLike)
          )
        )
      ORDER BY m.received_at DESC
      LIMIT @limit
    `);
    return stmt.all(options) as SearchMessageResult[];
  }

  getProcessingJobCounts(): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as count
      FROM processing_jobs
      GROUP BY status
    `).all() as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  getProcessingModeCounts(): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT mode, COUNT(*) as count
      FROM processing_jobs
      GROUP BY mode
    `).all() as Array<{ mode: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.mode, row.count]));
  }

  getRecentMessages(limit: number = 5): Array<{
    id: string;
    content: string;
    messageType: string;
    receivedAt: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT id, content, message_type as messageType, received_at as receivedAt
      FROM messages
      ORDER BY received_at DESC
      LIMIT @limit
    `);
    return stmt.all({ limit }) as Array<{
      id: string;
      content: string;
      messageType: string;
      receivedAt: number;
    }>;
  }

  getMessageDetail(messageId: string): MessageDetail | null {
    const row = this.db.prepare(`
      SELECT
        m.id,
        m.chat_id as chatId,
        m.sender_id as senderId,
        m.content,
        m.message_type as messageType,
        m.received_at as receivedAt,
        p.id as processedId,
        p.summary,
        p.tags,
        p.key_points as keyPoints,
        p.action_items as actionItems,
        p.entities,
        p.source_type as sourceType,
        p.confidence,
        p.schema_version as schemaVersion,
        p.processed_at as processedAt
      FROM messages m
      LEFT JOIN processed p ON p.message_id = m.id
      WHERE m.id = @messageId
    `).get({ messageId }) as {
      id: string;
      chatId: string;
      senderId: string;
      content: string;
      messageType: string;
      receivedAt: number;
      processedId: string | null;
      summary: string | null;
      tags: string | null;
      keyPoints: string | null;
      actionItems: string | null;
      entities: string | null;
      sourceType: string | null;
      confidence: number | null;
      schemaVersion: number | null;
      processedAt: number | null;
    } | undefined;
    if (!row) return null;

    return {
      id: row.id,
      chatId: row.chatId,
      senderId: row.senderId,
      content: row.content,
      messageType: row.messageType,
      receivedAt: row.receivedAt,
      processed: row.processedId && row.processedAt !== null
        ? {
            id: row.processedId,
            summary: row.summary,
            tags: row.tags,
            keyPoints: row.keyPoints,
            actionItems: row.actionItems,
            entities: row.entities,
            sourceType: row.sourceType,
            confidence: row.confidence,
            schemaVersion: row.schemaVersion,
            processedAt: row.processedAt,
          }
        : null,
      sources: this.getSourcesForMessage(messageId),
      attachments: this.getAttachmentsForMessage(messageId),
    };
  }

  getRecentFailedJobs(limit: number = 5): Array<{
    messageId: string;
    stage: string;
    mode: ProcessingMode;
    retryCount: number;
    lastError: string | null;
    updatedAt: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        message_id as messageId,
        stage,
        mode,
        retry_count as retryCount,
        last_error as lastError,
        updated_at as updatedAt
      FROM processing_jobs
      WHERE status = 'failed'
      ORDER BY updated_at DESC
      LIMIT @limit
    `);
    return stmt.all({ limit }) as Array<{
      messageId: string;
      stage: string;
      mode: ProcessingMode;
      retryCount: number;
      lastError: string | null;
      updatedAt: number;
    }>;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
