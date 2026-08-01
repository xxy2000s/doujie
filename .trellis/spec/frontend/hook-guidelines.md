# Browser Logic and Data Fetching

## Overview

Doujie has no React/Vue/Svelte runtime and therefore no hooks. Do not create `use*` functions or add a hooks library. Stateful browser logic is ordinary JavaScript inside `APP_JS` in `src/web/assets.ts`.

## Patterns

- Cache stable DOM references once near browser-script initialization.
- Keep small functions for URL construction, fetch/status handling, escaping/formatting, list rendering, detail rendering, and error/status display.
- Register form and selection listeners once. Async handlers catch fetch failures and render a readable error state.
- Use the platform `fetch` API against same-origin `/api/*` routes; check `response.ok` and parse JSON.
- Search requests encode filters with `URLSearchParams`; detail requests identify the selected message by ID.
- Server endpoints stay read-only GET operations, so there is no optimistic update or client mutation queue.

## Naming

Use behavior names such as the existing `loadSearch`, `loadDetail`, `renderResults`, and `setStatus`, not hook-style `useSearch`. Prefer explicit parameters and return values over hidden shared state.

## Common Mistakes

- Do not add polling, caching libraries, or global event buses without a demonstrated need.
- Do not scatter duplicate fetch/error parsing across click handlers.
- Do not assume API payload fields are present; render empty/null states deliberately.
- Do not capture stale selected IDs across awaited calls without checking current selection when races are possible.
