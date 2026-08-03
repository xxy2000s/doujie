# Dynamic Feishu status card streaming

## Goal

Keep Codex intermediate output visible with a selectable dynamic-card or segmented-Post transport, while reactions communicate lifecycle state.

## Requirements

- `output.transport=card` makes Codex turns create exactly one interactive reply card and patch it as output arrives; intermediate Codex chunks must not create additional reply messages.
- `output.transport=post` keeps one lifecycle-only interactive status card and delivers process/result content as segmented Feishu Post Markdown using the existing reply splitter.
- `/output status|post|card` is administrator-only, changes the process-wide transport for subsequent turns without a daemon restart, and does not mutate the transport captured by an in-flight turn.
- `output.transport` is hot-reloadable from `~/.doujie/config.yaml`; `DOUJIE_OUTPUT_TRANSPORT` has environment precedence and determines the restart default when present.
- The card must expose observable progress: lifecycle state, elapsed time, current stage, and a bounded recent-output window rendered as Feishu Markdown.
- `THINKING` marks start, `DONE` marks successful completion, and `ERROR` marks failure or interruption. Reactions are lifecycle signals, not the output transport.
- `/detail` controls event verbosity independently of the selected transport.
- Card updates must be throttled, serialized, skipped when content is unchanged, flushed before the terminal state, and fenced by the active turn generation so late output cannot overwrite a newer turn.
- Final output must be complete when it fits the card limit. Oversized output must preserve a clearly labelled bounded tail in the card and use an explicit fallback delivery instead of silent truncation.
- A card creation or patch failure must not lose the final answer: use a bounded retry and then fall back to the existing post reply path.
- The edited-message poller must decode lark-cli stdout/stderr without corrupting UTF-8 characters split across pipe chunks.
- A historical edited-message generation must not interrupt a newer active turn solely because its content hash changed. Genuine later edits remain processable.
- Existing privacy, authorization, session routing, Codex sandbox policy, and daemon ownership remain unchanged.

## Acceptance Criteria

- [x] Unit tests split 2-, 3-, and 4-byte UTF-8 code points across every relevant chunk boundary and produce byte-for-byte equivalent decoded JSON without replacement characters.
- [x] A damaged/hash-different older poll result cannot preempt a newer active turn; a genuine chronologically later edit can.
- [x] Default and `/detail` turns create one card, patch that same card during progress, and emit no chunk reply messages.
- [x] Completion, failure, interruption, duplicate event, late output/close, no-output, card-create failure, and card-patch failure paths are covered.
- [x] Long Markdown remains valid and has an explicit non-silent overflow behavior.
- [x] `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
- [x] Real Feishu E2E in the local `包` group proves dynamic in-place progress, normal completion, one real interruption, and a subsequent normal turn without false interruption.
- [x] An independent peer review reports no unresolved correctness, security, or regression findings.
- [x] Post mode renders Codex chunks as segmented Post Markdown alongside one lifecycle-only card; card mode retains the one-card output invariant.
- [x] `/output` status, authorization, hot switching, in-flight snapshot isolation, config reload, and environment precedence are covered.
- [x] Real Feishu E2E proves `/output post` and `/output card` both take effect without restarting the daemon.
- [x] A final independent peer review after adding transport switching reports no unresolved findings.

## Notes

- Feishu does not provide a reliable server-side guarantee that only reactions notify while message updates remain silent. The product guarantee is one newly-created progress message per turn; later progress is in-place patching.
- Runtime deployment must follow the self-restart runbook because the active control turn cannot safely restart its own daemon.
