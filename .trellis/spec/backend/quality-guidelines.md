# Backend Quality Guidelines

## Required Patterns

- TypeScript strict mode, ESM, ES2022, and `.js` suffixes on local imports.
- Reuse existing modules and dependency-injection seams before introducing abstractions.
- Validate external config/event/CLI data at its boundary and keep normalized types explicit.
- Preserve the control-plane boundary: Doujie dispatches project agents; it is not made project-specific by changing its default cwd.
- Preserve privacy gates, group mention behavior, confirmation ownership, registry/provider/cwd identity, and single-listener operation.
- Keep runtime state out of git and never rewrite `~/.codex/sessions`.

## Forbidden Patterns

- No `any`, `@ts-ignore`, non-null assertions used to bypass uncertain external data, or silent unsafe casts deep in business logic.
- No shell-string construction for provider commands; use `spawn(command, args, ...)` as in listener/reply/Codex modules.
- No second listener for the same Feishu bot, committed `dist`, DB, logs, node_modules, local config, or credentials.
- No unrelated framework/ORM/logger/state-library additions.
- No destructive filesystem operations against broad or runtime session paths.

## Testing

Tests use `node:test` and `node:assert/strict` through `tsx --test tests/*.test.ts`. Add focused tests beside the changed behavior, inject fake collaborators and clocks, and use isolated temp DBs from `tests/helpers.ts`. Verify success, denial/failure, and idempotency paths where applicable. Tests must not use real Feishu, Codex, credentials, home-directory runtime data, or network services.

There is no lint script. Required code-change checks are:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Runtime changes additionally require launchd status/log verification and real Feishu `/status` plus Codex E2E per `AGENTS.md` and `docs/operations/runbook.md`.

## Review Checklist

- Trace data from Feishu/config/CLI through validation, routing, storage, and reply.
- Check authorization and mention gating before side effects.
- Check deduplication, retries, cancellation, shutdown, and resource cleanup.
- Check redaction and confirm no secret/runtime artifacts entered git.
- Check schema upgrades on both fresh and existing databases.
- Confirm launchd still runs built `dist/index.js` with one listener when runtime behavior changes.
