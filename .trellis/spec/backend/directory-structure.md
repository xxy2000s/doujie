# Backend Directory Structure

## Overview

Doujie is a single-package TypeScript ESM daemon. Production code lives directly in `src/`; tests mirror behavior in `tests/`. There is no controller/service/repository framework. Keep additions close to the existing runtime boundary and avoid adding layers for their own sake.

## Layout

```text
src/
├── index.ts                    # composition root, startup, shutdown
├── router.ts                   # Feishu event normalization and routing
├── listener.ts                # lark-cli event subscription
├── config.ts / types.ts       # validated config and shared contracts
├── store.ts                   # SQLite schema, migrations, and queries
├── commands/                  # one command concern per file, registry in index.ts
├── ai/                        # Codex processes and answer pipelines
└── web/                       # read-only local HTTP UI and embedded assets
tests/                         # node:test suites, named after source behavior
docs/                          # architecture, deployment, and operations
backlog/                       # evidence-backed unresolved work
```

## Module Organization

- Wire dependencies only in `src/index.ts`; modules expose classes/functions and accept collaborators through constructors or parameters. `Router` and `startDoujieWebServer` are representative.
- Put Feishu commands in `src/commands/<name>.ts` and register them in `src/commands/index.ts`.
- Put provider process logic under `src/ai/` when it belongs to normal Codex/AI processing. Project-agent lifecycle belongs in the top-level `agent-session-*.ts` and `headless-agent-runner.ts` modules.
- Keep shared event/config/result contracts in `src/types.ts`; keep narrow module-only types beside their implementation.
- Use kebab-case filenames, PascalCase classes/types, camelCase functions/variables, and UPPER_SNAKE_CASE constants.
- Every relative import uses the emitted `.js` suffix, for example `import { Store } from './store.js';`.

## Examples and Boundaries

- `src/listener.ts` owns the long-running child process; `src/router.ts` does not spawn the event listener.
- `src/store.ts` is the persistence boundary; callers do not open independent database connections.
- `src/reply.ts`, `src/reaction.ts`, and `src/group-context.ts` wrap specific `lark-cli` operations.
- `tests/router.test.ts` injects fake reply/reaction/Codex clients instead of patching globals.

Do not place runtime state in the repository. Config, DB, registries, sessions, attachments, backups, and exports remain under `~/.doujie`; original Codex transcripts remain under `~/.codex/sessions`.
