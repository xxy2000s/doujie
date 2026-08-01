# M1 Runtime Config and Quoted Messages - Implementation Plan

## Ordered Checklist

1. Establish baseline
   - Run current `pnpm typecheck`, `pnpm test`, and `pnpm build`.
   - Confirm no unrelated worktree changes outside this Trellis task.

2. Add configuration contracts
   - Extend normalized types for global features and per-group overrides.
   - Parse and validate YAML defaults/overrides in `src/config.ts`.
   - Add focused config tests for defaults, valid values, precedence inputs, and invalid limits/types.

3. Add runtime snapshot manager
   - Implement immutable snapshot creation and effective feature resolution.
   - Implement transactional reload with invalid-config rollback.
   - Limit live application to feature fields and calculate sanitized restart-required paths for every other changed category.
   - Add unit tests for immutability, monotonic versions, no-change behavior, mixed feature/infra changes, and rollback.

4. Add `/reload`
   - Extend command runtime and command metadata.
   - Add the Router admin-command gate entry.
   - Format success, no-change, restart-required, and sanitized failure responses.
   - Test admin and non-admin paths and side-effect ordering.

5. Normalize reply relationships
   - Extend external `FeishuEvent` and internal `MessageContent` types with optional parent/reply/root IDs.
   - Update Router extraction, retry restoration, and edited-message poller normalization.
   - Resolve missing receive-event direct parents read-only and suppress transport-enrichment replay across receive/poller races.
   - Require equality of the non-relationship generation before suppressing replay; persist relationship-only raw-event enrichment even when disabled.
   - Combine upstream `update_time` with effective content/mention/relationship hashes in Router and Poller version keys.
   - Add event-boundary tests.

6. Add quoted-message provider
   - Add an injected provider interface plus lark-cli implementation with argv execution, timeout, exact-ID matching, and defensive text parsing.
   - Avoid reactions, resources, logging bodies, and raw integration output.
   - Add provider unit tests with a fake runner.

7. Integrate quoted context into default Codex routing
   - Capture one snapshot at request entry and preserve it through async work.
   - Resolve group/global feature settings only after existing gates.
   - Fetch at most one direct parent, truncate and label it as untrusted reference data.
   - Run combined content through existing privacy skip/redaction.
   - Add Router tests for all success, denial, failure, dedupe, and injection-isolation paths.

8. Automated quality gate
   - Run `pnpm typecheck`.
   - Run `pnpm test`.
   - Run `pnpm build`.
   - Run focused tests again after every review-driven fix.

9. Independent SubAgent Review
   - Provide the active task path first in the review prompt.
   - Require checks for PRD/design compliance, implementation quality, test coverage, privacy/permission gates, subprocess safety, and full event->config->Router->provider->prompt data flow.
   - Fix all blocking findings and repeat review/revalidation until none remain.

10. Runtime and real Feishu E2E
    - Read the lark-im skill before using authorized user identity.
    - Resolve the designated local test group without exposing its ID.
    - Back up the real config before any temporary feature change and restore it after E2E.
    - Restart launchd, verify plist/runtime state, and confirm exactly one logical listener.
    - Verify `/status` and exact `DOUJIE_E2E_OK`.
    - Verify quote enabled, disabled, and failed-parent fallback with unique markers.
    - Corroborate results through bounded, redacted SQLite/job and log checks.

11. Finish
    - Run `trellis-check` and final automated checks.
    - Run `trellis-update-spec` for the new config/command/event integration contract.
    - Create clear local work commit(s); do not push.
    - Archive the Trellis task and record the session journal per `trellis-finish-work`.

## Validation Commands

```bash
pnpm typecheck
pnpm test
pnpm build
launchctl kickstart -k gui/$(id -u)/com.doujie.daemon
launchctl print gui/$(id -u)/com.doujie.daemon
tail -n 120 /tmp/doujie.log
```

Real Feishu E2E uses authorized `lark-cli` user identity and private shell variables for the target chat. Commands and handoff output must not expose IDs, tokens, tickets, config bodies, or chat text.

## Risky Files and Rollback Points

- `src/config.ts`, `src/types.ts`: configuration/event contract changes can break startup. Keep startup fatal on invalid initial config and cover compatibility defaults.
- `src/index.ts`, `src/router.ts`: dependency/lifecycle and authorization order can affect every message. Preserve single listener and capture snapshots before async routing.
- `src/edited-message-poller.ts`: only propagate relationship fields; do not alter scheduling lifecycle.
- Real `~/.doujie/config.yaml`: temporary E2E edits require a private backup and guaranteed restoration. Never copy it into the repository or output.
- `src/quoted-message.ts`: external process failures must degrade locally and must not leak stderr or content.

Rollback is commit-based for source and backup-restore for temporary local config. Never delete or rewrite runtime databases, registries, attachments, or Codex session files.

## Review Gates

- Planning gate: PRD, design, and implementation plan contain no blocking open questions.
- Development gate: applicable Trellis specs are read before source edits.
- Quality gate: automated checks pass and independent review has no blocking issues.
- Runtime gate: launchd and one-listener checks pass before any E2E claim.
- Delivery gate: real E2E evidence is summarized without sensitive values, then code/spec commits, task archive, and journal recording complete locally.
