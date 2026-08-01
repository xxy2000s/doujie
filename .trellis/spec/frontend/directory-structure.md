# Frontend Directory Structure

## Overview

Doujie's frontend is a small, framework-free, read-only local memory UI. It is not React and has no bundler, components directory, hooks, npm UI dependencies, or separate public assets.

## Layout

```text
src/web/
├── index.ts       # CLI entry; config/store/server lifecycle
├── server.ts      # localhost HTTP server and read-only JSON API
└── assets.ts      # exported INDEX_HTML, STYLES_CSS, and APP_JS strings
tests/
└── web-server.test.ts
```

`src/web/server.ts` serves `/`, `/static/styles.css`, `/static/app.js`, `/api/health`, `/api/search`, and `/api/message`. `src/web/assets.ts` keeps the HTML, CSS, and browser JavaScript together because the UI is intentionally small and dependency-free.

## Organization and Naming

- Add a route in `server.ts` only when Store already exposes (or is extended with) the required read-only query.
- Keep DOM rendering and interaction helpers inside `APP_JS`; shared server-side contracts remain TypeScript types in `server.ts`/`store.ts`.
- Use kebab-case CSS classes with BEM-like modifiers where useful (`status--error`, `result-item--active`).
- Use camelCase browser functions and `data-*` attributes for stable DOM identity.
- If the UI grows enough to justify files or a framework, make that an explicit architectural change rather than pretending such a structure already exists.

## Examples

- `startDoujieWebServer` binds to `127.0.0.1` by default and returns a `close()` handle.
- `handleSearch` parses bounded URL parameters before calling Store.
- `tests/web-server.test.ts` exercises static assets, filtered search, message details, and rejection of mutation methods.
