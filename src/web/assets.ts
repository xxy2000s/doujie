export const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Doujie Memory Search</title>
    <link rel="stylesheet" href="/static/styles.css">
  </head>
  <body>
    <main class="app-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Doujie</p>
          <h1>Local knowledge search</h1>
        </div>
        <div class="server-chip" id="server-chip">127.0.0.1</div>
      </header>

      <section class="filters" aria-label="Search filters">
        <label class="field field--wide">
          <span>Search</span>
          <input id="q" name="q" type="search" autocomplete="off" placeholder="Keyword, summary, entity, action item">
        </label>
        <label class="field">
          <span>Tag</span>
          <input id="tag" name="tag" type="text" autocomplete="off" placeholder="技术">
        </label>
        <label class="field">
          <span>Source</span>
          <input id="source" name="source" type="text" autocomplete="off" placeholder="example.com">
        </label>
        <label class="field">
          <span>Since</span>
          <input id="since" name="since" type="date">
        </label>
        <label class="field">
          <span>Until</span>
          <input id="until" name="until" type="date">
        </label>
        <label class="field field--small">
          <span>Limit</span>
          <input id="limit" name="limit" type="number" min="1" max="100" value="30">
        </label>
        <button id="search-button" class="button" type="button">Search</button>
      </section>

      <section class="workspace">
        <section class="results-panel" aria-label="Search results">
          <div class="panel-header">
            <h2>Results</h2>
            <span id="result-count" class="muted">Loading</span>
          </div>
          <div id="status" class="status">Loading recent messages...</div>
          <div id="results" class="results-list" aria-live="polite"></div>
        </section>

        <aside class="detail-panel" aria-label="Message detail">
          <div class="panel-header">
            <h2>Detail</h2>
            <span id="detail-date" class="muted"></span>
          </div>
          <div id="detail" class="detail-empty">Select a result to inspect the captured content.</div>
        </aside>
      </section>
    </main>
    <script src="/static/app.js"></script>
  </body>
</html>`;

export const STYLES_CSS = `:root {
  color-scheme: light;
  --bg: #f5f7f8;
  --surface: #ffffff;
  --surface-soft: #eef3f5;
  --ink: #172026;
  --muted: #64717a;
  --line: #d8e0e4;
  --line-strong: #bac7ce;
  --accent: #0f766e;
  --accent-ink: #ffffff;
  --danger: #b42318;
  --radius: 8px;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100dvh;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 14px;
}

button,
input {
  font: inherit;
}

.app-shell {
  width: min(1480px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 20px 0 24px;
}

.topbar {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 16px;
}

.eyebrow {
  margin: 0 0 4px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

h1,
h2,
h3,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: 0;
  font-size: 28px;
  line-height: 1.1;
  letter-spacing: 0;
}

h2 {
  margin-bottom: 0;
  font-size: 14px;
}

h3 {
  margin-bottom: 8px;
  font-size: 13px;
}

.server-chip {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  padding: 7px 10px;
}

.filters {
  display: grid;
  grid-template-columns: minmax(260px, 2fr) repeat(5, minmax(110px, 1fr)) auto;
  gap: 10px;
  align-items: end;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 12px;
  margin-bottom: 12px;
}

.field {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.field span {
  color: var(--muted);
  font-size: 12px;
}

.field input {
  width: 100%;
  height: 36px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fbfcfd;
  color: var(--ink);
  padding: 0 10px;
  outline: none;
}

.field input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.13);
}

.button {
  height: 36px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: var(--accent-ink);
  padding: 0 14px;
  cursor: pointer;
}

.button:active {
  transform: translateY(1px);
}

.workspace {
  display: grid;
  grid-template-columns: minmax(360px, 0.9fr) minmax(460px, 1.1fr);
  gap: 12px;
  min-height: calc(100dvh - 156px);
}

.results-panel,
.detail-panel {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  border-bottom: 1px solid var(--line);
  padding: 0 14px;
}

.muted {
  color: var(--muted);
  font-size: 12px;
}

.status {
  border-bottom: 1px solid var(--line);
  color: var(--muted);
  padding: 10px 14px;
}

.status:empty {
  display: none;
}

.status--error {
  color: var(--danger);
}

.results-list {
  max-height: calc(100dvh - 214px);
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.result-item {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  text-align: left;
  padding: 12px 14px;
  cursor: pointer;
}

.result-item:hover,
.result-item--active {
  background: var(--surface-soft);
}

.result-item__meta,
.result-item__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 7px;
}

