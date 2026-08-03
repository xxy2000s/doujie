# QA Evidence

Date: 2026-08-02

## Automated gates

- `pnpm typecheck`: passed.
- `pnpm test`: passed, 220 tests, 0 failures, 0 skipped.
- `pnpm build`: passed.
- `git diff --check`: passed.
- Focused regressions cover UTF-8 byte boundaries, stale edits, explicit retry freshness, output continuation, Responses-style deltas, Markdown fence repair, terminal card failures, partial-output preservation, interruption, duplicate events, and late callbacks.

## Peer review

Independent `codex exec review --uncommitted --ephemeral` review was repeated after each valid finding was fixed. The final review result was:

> I did not find any discrete correctness, security, or maintainability issues introduced by the current changes. Typecheck, tests, and build all pass locally.

## Real Feishu E2E

Target: local Doujie, group `包`. No chat IDs, message IDs, user IDs, or credentials are recorded here.

1. Dynamic `/detail` task:
   - A running interactive card was observed before completion.
   - The same card accumulated three ordered shell/tool steps.
   - The final marker was complete and the card reached the done state.
   - The turn produced one user prompt, one bot interactive card, and zero extra bot text/post messages.
2. Real interruption:
   - The first task had produced visible output and was still running.
   - A newer message in the same group interrupted it exactly once.
   - The interrupted card preserved partial output and never reached done.
   - The replacement turn completed exactly once.
3. Post-interruption normal turn:
   - A subsequent normal mention completed exactly once.
   - It produced zero interruption cards and zero extra bot text/post messages.

## Runtime

- LaunchAgent `com.doujie.daemon` is running with active count 1.
- Exactly one `lark-cli event +subscribe` child listener is running.
- The E2E runtime window contained one intentional interruption, three successful completions, and one interruption reaction.
- No status-card update failures or uncaught/unhandled runtime errors were found in the E2E log window.
- A pre-feature runtime `dist` backup remains available for rollback.

## Output transport E2E

1. `/output post` switched the running daemon without restart.
2. A real `/detail` turn produced one lifecycle-only interactive card plus segmented bot messages of type `post`, including a rendered heading, list, and verification marker.
3. The lifecycle card contained no duplicate answer body and finalized with `结果已通过 Markdown 发送`.
4. `/output card` remains covered by E2E and writes the answer into one interactive completion card instead of Post messages.
5. The runtime was finally left in Post hybrid mode for user acceptance. The persisted restart default remains configuration-driven.
6. Final regressions cover token-delta coalescing, failed-send buffer retention, partial output on error/interruption, stale `/new` before and after completion, mixed microsecond/millisecond event timestamps, Post/card status separation, and concurrent `/reload` plus `/output` ordering.

## Handoff state

- Branch: `fix/dynamic-status-card`.
- Changes remain uncommitted for user acceptance.
- No remote push was performed.
