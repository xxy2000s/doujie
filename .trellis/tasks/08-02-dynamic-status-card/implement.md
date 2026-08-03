# Implementation Plan

1. Make lark-cli decoding lossless and add deterministic split-byte tests.
2. Add poller chronology fencing and tests for stale hash drift versus genuine edits.
3. Extend status-card presentation with Markdown output and implement a throttled serialized dynamic-card controller.
4. Route default and detail Codex chunks exclusively through the controller; add terminal fallback and reaction lifecycle handling.
5. Expand router/reply tests for streaming, long output, failures, interruption, duplicate events, and late callbacks.
6. Run focused tests, then full typecheck/test/build.
7. Perform a controlled local daemon deployment and real E2E only in the `包` group.
8. Run independent peer review, address findings, rerun all gates, and prepare user acceptance instructions.

## Rollback points

- Before runtime deployment: discard the worktree build; the active daemon remains on the original source tree.
- After runtime deployment: rebuild the prior `master` revision and kickstart exactly one LaunchAgent listener.
