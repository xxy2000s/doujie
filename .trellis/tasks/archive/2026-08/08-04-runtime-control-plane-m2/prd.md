# Runtime control plane M2

## Goal

Complete Doujie's runtime configuration control plane in three sequential,
independently verifiable milestones: observable effective configuration,
automatic hot reload with component lifecycle reconciliation, and bounded
multi-level quoted-message context.

## Requirements

### M1: Observable runtime configuration

- Add an administrator-only `/features` command that reports the effective
  feature values for the current chat scope without printing chat or user IDs.
- Extend `/status` with the active config version, load time, source, watcher
  state, and the last sanitized reload failure.
- Extend `/reload` with a concise changed-field summary and lifecycle actions.
- Keep a bounded, in-memory, redacted reload audit suitable for status and logs.
- Never expose credentials, complete identifiers, paths containing home-user
  identity, or raw invalid configuration.

### M2: Automatic reload and component reconciliation

- Watch the configured YAML file with debounce and tolerate atomic replacement,
  duplicate events, temporary absence, and partially written invalid content.
- Validate a complete candidate and atomically install one immutable snapshot.
  Invalid candidates preserve the last valid snapshot.
- Reconcile edited-message polling after a successful reload: dynamically start,
  stop, or replace the poller without creating overlapping poll loops.
- Hot-apply the in-memory routing/privacy rules and Codex defaults that are read
  at the start of a new request. Existing requests retain their captured snapshot.
- Apply Codex defaults to the existing confirmed project-Agent creation path and
  Codex chat. Natural-language dispatch/resume of existing project-Agent aliases
  remains out of M2 scope; runner dispatch is only prepared for that follow-up.
- Continue reporting storage roots, control-session roots, Feishu identity and
  credentials, and daemon process settings as restart-required.
- Close the watcher and poller cleanly during shutdown.

### M3: Enhanced quoted-message context

- Expand quoted-message configuration with `max_depth` and
  `include_attachments`, preserving current defaults and compatibility.
- Resolve and fetch a bounded direct-parent chain, stopping at configured depth,
  missing/deleted/unauthorized messages, repeated IDs, or a detected cycle.
- Accept normalized text from text, post/card, and bot-authored messages when the
  read boundary can safely render it.
- Include attachment names and types only when enabled; do not download binary
  attachments as part of quote traversal.
- Apply one total Unicode-safe character budget, retain explicit untrusted quote
  boundaries, and run combined-content privacy checks before Codex.
- Preserve the existing current-message-only fallback on any lookup failure.

## Constraints

- No Guardian, self-restart, durable-run schema, second listener, new external
  dependency, or production deployment is part of this feature.
- Existing group mention, user/Agent authorization, message generation,
  duplicate-event, interruption, and Session isolation semantics must remain.
- External commands must use argv spawning with timeout and bounded output.
- Real configuration, credentials, identifiers, logs, and runtime databases must
  not enter the repository or test fixtures.

## Acceptance Criteria

- [x] M1 commands are authorization-gated, scoped, redacted, and covered by tests.
- [x] M2 automatically applies a valid change once, retains the old snapshot on
      invalid/transient writes, and never runs two edited-message poll loops.
- [x] M2 proves a running request keeps its old snapshot while the next request
      sees the new routing, privacy, Codex, output, and feature values.
- [x] M3 traverses bounded chains, detects cycles/duplicates, supports configured
      rendered message kinds and attachment metadata, and degrades safely.
- [x] Existing single-level quoted-message and manual `/reload` behavior remains
      backward compatible.
- [x] `pnpm typecheck`, `pnpm test`, and `pnpm build` pass after every milestone.
- [x] Runtime verification shows one launchd listener and no leaked watcher or
      poller after daemon restart.
- [x] Real Feishu E2E in the local `包` group verifies `/features`, automatic
      reload, poller lifecycle, one multi-level reply chain, and current-only
      degradation. Any config used for E2E is restored after testing.
- [x] Final diff and logs contain no credentials or complete identity values.

## Notes

- The old roadmap's M1 is already delivered. This task is the remaining runtime
  control-plane work and intentionally leaves Guardian as a separate feature.
