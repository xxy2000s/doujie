# Runtime Control Plane M2 Design

## Existing Boundaries

- `loadConfig` owns YAML/environment parsing and validation.
- `RuntimeConfigManager` owns immutable applied snapshots.
- `Router` captures one snapshot and owns authorization/privacy/prompt assembly.
- `EditedMessagePoller` owns history polling but currently has no lifecycle
  controller.
- `LarkQuotedMessageProvider` owns bounded read-only Feishu CLI lookup.
- `index.ts` is the composition root and shutdown owner.

The feature extends these boundaries instead of adding a second configuration
system or service container.

## M1: Observability

Extend runtime metadata with source, watcher status, last reload result, and a
bounded redacted audit. `RuntimeConfigManager` computes changed field paths from
allowlisted projections; it never serializes values. Add a scoped resolver that
returns only user-facing feature names and effective values. Commands consume
this interface through the existing command runtime dependency injection.

`/features` is administrator-only because it exposes security-relevant behavior,
even though identifiers and secrets are omitted. `/status` remains generally
available but shows only operational metadata. `/reload` retains its existing
authorization gate in `Router` and adds sanitized applied/reconciled summaries.

## M2: Watcher And Lifecycle Reconciliation

Add a small `ConfigFileWatcher` built on `node:fs` APIs. It watches the parent
directory rather than an inode so editor rename/replace operations remain
observable. Events are debounced into a serialized reload request. Temporary
absence or invalid YAML records failure metadata and preserves the active
snapshot; a later event retries normally.

`RuntimeConfigManager.reload()` returns an immutable reconciliation plan:

```text
changed paths
restart-required paths
component actions (poller start/stop/replace)
new snapshot metadata
```

Only a successful candidate can trigger reconciliation. A
`EditedMessagePollingController` owns at most one poller instance. Replacement
starts only after the previous loop has stopped; an internal queue serializes
concurrent manual and watcher reloads. Reconciliation errors are reported and
leave a recoverable controller state without rolling back an already validated
snapshot; the next reload retries reconciliation.

Reloadable projection expands to fields captured per request or consumed by a
reconfigurable component:

- output transport;
- features and group overrides;
- privacy routing/redaction/authorization rules;
- Codex model, sandbox, workdir, and skip-git-repo-check defaults;
- bot mention filters and edited-polling configuration;
- attachment extraction policy.

For project Agents, M2 applies these defaults to the existing production
structured-confirmation create path and to normal Codex chat turns. The runner's
Codex dispatch path also consumes request-scoped defaults so it is safe for a
future caller. Natural-language lookup plus dispatch/resume of an existing
project-Agent alias is not production-routed or claimed as M2 E2E delivery; it
remains the follow-up recorded in `AGENTS.md`.

Restart-bound projection remains storage roots, control-session root, and Feishu
listener identity/chat subscription fields. Environment precedence continues to
be resolved by `loadConfig` before comparison.

The composition root owns watcher/controller startup and shutdown. Signal
handlers stop watcher, poller, listener, and store exactly once.

## M3: Quote Chain

Generalize the provider result to a normalized quoted-message record:

```typescript
type QuotedMessageRecord = {
  messageId: string;
  text: string;
  parentId?: string;
  rootId?: string;
  messageType: string;
  senderType?: string;
  attachments: Array<{ name: string; type: string }>;
};
```

The provider remains responsible for parsing one external response. A separate
chain resolver iteratively calls it, tracks visited IDs, enforces `maxDepth`, and
returns oldest-to-newest context plus a sanitized degradation reason. It does not
parallelize dependent parent requests or download resources.

Prompt formatting applies one total code-point budget across the chain. Every
quoted line is prefixed, each level is labeled as untrusted historical context,
and only the current user message remains executable instruction. Combined text
passes existing privacy skip/redact evaluation.

For card/post content, accept only text produced by known response fields and
structured parsers. Unknown shapes return no text. Attachment metadata is
allowlisted and bounded; file keys, URLs, tokens, and IDs are excluded.

## Concurrency And Failure Rules

- Manual reload, watcher reload, and output switching remain serialized against
  snapshot installation.
- One event captures one snapshot before authorization and keeps it for the turn.
- Poller replacement cannot overlap timers or replay seeded historical edits.
- Watcher callbacks do not throw into the event loop.
- Quote traversal uses one deadline/buffer policy per child lookup and a bounded
  total depth; any failure keeps the current message processable.
- Shutdown is idempotent and waits only for bounded cleanup.

## Compatibility And Rollback

- Omitted new fields preserve one-level, no-attachment behavior.
- Existing YAML and environment variables remain valid.
- The implementation adds no schema migration or external dependency.
- Code rollback is sufficient; runtime config containing new keys must still be
  rejected safely by older versions, so deployment rollback requires restoring
  the previous config copy before restart.
