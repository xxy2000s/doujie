# Frontend Quality Guidelines

## Required Patterns

- Keep the UI local-first and read-only; default host is `127.0.0.1`.
- Use semantic HTML, visible labels, keyboard focus styles, responsive layouts, and escaped external content.
- Reuse Store filters instead of duplicating search semantics in the web layer.
- Keep endpoints bounded (`MAX_WEB_LIMIT`) and return explicit JSON errors/status codes.
- Close the HTTP server and Store cleanly.

## Forbidden Patterns

- No public default bind, mutating endpoints, authentication assumptions that make public exposure safe, third-party trackers/CDNs, or credential display.
- No framework, bundler, UI/state dependency, or client persistence without an approved architecture change.
- No direct SQLite access from browser code and no duplicated raw SQL in the web server.
- No `innerHTML` interpolation of unescaped message data.

## Testing and Verification

Add focused cases to `tests/web-server.test.ts` for new routes, query validation, response shape, static asset behavior, and read-only enforcement. Use an isolated temp DB and ephemeral port (`port: 0`); never use the real DB. Browser interaction logic currently has no DOM test harness, so verify meaningful asset markers in automated tests and manually inspect interaction/accessibility when changing `APP_JS` or CSS.

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

There is no lint or frontend-specific build command.

## Review Checklist

- API, embedded browser script, and tests agree on field names and null handling.
- Query input is validated and bounded.
- Content is escaped and no sensitive runtime fields are exposed.
- Loading, empty, error, selected, and narrow-screen states remain usable.
- Non-GET requests still return 405 and the default host remains localhost.
