# M1 Verification Evidence (Redacted)

Date: 2026-08-01

Environment: local macOS daemon and the user-designated Feishu test group

Evidence policy: no chat/message/user IDs, message bodies, credentials, tokens, tickets, or real configuration values are recorded here.

## Automated Quality Gate

| Check | Result |
|---|---|
| `git diff --check` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm test` | Pass, 188/188 |
| `pnpm build` | Pass |

## Real Feishu E2E

| Scenario | Result | Corroboration |
|---|---|---|
| `/status` | Pass | Bot reply started with the required `Doujie Status` prefix and reported the expected Doujie DB path contract. |
| Exact Codex smoke | Pass | One request-scoped bot reply matched the required smoke token exactly. |
| Quoted text enabled | Pass | A unique value present only in the direct text parent was reproduced exactly once by the bot. The request was processed once, interrupted zero times, and a later poller pass produced a dedupe signal rather than a second turn. |
| Quoted text disabled | Pass | The parent-only unique value remained present only in the user parent and was not reproduced by the bot. The current request still completed, with one processing turn and zero interruptions. |
| Unsupported/non-text parent fallback | Pass | The parent was confirmed as a non-text post. The bot completed the current request exactly, with one processing turn and zero interruptions. |

## SQLite and Race Evidence

- Enabled, disabled, and fallback requests ended in `replied` with retry count zero.
- Strict enabled runs had one stored message row and one processing job for the request.
- The final strict enabled run persisted the normalized direct parent in the stored, already-sanitized raw event.
- Receive-event/edit-poller overlap produced one processing turn, zero interruptions, and one dedupe/enrichment signal after the poller observed the relationship.
- Automated regressions additionally cover poller-first and resolver-first ordering, disabled-state persistence without a new job, simultaneous relationship-plus-text changes, and equal-`update_time` text/known-parent changes.

## Runtime and Restoration

- The original local configuration was restored and loaded successfully; quoted-message handling returned to its original disabled state.
- Each exact temporary configuration backup created for E2E was removed after successful restoration; those temporary copies are not recoverable.
- Final launchd state was running with the expected plist shape.
- Two subscriber-related OS processes formed one parent-child chain, confirming one logical listener.
- In the final post-restart log segment: one listener start, zero listener exits, zero duplicate-listener errors, zero Router processing errors, and zero edit-poller failures; connection signals were present.

## Review State

- Two independent review rounds completed. Every reported finding was fixed and revalidated.
- The final independent review found no blocking issues and confirmed requirements, code, tests, privacy/permission boundaries, cross-layer data flow, race handling, and this redacted evidence summary.
