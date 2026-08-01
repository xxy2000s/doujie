# Logging Guidelines

## Overview

The project intentionally uses `console.log`, `console.warn`, and `console.error`; there is no structured logging dependency. Every line starts with a stable module prefix such as `[doujie]`, `[router]`, `[listener]`, `[codex-chat]`, `[reply]`, or `[edit-poller]`. launchd directs stdout and stderr to `/tmp/doujie.log`.

## Levels and Format

- `console.log`: startup/shutdown, accepted work, deduplication, subprocess lifecycle, and successful external actions.
- `console.warn`: recoverable configuration/state that disables or degrades a feature, for example an enabled poller with no chat IDs.
- `console.error`: failed processing, subprocess exits, reply failures, and fatal startup errors.
- Prefer concise parameterized logging: `console.log('[reaction] Added', emojiType, 'to', messageId)`.
- Include stable IDs and counts when they help correlate behavior; do not dump entire event/config objects.

## Required Events

Log daemon startup and shutdown, listener connection/reconnect, message duplicate decisions, processing mode/message ID, URL fetch outcome, external CLI failures, and optional-feature degradation. Persistent workflow state belongs in SQLite (`processing_jobs`, diagnostics), not only in logs.

## Privacy

Before logging errors or externally derived text, use the existing redaction helpers (`redactForLog`, router/listener redaction). Never log Feishu/OpenAI credentials, access tokens, event WebSocket tickets, real `config.yaml`, full raw chat content, or arbitrary JSONL transcript bodies. Keep private identifiers out of committed documentation and fixtures.

## Common Mistakes

- Do not add a new logger abstraction for a single feature or emit unprefixed debug prints.
- Do not log successful secrets/config loading by value; log only safe paths or status.
- Do not treat logs as the sole audit/state store.
- Do not emit high-frequency polling noise for unchanged messages.
