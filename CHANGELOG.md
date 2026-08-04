# Changelog

All notable changes to Doujie are recorded here. Releases follow Semantic Versioning.

## [0.3.0] - 2026-08-04

### Added

- Administrator-visible runtime feature, status, reload, and redacted audit reporting.
- Automatic debounced config-file reload with single-owner edited-message poller reconciliation.
- Bounded multi-level quoted-message context for known text, Post, card, bot, and attachment-metadata inputs.

### Changed

- Each request now keeps one immutable runtime-config snapshot across privacy, routing, Codex, output, and attachment handling.
- Runtime listener, watcher, and poller resources now have one lifecycle owner with bounded startup and shutdown cleanup.
- Codex project Agent confirmations freeze the launch defaults shown to the user and apply those exact defaults after confirmation.

### Security

- Automatic reload rejects authorization and mention-matcher changes, permission expansion, real workdir moves, and incomplete configuration files.
- Workdir comparison handles symlink traversal without allowing watcher-introduced symlink retargeting, and authorization lists use duplicate-safe set comparison.
- Status, reload, startup, and failure reporting sanitize local paths, identifiers, configuration values, and external-process errors.

## [0.2.2] - 2026-08-04

### Fixed

- Use pnpm's current `allowBuilds` policy map so production installs explicitly authorize the required `better-sqlite3` and `esbuild` lifecycle scripts.

## [0.2.1] - 2026-08-04

### Fixed

- Move pnpm's native build allowlist to `pnpm-workspace.yaml` so current Corepack/pnpm releases can install `better-sqlite3` and `esbuild` non-interactively on production servers.

## [0.2.0] - 2026-08-04

### Added

- Runtime configuration snapshots, administrator reload, and bounded quoted-message context.
- Selectable Feishu output transports through `/output status|post|card`.
- Dynamic lifecycle cards with elapsed time, terminal state, interruption handling, and overflow fallback.
- Post hybrid mode: one lifecycle card plus segmented Markdown process and result messages.
- Stable documentation for architecture decisions, security boundaries, incidents, and AI maintenance lifecycle.

### Changed

- Plain messages hide tool and Session noise; `/detail` enables verbose output for one task.
- Codex streamed output now handles UTF-8 chunk boundaries and Responses-style deltas without corrupting text or flooding Feishu.
- Edited-message generation ordering prevents stale edits and historical `/new` commands from preempting newer work.
- Runtime output switching remains stable when an administrator reload runs concurrently.

### Fixed

- Duplicate and late events no longer repeatedly interrupt completed or replacement turns.
- Partial output is retained when cards or Post delivery fail during completion, interruption, or error handling.
- Long Markdown output uses explicit bounded card tails and complete Post fallback instead of silent truncation.

[0.3.0]: https://github.com/xxy2000s/doujie/releases/tag/v0.3.0
[0.2.2]: https://github.com/xxy2000s/doujie/releases/tag/v0.2.2
[0.2.1]: https://github.com/xxy2000s/doujie/releases/tag/v0.2.1
[0.2.0]: https://github.com/xxy2000s/doujie/releases/tag/v0.2.0
