# Frontend State Management

## Current State Categories

The UI has no state library. State is intentionally minimal:

- Form/URL state: search text and filters live in native input values and become `URLSearchParams` for `/api/search`.
- Server state: search results and selected-message details are fetched on demand from read-only endpoints.
- View state: loading/error text, result count, active result, and detail contents live in the DOM.
- Durable state: all messages, processing metadata, sources, attachments, and tags remain in SQLite through `Store`; the browser is never authoritative.

## Rules

- Keep a value in the DOM when it is only needed for rendering/interaction.
- Promote repeated browser state to one small script variable only when it cannot be derived safely from controls or the DOM (for example the current selected message ID).
- Keep derived values derived: result count comes from the response/results, active styling from the selected ID, and filter query from current controls.
- A refresh is an acceptable cache invalidation mechanism. There is no client-side persistence, service worker, offline mode, or normalized cache.

## Common Mistakes

- Do not duplicate database/server state into long-lived browser globals.
- Do not add Redux, Zustand, React Query, or a framework store for this small UI.
- Do not expose mutation endpoints just to simplify view state.
- Clear or replace stale detail/error state when a new search changes the result set.
