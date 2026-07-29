import type { CommandHandler, MessageContent } from '../types.js';
import type { SearchMessagesOptions, Store } from '../store.js';

type ParsedSearch =
  | { ok: true; options: SearchMessagesOptions; label: string }
  | { ok: false; error: string };

function parseDate(value: string, endOfDay: boolean): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  const timestamp = Date.parse(`${value}${suffix}`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseSearchArgs(args: string): ParsedSearch {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const keywordParts: string[] = [];
  const options: SearchMessagesOptions = { keyword: '' };

  for (const token of tokens) {
    const separator = token.indexOf(':');
    const key = separator > 0 ? token.slice(0, separator).toLowerCase() : '';
    const value = separator > 0 ? token.slice(separator + 1) : '';

    if (key === 'tag') {
      if (!value) return { ok: false, error: 'Usage: tag:<tag>' };
      options.tag = value;
    } else if (key === 'source') {
      if (!value) return { ok: false, error: 'Usage: source:<domain-or-url>' };
      options.source = value;
    } else if (key === 'limit') {
      const limit = Number.parseInt(value, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
        return { ok: false, error: 'Usage: limit:<1-20>' };
      }
      options.limit = limit;
    } else if (key === 'since') {
      const since = parseDate(value, false);
      if (since === null) return { ok: false, error: 'Usage: since:<YYYY-MM-DD>' };
      options.since = since;
    } else if (key === 'until') {
      const until = parseDate(value, true);
      if (until === null) return { ok: false, error: 'Usage: until:<YYYY-MM-DD>' };
      options.until = until;
    } else {
      keywordParts.push(token);
    }
  }

  options.keyword = keywordParts.join(' ');
  if (!options.keyword && !options.tag && !options.source && options.since === undefined && options.until === undefined) {
    return { ok: false, error: 'Usage: /search <keyword> [tag:<tag>] [since:<YYYY-MM-DD>] [until:<YYYY-MM-DD>] [source:<domain-or-url>] [limit:<1-20>]' };
  }

  const labels = [
    options.keyword ? `"${options.keyword}"` : '',
    options.tag ? `tag:${options.tag}` : '',
    options.source ? `source:${options.source}` : '',
    options.since ? `since:${new Date(options.since).toISOString().slice(0, 10)}` : '',
    options.until ? `until:${new Date(options.until).toISOString().slice(0, 10)}` : '',
  ].filter(Boolean);

  return { ok: true, options, label: labels.join(' ') || 'filters' };
}

export function createSearchHandler(store: Store): CommandHandler {
  return async (args: string, _message: MessageContent): Promise<string> => {
    const parsed = parseSearchArgs(args);
    if (!parsed.ok) {
      return parsed.error;
    }

    const results = store.searchMessages(parsed.options);
    if (results.length === 0) {
      return `No results found for ${parsed.label}.`;
    }

    const lines = results.map((r, i) => {
      const summary = r.summary ? `\n  Summary: ${r.summary.slice(0, 100)}` : '';
      const tags = r.tags ? `\n  Tags: ${r.tags}` : '';
      const sources = r.sources ? `\n  Sources: ${r.sources}` : '';
      const date = new Date(r.receivedAt).toLocaleString();
      return `${i + 1}. [${date}] ${r.content.slice(0, 80)}${summary}${tags}${sources}`;
    });

    return `Search results for ${parsed.label} (${results.length} found):\n\n${lines.join('\n\n')}`;
  };
}
