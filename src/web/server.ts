import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INDEX_HTML, APP_JS, STYLES_CSS } from './assets.js';
import type { SearchMessagesOptions, Store } from '../store.js';

export const DEFAULT_WEB_HOST = '127.0.0.1';
export const DEFAULT_WEB_PORT = 8787;
const MAX_WEB_LIMIT = 100;
const DEFAULT_WEB_LIMIT = 30;

export type InfoHunterWebServerOptions = {
  host?: string;
  port?: number;
};

export type InfoHunterWebServer = {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
};

type JsonPayload = Record<string, unknown> | unknown[];

type SearchParseResult =
  | { ok: true; options: SearchMessagesOptions }
  | { ok: false; message: string };

export function createInfoHunterWebHandler(
  store: Store,
  metadata: { host: string; getPort: () => number }
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed', message: 'Doujie web UI is read-only.' }, {
        Allow: 'GET',
      });
      return;
    }

    const requestUrl = new URL(req.url ?? '/', `http://${metadata.host}:${metadata.getPort()}`);
    try {
      if (requestUrl.pathname === '/') {
        sendText(res, 200, INDEX_HTML, 'text/html; charset=utf-8');
      } else if (requestUrl.pathname === '/static/styles.css') {
        sendText(res, 200, STYLES_CSS, 'text/css; charset=utf-8');
      } else if (requestUrl.pathname === '/static/app.js') {
        sendText(res, 200, APP_JS, 'text/javascript; charset=utf-8');
      } else if (requestUrl.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, host: metadata.host, port: metadata.getPort(), readonly: true });
      } else if (requestUrl.pathname === '/api/search') {
        handleSearch(store, requestUrl, res);
      } else if (requestUrl.pathname === '/api/message') {
        handleMessage(store, requestUrl, res);
      } else {
        sendJson(res, 404, { error: 'not_found', message: `Unknown path: ${requestUrl.pathname}` });
      }
    } catch (err) {
      sendJson(res, 500, { error: 'server_error', message: (err as Error).message });
    }
  };
}

export async function startInfoHunterWebServer(
  store: Store,
  options: InfoHunterWebServerOptions = {}
): Promise<InfoHunterWebServer> {
  const host = options.host ?? DEFAULT_WEB_HOST;
  const requestedPort = options.port ?? DEFAULT_WEB_PORT;
  let actualPort = requestedPort;
  const server = createServer(createInfoHunterWebHandler(store, {
    host,
    getPort: () => actualPort,
  }));

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      if (typeof address === 'object' && address !== null) {
        actualPort = address.port;
      }
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, host);
  });

  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () => closeServer(server),
  };
}

function handleSearch(store: Store, requestUrl: URL, res: ServerResponse): void {
  const parsed = parseSearchOptions(requestUrl.searchParams);
  if (parsed.ok === false) {
    sendJson(res, 400, { error: 'bad_request', message: parsed.message });
    return;
  }

  const results = store.searchMessages(parsed.options, DEFAULT_WEB_LIMIT, MAX_WEB_LIMIT);
  sendJson(res, 200, {
    results,
    count: results.length,
    readonly: true,
  });
}

function handleMessage(store: Store, requestUrl: URL, res: ServerResponse): void {
  const id = requestUrl.searchParams.get('id')?.trim();
  if (!id) {
    sendJson(res, 400, { error: 'bad_request', message: 'Missing message id.' });
    return;
  }

  const message = store.getMessageDetail(id);
  if (!message) {
    sendJson(res, 404, { error: 'not_found', message: `Message not found: ${id}` });
    return;
  }
  sendJson(res, 200, { message, readonly: true });
}

function parseSearchOptions(params: URLSearchParams): SearchParseResult {
  const since = parseDateParam(params.get('since'), false, 'since');
  if (since.ok === false) return since;
  const until = parseDateParam(params.get('until'), true, 'until');
  if (until.ok === false) return until;

  const limit = parseLimit(params.get('limit'));
  const options: SearchMessagesOptions = {
    keyword: params.get('q')?.trim() ?? '',
    limit,
  };
  const tag = params.get('tag')?.trim();
  const source = params.get('source')?.trim();
  if (tag) options.tag = tag;
  if (source) options.source = source;
  if (since.value !== null) options.since = since.value;
  if (until.value !== null) options.until = until.value;
  return { ok: true, options };
}

function parseDateParam(
  value: string | null,
  endOfDay: boolean,
  label: string
): { ok: true; value: number | null } | { ok: false; message: string } {
  if (!value) return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { ok: false, message: `${label} must use YYYY-MM-DD.` };
  }
  const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  const timestamp = Date.parse(`${value}${suffix}`);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, message: `${label} must be a valid date.` };
  }
  return { ok: true, value: timestamp };
}

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed)) return DEFAULT_WEB_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_WEB_LIMIT);
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: JsonPayload,
  headers: Record<string, string> = {}
): void {
  const body = JSON.stringify(payload, null, 2);
  sendText(res, status, body, 'application/json; charset=utf-8', headers);
}

function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err?: Error) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export function getServerPort(server: Server): number {
  const address = server.address();
  if (typeof address === 'object' && address !== null) return (address as AddressInfo).port;
  return 0;
}
