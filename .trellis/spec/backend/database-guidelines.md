# Database Guidelines

## Overview

Doujie uses the synchronous `better-sqlite3` API through the single `Store` class in `src/store.ts`. It enables WAL and foreign keys at startup. SQLite timestamps are integer epoch milliseconds, supplied through the store's injectable `now()` clock.

## Query Patterns

- Use prepared statements with named parameters: `... WHERE message_id = @messageId` followed by `.get({ messageId })` or `.run({ messageId })`.
- Cast raw rows at the database boundary and normalize them into exported domain shapes before returning them.
- Use `INSERT OR IGNORE` where provider message IDs provide idempotency; inspect `result.changes` to distinguish duplicates.
- Wrap multi-table or read-modify-write operations in `this.db.transaction(...)`. Examples include tag merging, processed-message saves, migration application, and cleanup in `src/store.ts`.
- Keep all SQL inside `Store`; web, router, commands, and maintenance code call Store methods.
- Close stores in `finally` blocks in tests and shutdown paths.

## Schema and Migrations

The `Store` constructor opens the database, enables its pragmas, and calls the private migration runner. Versioned upgrades use SQLite `user_version` plus `schema_migrations`; `applyMigration()` executes the migration and records it in one transaction. A database newer than `CURRENT_SCHEMA_VERSION` is rejected rather than silently downgraded.

Schema names use plural snake_case tables (`messages`, `processing_jobs`, `message_sources`) and snake_case columns (`message_id`, `received_at`). Index names use `idx_<table>_<columns>`. Foreign-key relations and explicit cleanup ordering must be preserved.

When changing schema:

1. Add an idempotent migration in `src/store.ts` and advance the version.
2. Keep fresh-database creation and upgraded-database results equivalent.
3. Add focused migration/query coverage to `tests/store.test.ts`.

## Common Mistakes

- Do not introduce an ORM or async database wrapper alongside `Store`.
- Do not interpolate user values into SQL. The only interpolation currently used is a validated internal integer for `PRAGMA user_version`.
- Do not rely on filesystem deletion as a migration strategy or modify the real `~/.doujie/data.db` in tests.
- Do not split an atomic operation into separately committed statements.
- Do not disable WAL/foreign keys or assume FTS is always available; tests support `disableFts` and the store has fallback behavior.
