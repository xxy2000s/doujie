import { loadConfig } from '../config.js';
import { Store } from '../store.js';
import { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT, startInfoHunterWebServer } from './server.js';

type WebCliOptions = {
  host: string;
  port: number;
  dbPath: string | null;
};

function parseArgs(argv: string[]): WebCliOptions {
  const options: WebCliOptions = {
    host: DEFAULT_WEB_HOST,
    port: DEFAULT_WEB_PORT,
    dbPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--') {
      continue;
    } else if (arg === '--host' && next) {
      options.host = next;
      index += 1;
    } else if (arg === '--port' && next) {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error('--port must be between 0 and 65535');
      }
      options.port = parsed;
      index += 1;
    } else if (arg === '--db' && next) {
      options.dbPath = next;
      index += 1;
    } else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`Doujie local memory UI

Usage:
  pnpm web -- [--host 127.0.0.1] [--port 8787] [--db /path/to/data.db]

The server is read-only and binds to 127.0.0.1 by default.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const store = new Store(options.dbPath ?? config.storage.dbPath);
  const web = await startInfoHunterWebServer(store, {
    host: options.host,
    port: options.port,
  });

  console.log(`[web] Doujie local memory UI: ${web.url}`);
  console.log(`[web] Database: ${options.dbPath ?? config.storage.dbPath}`);

  const shutdown = async (): Promise<void> => {
    await web.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    shutdown().catch((err: Error) => {
      console.error('[web] Shutdown failed:', err.message);
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    shutdown().catch((err: Error) => {
      console.error('[web] Shutdown failed:', err.message);
      process.exit(1);
    });
  });
}

main().catch((err: Error) => {
  console.error('[web] Fatal error:', err.message);
  process.exit(1);
});
