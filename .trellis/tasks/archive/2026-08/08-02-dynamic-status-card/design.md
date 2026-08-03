# Design

## Output transport

Introduce a per-turn dynamic card controller owned by `Router.handleCodexCommand`. It accumulates output, derives a bounded Markdown view, and serializes card patches. A timer requests at most one patch per configured interval; terminal methods flush pending output before writing the final state.

The controller stores the complete accumulated text for final delivery decisions. It never sends intermediate posts. If card creation fails, or patching becomes unavailable after bounded retries, the terminal path sends the accumulated final answer through `replyText` so output is not lost.

## Lifecycle

```text
created -> thinking -> working -> done
                            \-> interrupted
                            \-> error
```

Each callback first verifies the owning turn remains current and is not aborted. `finishCodexTurn` remains identity-based. Terminal methods are idempotent and stop timers. Interrupted turns receive `ERROR`; successful turns receive `DONE`.

## Output bounding

The card builder receives Markdown detail. Running cards show a recent character-safe tail with an omission marker. Terminal cards show the full output up to a conservative interactive-card limit. If the final output exceeds that limit, the card shows an explicit overflow note and the existing post reply path delivers the complete output in chunks. This is noisy only for exceptional long results and never silently truncates.

## UTF-8 and stale edit protection

`spawnLarkCli` sets stdout/stderr stream encoding before registering data handlers, relying on Node's `StringDecoder` semantics to preserve code points spanning Buffer boundaries. The process helper is injectable/exported for deterministic chunk-boundary tests.

Poller state tracks the newest observed `update_time` for each chat. Once initialized, a newly hashed historical message with an update time older than the newest observed update is recorded as seen but not emitted. Equal timestamps remain eligible because Feishu timestamp precision can collide and the router generation dedupe still applies. Missing/unparseable timestamps use conservative seeding and do not gain authority to preempt from hash alone after a newer timestamp is known.

## Compatibility and rollback

No configuration schema changes are required for the first delivery. Rollback is a branch revert and daemon rebuild. Existing post splitting remains available as terminal overflow/failure fallback.
