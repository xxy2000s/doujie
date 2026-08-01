# Error Handling

## Overview

Errors are handled at the boundary that can add context or recover: process wrappers convert exit failures into `Error`, the router records job failure and sends a safe Feishu response, the web handler maps failures to JSON, and `src/index.ts` handles fatal startup/shutdown errors.

## Error Types

Use custom errors only where callers need semantic branching:

- `ConfigError` in `src/config.ts` for invalid configuration.
- `DoctorError` in `src/doctor.ts` for grouped startup diagnostics.
- `CodexChatInterruptedError` in `src/ai/codex-chat.ts` for an expected cancellation path.

Ordinary invariant or subprocess failures use `Error` with actionable context, such as `cwd does not exist` or a command's exit code and sanitized stderr.

## Patterns

- Catch `unknown`, narrow with `instanceof` where behavior differs, otherwise use `(err as Error).message` at established external boundaries.
- Do not swallow errors. Either recover with a deliberate fallback, log/record the failure, or rethrow.
- Router failures update `processing_jobs`, redact log text with the configured privacy rules, attempt a user-safe error reply, and separately handle reply failure.
- Expected optional integration failures may degrade locally. For example, status-card updates and reactions log failure without discarding the underlying answer.
- Startup configuration/doctor failures are fatal; `main().catch(...)` logs a redacted message and sets a failing exit code.
- Always clean up resources in `finally`, including test servers, stores, temp directories, and spawned-process listeners.

## Client Responses

Feishu command handlers return plain text; unexpected router failures use `replyError` rather than exposing stack traces or credentials. The read-only web API uses JSON objects such as `{ error: 'not_found', message: '...' }` with suitable 4xx/5xx status codes. Unknown routes are 404 and all non-GET methods are 405 with `Allow: GET`.

## Common Mistakes

- Never include real config, tokens, WebSocket tickets, raw events, or unredacted subprocess output in user-facing errors or logs.
- Do not treat cancellation as a generic failure; preserve `CodexChatInterruptedError` behavior.
- Do not add broad empty `catch` blocks or continue after a failed required startup check.
- Do not return raw `Error` objects or stack traces through Feishu/web responses.