.result-item__title {
  margin-bottom: 6px;
  font-weight: 650;
  line-height: 1.35;
}

.result-item__summary {
  color: #34424a;
  line-height: 1.45;
}

.tag,
.source-pill {
  display: inline-flex;
  max-width: 180px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1;
  padding: 4px 7px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.detail-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}

.detail-empty,
.detail-content {
  padding: 16px;
}

.detail-empty {
  color: var(--muted);
}

.detail-content {
  max-height: calc(100dvh - 214px);
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.detail-section {
  border-top: 1px solid var(--line);
  padding-top: 14px;
  margin-top: 14px;
}

.detail-section:first-child {
  border-top: 0;
  padding-top: 0;
  margin-top: 0;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.kv {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fbfcfd;
  padding: 8px;
}

.kv span {
  display: block;
  color: var(--muted);
  font-size: 11px;
  margin-bottom: 4px;
}

.pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}

.mono {
  font-family: var(--mono);
  font-size: 12px;
}

@media (max-width: 1100px) {
  .filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .field--wide {
    grid-column: 1 / -1;
  }

  .button {
    width: 100%;
  }

  .workspace {
    grid-template-columns: 1fr;
  }

  .results-list,
  .detail-content {
    max-height: none;
  }
}

@media (max-width: 640px) {
  .app-shell {
    width: min(100vw - 20px, 1480px);
    padding-top: 12px;
  }

  .topbar {
    align-items: start;
    flex-direction: column;
  }

  .filters {
    grid-template-columns: 1fr;
  }

  .detail-grid {
    grid-template-columns: 1fr;
  }
}
`;

export const APP_JS = `const state = {
  selectedId: null,
  results: []
};

const els = {
  q: document.getElementById('q'),
  tag: document.getElementById('tag'),
  source: document.getElementById('source'),
  since: document.getElementById('since'),
  until: document.getElementById('until'),
  limit: document.getElementById('limit'),
  searchButton: document.getElementById('search-button'),
  resultCount: document.getElementById('result-count'),
  status: document.getElementById('status'),
  results: document.getElementById('results'),
  detail: document.getElementById('detail'),
  detailDate: document.getElementById('detail-date'),
  serverChip: document.getElementById('server-chip')
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function formatDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString();
}

function compact(value, max) {
  const text = String(value ?? '').replace(/\\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.className = isError ? 'status status--error' : 'status';
}

function searchParams() {
  const params = new URLSearchParams();
  const pairs = [
    ['q', els.q.value],
    ['tag', els.tag.value],
    ['source', els.source.value],
    ['since', els.since.value],
    ['until', els.until.value],
    ['limit', els.limit.value]
  ];
  for (const [key, value] of pairs) {
    if (String(value).trim()) params.set(key, String(value).trim());
  }
  return params;
}

async function loadSearch() {
  setStatus('Loading...');
  els.resultCount.textContent = 'Loading';
  try {
    const response = await fetch('/api/search?' + searchParams().toString());
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || 'Search failed');
    state.results = payload.results || [];
    renderResults();
    setStatus(state.results.length ? '' : 'No messages match these filters.');
    els.resultCount.textContent = String(state.results.length) + ' shown';
    if (state.results.length && !state.selectedId) {
      await loadDetail(state.results[0].id);
    }
  } catch (error) {
    state.results = [];
    renderResults();
    els.resultCount.textContent = 'Error';
    setStatus(error.message, true);
  }
}

function renderResults() {
  els.results.innerHTML = state.results.map((row) => {
    const tags = parseArray(row.tags).map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join('');
    const sources = row.sources ? '<span class="source-pill">' + escapeHtml(row.sources) + '</span>' : '';
    const active = row.id === state.selectedId ? ' result-item--active' : '';
    const title = row.summary || row.content || row.id;
    const summary = row.summary ? row.content : '';
    return '<button class="result-item' + active + '" type="button" data-id="' + escapeHtml(row.id) + '">' +
      '<div class="result-item__meta"><span>' + escapeHtml(formatDate(row.receivedAt)) + '</span><span class="mono">' + escapeHtml(row.id) + '</span>' + sources + '</div>' +
      '<div class="result-item__title">' + escapeHtml(compact(title, 130)) + '</div>' +
      (summary ? '<div class="result-item__summary">' + escapeHtml(compact(summary, 180)) + '</div>' : '') +
      (tags ? '<div class="result-item__tags">' + tags + '</div>' : '') +
      '</button>';
  }).join('');

  for (const item of els.results.querySelectorAll('.result-item')) {
    item.addEventListener('click', () => loadDetail(item.dataset.id));
  }
}

async function loadDetail(id) {
  if (!id) return;
  state.selectedId = id;
  renderResults();
  els.detail.innerHTML = '<div class="detail-empty">Loading detail...</div>';
  try {
    const response = await fetch('/api/message?id=' + encodeURIComponent(id));
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || 'Detail failed');
    renderDetail(payload.message);
  } catch (error) {
    els.detail.innerHTML = '<div class="detail-empty">' + escapeHtml(error.message) + '</div>';
  }
}

