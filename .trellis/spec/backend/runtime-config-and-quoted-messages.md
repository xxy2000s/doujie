# Runtime Config and Quoted Messages

## Scenario: Hot-reloadable optional Feishu context

### 1. Scope / Trigger

- Trigger: adding a runtime-reloadable feature or enriching a routed Codex prompt from an external Feishu message.
- `RuntimeConfigManager` is the only owner of applied snapshots; `Router` is the authorization and prompt-composition boundary; `LarkQuotedMessageProvider` is the external CLI boundary.
- Existing privacy, identity, listener, Codex, storage, attachment, and process settings remain restart-bound unless a later task explicitly expands the reloadable projection.

### 2. Signatures

```typescript
type RuntimeConfigSnapshot = Readonly<{
  version: number;
  loadedAt: number;
  config: DeepReadonly<AppConfig>;
}>;

type ConfigReloadResult = {
  ok: boolean;
  previousVersion: number;
  version: number;
  changed: boolean;
  restartRequired: string[];
  error?: string;
};

interface QuotedMessageProvider {
  fetch(messageId: string): Promise<{ messageId: string; text: string } | null>;
  resolveRelationship?(messageId: string): Promise<{ parentId?: string; rootId?: string } | null>;
}
```

- Administrator command: `/reload` with no arguments.
- Exact lookup argv: `lark-cli im +messages-mget --message-ids <id> --as user --format json --no-reactions`.

### 3. Contracts

- YAML uses `features.quoted_message.{enabled,max_chars}` and optional `privacy.groups[].features.quoted_message` overrides.
- Precedence is group override, then global feature value, then the code default. The feature defaults disabled and `max_chars` must be a positive integer.
- `Router.handleEvent` captures one snapshot before privacy/authorization work and passes that same object through retry/default routing; reloads affect only later captures.
- Reload validates a complete candidate, copies only global features and feature overrides for existing applied group rules, and reports restart-bound changes as field paths without values or group IDs.
- Raw Feishu event/list-message contracts accept optional `parent_id`, `reply_to`, and `root_id`. The live `+chat-messages-list` reply shape uses `reply_to`; normalize the direct parent as `parent_id` first, then `reply_to`, and use `root_id` only when neither direct-parent field is present.
- A live receive event may omit every reply relationship even though the list/mget representation already exposes `reply_to`. When quoting is enabled and an authorized default-Codex request has no relationship, resolve that request message once through the same read-only mget boundary before reading its parent.
- Persist a resolver-discovered relationship into the message's already-sanitized `raw_event` before recording its effective generation. Retries then reuse the direct parent without depending on a later poller pass; if persistence fails, leave the generation unrecorded so poller enrichment can repair it safely.
- Normalized messages carry `parentId`/`rootId`. The normalized direct parent and root are part of edit-generation hashes and stored raw-event retry restoration; preserve raw `reply_to` in synthesized poller events for boundary fidelity.
- Treat missing-direct-parent to present-direct-parent as transport enrichment only when the effective generation excluding relationships is identical (message type, normalized text, and mention-routing result). A simultaneous text/type/mention change remains a new user generation and must be processed.
- Persist relationship-only enrichment before returning even when quoting is disabled and relationships are intentionally excluded from the content hash. “No reprocessing” never means “drop the richer raw event.”
- Combine `update_time` with the normalized effective-content/mention/relationship hash for both Router event versions and poller versions. Equal timestamps never mask a text, mention, direct-parent, or root change.
- When quoting is disabled, reply relationships do not affect the effective content-generation hash; the poller must not replay a receive-event request solely because it later exposes `reply_to`.
- Quote lookup happens only for default Codex chat, after identity, group-mention, and Agent permission gates. It never fetches URLs, resources, reactions, ancestors, or multiple messages.
- The current `lark-cli +messages-mget` shape returns rendered text as a non-empty plain `content` string. Accept that directly, while also unwrapping legacy/alternate JSON strings shaped as `{ "text": "..." }`.
- Bound quoted text by Unicode code points, prefix every quote line with `> ` so content cannot forge the closing delimiter, then apply combined-content privacy skip/redaction before Codex invocation.
- The quote subprocess uses argv spawning, a timeout, a bounded stdout buffer, discarded stderr, and sanitized errors.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Invalid YAML, root, type, or non-positive limit | Reload fails; snapshot identity and version stay unchanged; reply is generic |
| Valid feature-only change | Atomically install a deeply frozen snapshot with `version + 1` |
| Valid restart-only change | Keep snapshot/version; return sanitized `restart_required` paths |
| Feature disabled or no relationship ID | Do not call the quote provider |
| Enabled receive event omits relationship | Resolve the current message relationship read-only, then fetch at most one direct parent |
| Poller later adds the same missing relationship | Store/dedupe the enrichment; do not run or interrupt Codex again |
| Poller adds relationship and changes text/type/mention | Persist and process as a new generation |
| Equal `update_time`, different effective content or relationship | Accept as a distinct event/version |
| Feature disabled, relationship-only enrichment | Persist parent/reply fields; do not create a new job or Codex turn |
| Missing, deleted, non-text, empty, or non-string message content | Return `null`; process the current request only |
| Unauthorized, malformed, nonzero, timed-out, or oversized CLI result | Log one generic degradation warning; process the current request only |
| Combined prompt matches privacy skip/redaction | Skip Codex or send only the redacted combined prompt |

### 5. Good/Base/Bad Cases

- Good: an allowed mentioned group reply uses its direct parent once, truncates it visibly, and preserves the current request as the only executable instruction.
- Base: the feature is disabled, so the existing prompt and provider call count remain unchanged.
- Bad: a non-admin `/reload`, unmentioned group reply, or Agent-disallowed sender reaches config/quote side effects.

### 6. Tests Required

- Config: defaults, global/group precedence, invalid objects/types, non-positive limits.
- Runtime manager: deep immutability, version monotonicity, in-flight stability, invalid rollback, feature-only apply, restart-only/no-change, sanitized restart paths.
- Command/Router: admin-before-reload ordering, mention/Agent gates before lookup, next-request reload behavior, privacy skip/redact, current-only fallback, `parent_id > reply_to > root_id` resolution, receive-event relationship resolution, resolver-first and poller-first race suppression, resolved-relationship retry restoration, disabled-state suppression, and genuine relationship-only edits.
- Poller: live `reply_to` list-message normalization, raw-field preservation, `update_time + effective hash` versioning, equal-timestamp text/known-parent changes, and deduplication of unchanged effective parents.
- Provider: exact argv, exact-ID match, rendered plain text plus JSON `{text}` shapes, deleted/non-text/empty/malformed-envelope cases, real owned-child timeout, stdout cap, nonzero exit without stderr leakage.
- Prompt: one untrusted section, Unicode-safe truncation, one unprefixed closing delimiter even when quoted content contains delimiter text.

### 7. Wrong vs Correct

#### Wrong

```typescript
const config = loadConfig(); // recaptured mid-request
exec(`lark-cli ... ${messageId}`); // shell string, unbounded output
const prompt = `${current}\n${quoted}`; // no authority boundary
```

#### Correct

```typescript
const snapshot = runtimeConfigSource.getSnapshot();
// Perform existing privacy, mention, and Agent gates first.
const quoted = await quotedMessageProvider.fetch(relationshipId);
const prompt = evaluateContentPrivacy(
  formatQuotedMessagePrompt(message.text, quoted.text, feature.maxChars),
  privacy
);
```

The single captured snapshot prevents mixed-version requests; the provider owns safe process execution; the Router owns authorization and final privacy evaluation.
