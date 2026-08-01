# Frontend Component Guidelines

## Current Component Model

There are no framework components or props. `INDEX_HTML` supplies the static semantic shell; small JavaScript render functions in `APP_JS` turn API payloads into result/detail markup and update existing elements selected by ID or class.

Keep this model for incremental changes:

- Static landmarks, filter form, results panel, and detail panel belong in `INDEX_HTML`.
- Repeated/dynamic UI belongs in focused browser functions. For example, `renderResults()` recreates result buttons and binds each button to `loadDetail()` after rendering.
- Pass plain data values/objects into rendering helpers; do not introduce a component abstraction solely to imitate React.
- Keep top-level listeners registered once, as the search form submit handler is; listeners for recreated result nodes are bound inside `renderResults()`.

## Styling

All styles live in `STYLES_CSS`. Reuse CSS custom properties such as `--ink`, `--muted`, `--surface`, `--line`, and `--accent`. The current visual language uses flat bordered panels, compact spacing, system/mono typography, and responsive grid changes; it does not use Tailwind, CSS modules, CSS-in-JS, gradients, or heavy shadows.

## Accessibility

- Preserve semantic `form`, `label`, `button`, headings, and status text.
- Every form control needs a visible label; buttons use native button behavior.
- Preserve keyboard focus visibility and do not rely on color alone for selection/error state.
- Dynamic status/error changes should remain understandable as text.
- Escape externally sourced message, tag, URL, attachment, and summary content before inserting HTML. Do not interpolate API text directly into `innerHTML`.

## Common Mistakes

- Do not document or implement React props/hooks conventions in this project.
- Do not add inline element styles when an existing/new CSS class is appropriate.
- Do not make the local UI mutating; it is deliberately read-only.
- Do not bind it to a public interface by default or load third-party CDN assets.
