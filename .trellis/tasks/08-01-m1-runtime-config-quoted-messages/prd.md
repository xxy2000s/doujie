# M1 Runtime Config and Quoted Messages

## Goal

Give Doujie a safe, explicit runtime feature-configuration mechanism and use it to deliver one-layer quoted-text context in Feishu. An administrator can reload validated feature settings without restarting the daemon; new requests use a stable immutable snapshot, invalid reloads preserve the last valid state, and replied-to text is added as untrusted context without bypassing routing or privacy controls.

## Background and Confirmed Facts

- Configuration precedence remains `DOUJIE_* environment > ~/.doujie/config.yaml > built-in defaults`.
- The current daemon loads configuration once at startup and injects it into Router, Listener, Poller, providers, and command runtime.
- Group messages are stored, but only configured mentions enter the Agent route. Private and Agent permissions remain separate.
- Before M1, event and normalized message types did not preserve `parent_id`, live-list `reply_to`, or `root_id`; real E2E additionally proved that receive events can omit a direct parent while list/mget exposes `reply_to`.
- Current code has no centralized `features` schema, runtime snapshot manager, `/reload`, or exact parent-message reader.
- Edited-message polling already exists and is not reimplemented in M1.
- The local Trellis bootstrap is committed as three local commits ahead of `origin/master`; M1 remains a separate task and change set.

## Requirements

### R1. Centralized feature configuration

- Add a typed, centrally validated `features` configuration with a `quoted_message` feature.
- `quoted_message` supports:
  - `enabled`, defaulting to `false` for backward compatibility;
  - `max_chars`, a positive integer with a safe built-in default;
  - a fixed one-message depth in M1;
  - fallback to current-message-only on every optional integration failure.
- Support a global default and per-group override.
- Effective precedence is group override > global feature config > code default.
- Existing environment/YAML/default precedence is unchanged.

### R2. Request-level immutable runtime snapshots

- Introduce a runtime configuration manager that owns the last valid applied snapshot.
- Each accepted incoming request captures one immutable snapshot before authorization or optional feature work and uses it for the full request.
- A successful reload only affects requests that capture a snapshot after the reload completes.
- An in-flight Codex turn continues with the snapshot it started with.
- M1 hot-applies only the new feature configuration and its group overrides.
- Existing privacy rules, Codex settings, Feishu identity/listener settings, Poller settings, storage paths, attachment settings, and process/runtime settings remain restart-bound in M1.

### R3. Administrator-only explicit `/reload`

- Register `/reload` as an administrator command using the existing Router authorization gate.
- Reload reads, normalizes, and validates a complete candidate configuration before changing runtime state.
- Invalid YAML or invalid field values preserve the current snapshot and version.
- A valid reload atomically applies the M1-reloadable feature subset.
- Changes outside the reloadable subset are not applied and are reported as sanitized `restart_required` field paths.
- The reply reports success/failure, whether the snapshot version changed, and whether restart-bound changes were detected.
- Replies and logs never expose config values, credentials, complete identity IDs, event tickets, or message bodies.

### R4. One-layer quoted text context

- Normalize `parent_id`, live-list `reply_to`, and `root_id` from Feishu message events.
- Resolve at most one direct parent message, preferring `parent_id` and using `root_id` only when it is the only available relationship ID.
- Fetch the exact message by ID through a read-only lark-cli integration using argv-based subprocess execution.
- Do not download message resources or fetch reactions.
- Accept only an undeleted text message with non-empty text content.
- Enforce `max_chars` deterministically and mark truncated context.
- Deduplicate relationship IDs and never recurse to ancestors or thread replies.
- Place quoted text in a clearly delimited, explicitly untrusted reference section. The current sender's text remains the only instruction to execute.
- Apply existing content privacy skip/redaction rules to the combined prompt before invoking Codex.
- Feature-disabled, missing/deleted/non-text parent, authorization failure, malformed response, timeout, or CLI failure all degrade to processing only the current message.
- Quote lookup never occurs before existing private/group privacy and group mention gates accept the message.
- Prevent receive-event/edit-poller overlap from processing one request twice: missing-direct-parent to present-direct-parent is transport enrichment once a processing job exists, while a genuine known-parent change remains a new generation.

### R5. Compatibility and safety

- Preserve session-key isolation, duplicate-event handling, edit-generation semantics, cancellation behavior, structured Agent confirmation ownership, and default Codex full-access policy.
- Preserve single-listener operation and existing launchd shape.
- Do not modify runtime databases, session registries, Codex JSONL files, real local config, or credentials in source control.
- No remote deployment or push is part of M1.

## Acceptance Criteria

- [x] AC1: `buildConfig` accepts valid global and per-group quoted-message settings, applies defaults, and rejects invalid types or non-positive limits.
- [x] AC2: Effective feature resolution follows group override > global > default, with quoted-message handling disabled by default.
- [x] AC3: Runtime snapshots are deeply immutable to application code, have a monotonic version, and remain stable for an in-flight request across reload.
- [x] AC4: An administrator `/reload` applies a valid feature change to the next request without restarting the daemon.
- [x] AC5: A non-administrator `/reload` is denied before reload side effects.
- [x] AC6: Invalid YAML/config preserves the previous snapshot and version and returns a sanitized failure response.
- [x] AC7: A valid candidate containing restart-bound changes reports sanitized `restart_required` paths and does not hot-apply those changes.
- [x] AC8: With the feature enabled, a routed reply to a readable text message adds exactly one bounded, delimited quoted section to the Codex prompt.
- [x] AC9: With the feature disabled, no quote-provider call occurs and current behavior is preserved.
- [x] AC10: Missing, deleted, non-text, overlong, duplicate-ID, unauthorized, malformed, timed-out, or failed lookups have focused tests and never block current-message processing.
- [x] AC11: Group messages without the configured Doujie mention do not fetch quoted content or invoke an Agent.
- [x] AC12: Combined current and quoted content passes through privacy skip/redaction before Codex receives it.
- [x] AC13: `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
- [x] AC14: After daemon restart, launchd reports one healthy logical listener and logs contain no new unredacted secrets or chat bodies.
- [x] AC15: Real Feishu E2E in the designated local test group verifies `/status`, exact `DOUJIE_E2E_OK`, quoted feature enabled, quoted feature disabled, and lookup-failure fallback. SQLite/job state and daemon logs corroborate processing without exposing message contents in the handoff.
- [x] AC16: An independent SubAgent Review reports no blocking requirements, code, test, privacy/permission, or cross-layer data-flow issues after fixes and revalidation.

## Out of Scope

- `/features` and expanded `/status` configuration observability.
- Automatic config-file watching, debounce, audit history, or config write-back from Feishu.
- Poller dynamic start/stop/rebuild or Listener identity reconfiguration.
- Hot-reloading existing privacy, Codex, storage, Feishu, attachment, or process settings.
- Multi-level reply chains, thread expansion, cards, posts, bot-message enrichment, attachments, images, OCR, or resource download.
- Permission-tightening actions that interrupt already running work.
- Self-restart, persistent operations jobs, Guardian, project-Agent alias dispatch/resume, remote deployment, or push.

## Key Product Decisions

- Quoted-message context defaults off.
- M1 uses explicit `/reload`; automatic watching is deferred.
- M1 hot-applies only the new feature subset; all pre-existing runtime settings remain restart-bound.
- Quoted content is reference data, not executable instruction authority.
- Exact Feishu E2E is required and must not be inferred from unit tests.

## Blocking Open Questions

None. The user approved this scope and authorized local implementation, local commits, daemon restart, and real Feishu E2E in the designated test group.
