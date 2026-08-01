# Frontend Type Safety

## Overview

Server code is strict TypeScript; embedded `APP_JS` is plain browser JavaScript stored in a string and is not independently typechecked. Maintain the trust boundary in `src/web/server.ts`: parse URL input, clamp limits, return stable JSON shapes, and expose only Store-normalized data.

## Type Organization

- Server option/result and parse-result types stay beside `startDoujieWebServer` in `server.ts`.
- Shared persisted/search shapes belong in `src/store.ts` or `src/types.ts`, not duplicated in web code.
- Use discriminated unions for parse outcomes, as with `SearchParseResult` (`{ ok: true, options } | { ok: false, message }`).
- Tests use local response payload types with `readJson<T>()` to document the endpoint fields under assertion.

## Runtime Validation

There is no Zod/Yup dependency. Validate URL query values with explicit functions: reject invalid dates/numbers, apply defaults, clamp `limit` to the server maximum, and return a 400 error rather than passing invalid values to Store. Treat missing route/method/message IDs explicitly.

Browser rendering must tolerate null/optional fields and escape all external text before HTML insertion. Do not mistake TypeScript response annotations in tests for runtime validation.

## Forbidden Patterns

- No `any`, `@ts-ignore`, or unchecked assertions for request/query data.
- Do not cast `req.url` payloads directly to Store options.
- Do not maintain separate hand-written client and server schemas that silently diverge; when the API expands, update handler, browser consumer, and `tests/web-server.test.ts` together.
- Do not insert unescaped API content into HTML templates.