function renderDetail(message) {
  els.detailDate.textContent = formatDate(message.receivedAt);
  const processed = message.processed;
  const tags = processed ? parseArray(processed.tags) : [];
  const keyPoints = processed ? parseArray(processed.keyPoints) : [];
  const actionItems = processed ? parseArray(processed.actionItems) : [];
  const entities = processed ? parseArray(processed.entities) : [];
  const sources = message.sources || [];
  const attachments = message.attachments || [];

  els.detail.innerHTML = '<div class="detail-content">' +
    section('Message', '<div class="detail-grid">' +
      kv('ID', message.id, true) +
      kv('Type', message.messageType, false) +
      kv('Chat', message.chatId, true) +
      kv('Sender', message.senderId, true) +
      '</div><div class="detail-section"><pre class="pre">' + escapeHtml(message.content) + '</pre></div>') +
    section('Summary', processed && processed.summary ? '<pre class="pre">' + escapeHtml(processed.summary) + '</pre>' : '<p class="muted">No processed summary.</p>') +
    section('Tags', tags.length ? tags.map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join(' ') : '<p class="muted">No tags.</p>') +
    section('Key Points', renderList(keyPoints)) +
    section('Action Items', renderList(actionItems)) +
    section('Entities', renderList(entities)) +
    section('Sources', sources.length ? sources.map(renderSource).join('') : '<p class="muted">No linked sources.</p>') +
    section('Attachments', attachments.length ? attachments.map(renderAttachment).join('') : '<p class="muted">No attachments.</p>') +
    '</div>';
}

function section(title, body) {
  return '<section class="detail-section"><h3>' + escapeHtml(title) + '</h3>' + body + '</section>';
}

function kv(label, value, mono) {
  return '<div class="kv"><span>' + escapeHtml(label) + '</span><div class="' + (mono ? 'mono' : '') + '">' + escapeHtml(value || '-') + '</div></div>';
}

function renderList(items) {
  if (!items.length) return '<p class="muted">None.</p>';
  return '<ul>' + items.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>';
}

function renderSource(source) {
  return '<div class="kv"><span>' + escapeHtml(source.domain || 'source') + '</span><div>' +
    '<a href="' + escapeHtml(source.finalUrl || source.canonicalUrl) + '" target="_blank" rel="noreferrer">' + escapeHtml(source.title || source.canonicalUrl) + '</a>' +
    '<div class="muted">' + escapeHtml(source.fetchStatus) + ' · ' + escapeHtml(source.contentLength) + ' chars</div>' +
    '</div></div>';
}

function renderAttachment(attachment) {
  return '<div class="kv"><span>' + escapeHtml(attachment.resourceType) + '</span><div>' +
    escapeHtml(attachment.fileName || attachment.resourceKey) +
    '<div class="muted">' + escapeHtml(attachment.downloadStatus) + ' · extraction: ' + escapeHtml(attachment.extractionStatus || 'pending') + '</div>' +
    (attachment.extractionError ? '<div class="muted">' + escapeHtml(attachment.extractionError) + '</div>' : '') +
    '</div></div>';
}

async function loadHealth() {
  try {
    const response = await fetch('/api/health');
    const payload = await response.json();
    if (payload.host && payload.port) {
      els.serverChip.textContent = payload.host + ':' + payload.port;
    }
  } catch {
    els.serverChip.textContent = 'local';
  }
}

els.searchButton.addEventListener('click', () => {
  state.selectedId = null;
  loadSearch();
});

for (const input of [els.q, els.tag, els.source, els.since, els.until, els.limit]) {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      state.selectedId = null;
      loadSearch();
    }
  });
}

loadHealth();
loadSearch();
`;
