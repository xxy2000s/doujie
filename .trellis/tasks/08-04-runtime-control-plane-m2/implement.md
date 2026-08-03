# Runtime Control Plane M2 Implementation Plan

## Preparation

- [x] Add backend runtime/config and quality specs to implementation/check context.
- [x] Capture baseline `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- [x] Confirm local daemon PID/listener count before runtime changes.

## M1: Observable

- [x] Extend runtime config metadata and redacted change/audit contracts.
- [x] Implement effective feature projection by chat scope.
- [x] Add administrator-only `/features` routing and command formatting.
- [x] Extend `/status` and `/reload` without exposing values or IDs.
- [x] Add config, manager, command, and Router authorization tests.
- [x] Run all three quality gates and review the M1 diff.

## M2: Automatic Hot Reload

- [x] Implement directory-based debounced config watcher with injected clock/fs
      seams and deterministic tests for replace, duplicate, invalid, and recovery.
- [x] Expand reloadable/restart-bound projections and sanitized path reporting.
- [x] Add a single-owner edited-poller lifecycle controller with serialized
      start/stop/replace and idempotent shutdown.
- [x] Wire watcher/reconciliation/shutdown in the composition root.
- [x] Prove in-flight snapshot stability and next-turn application.
- [x] Cover manual/watcher races, failed reconciliation, and no-overlap behavior.
- [x] Run all three quality gates and review the M2 diff.

## M3: Quote Enhancements

- [x] Add backward-compatible `max_depth` and `include_attachments` schema and
      global/group resolution.
- [x] Normalize allowed Feishu message content and bounded attachment metadata.
- [x] Implement iterative parent traversal, cycle detection, total depth/budget,
      and current-message-only degradation.
- [x] Preserve authorization-before-fetch, generation dedupe, retry restoration,
      and combined-content privacy behavior.
- [x] Add provider, resolver, prompt, Router, config, and race regression tests.
- [x] Run all three quality gates and review the M3 diff.

## Integration And E2E

- [x] Run `pnpm typecheck`, `pnpm test`, and `pnpm build` from a clean dependency
      state available in the workspace.
- [x] Restart local launchd once from an external operator shell; verify one
      listener, watcher/poller state, startup doctor, and sanitized logs.
- [x] Back up the local config without printing it, execute authorized `包` group
      E2E for all three milestones, then restore the original config and reload.
- [x] Verify no active turn is interrupted by reload and no duplicate polling
      processing occurs.
- [x] Run final secret/runtime-artifact scan and independent code review.
- [x] Update stable docs/spec/backlog to match delivered behavior.
- [x] Commit locally only after all automated and real E2E evidence is recorded.
      Do not push, promote `release`, tag, deploy remotely, or restart the remote
      service without separate user authorization.

## Rollback Points

1. M1 is command/metadata-only and can be reverted independently before M2.
2. M2 watcher can be disabled by code/config while retaining manual `/reload`.
3. M3 defaults preserve the current single-parent path; disabling
   `quoted_message` returns to current-message-only behavior.
4. Any failed milestone stops progression until the regression is understood.

## Verification Evidence

- Final automated gates: `pnpm typecheck`, 278/278 tests, `pnpm build`, and
  `git diff --check` all passed.
- Independent review found and verified fixes for duplicate authorization-set
  comparison, `symlink/..` canonicalization, and watcher-introduced symlink cwd
  drift. The final focused review reported no release-blocking findings.
- Local launchd was restarted onto the final build. It is running with one
  listener process chain, an active config watcher, and the edited-message
  poller under the runtime lifecycle owner.
- Authorized E2E used only the `包` group. `/features` and `/status` returned
  sanitized runtime state; automatic reload applied quote depth 3 and replaced
  the poller interval; a two-level reply chain returned both test markers in
  oldest-to-newest order.
- The original local config was restored without printing its contents. The
  watcher restored the prior defaults, administrator `/reload` returned
  `no_change`, and `/features` confirmed quoted-message defaults were restored.
- Logs and recorded evidence omit credentials, identifiers, raw config values,
  and complete session content.
