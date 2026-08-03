# Changelog

All notable changes to Doujie are recorded here. Releases follow Semantic Versioning.

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

[0.2.0]: https://github.com/xxy2000s/doujie/releases/tag/v0.2.0
