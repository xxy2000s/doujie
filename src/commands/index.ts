import type { CommandDefinition, CommandHandler } from '../types.js';
import type { Store } from '../store.js';
import type { ListenerStatus } from '../listener.js';
import { createHelpHandler } from './help.js';
import { createSearchHandler } from './search.js';
import { createStatusHandler } from './status.js';
import { createRecentHandler } from './recent.js';
import { createErrorsHandler } from './errors.js';
import { createBackupHandler, createCleanupHandler, createExportHandler } from './maintenance.js';
import { createSessionsHandler } from './sessions.js';

export type CommandRuntime = {
  startedAt: number;
  inFlight: Set<string>;
  dbPath: string;
  backupDir: string;
  exportDir: string;
  controlSessionDir: string;
  clock?: () => number;
  getListenerStatus(): ListenerStatus;
};

function defaultRuntime(): CommandRuntime {
  return {
    startedAt: Date.now(),
    inFlight: new Set<string>(),
    dbPath: '(unknown)',
    backupDir: '.',
    exportDir: '.',
    controlSessionDir: '.',
    getListenerStatus: () => ({ state: 'stopped', lastEventAt: null, restartCount: 0 }),
  };
}

export function createCommandRegistry(
  store: Store,
  runtime: CommandRuntime = defaultRuntime()
): Map<string, CommandHandler> {
  const definitions = createCommandDefinitions(store, runtime);
  const registry = new Map<string, CommandHandler>();
  for (const definition of definitions) {
    registry.set(definition.name, definition.handler);
  }
  return registry;
}

export function createCommandDefinitions(
  store: Store,
  runtime: CommandRuntime = defaultRuntime()
): CommandDefinition[] {
  const definitions: CommandDefinition[] = [
    {
      name: 'search',
      usage: 'search <keyword>',
      description: 'Search stored messages',
      handler: createSearchHandler(store),
    },
    {
      name: 'retry',
      usage: 'retry <message_id>',
      description: 'Retry a failed message',
      handler: async (): Promise<string> => 'Retry is handled by the router.',
    },
    {
      name: 'save',
      usage: 'save <text>',
      description: 'Save text without running AI digest',
      handler: async (): Promise<string> => 'Save is handled by the router.',
    },
    {
      name: 'digest',
      usage: 'digest <text>',
      description: 'Run AI digest for the provided text',
      handler: async (): Promise<string> => 'Digest is handled by the router.',
    },
    {
      name: 'skip',
      usage: 'skip [reason]',
      description: 'Record an intentional skip without AI processing',
      handler: async (): Promise<string> => 'Skip is handled by the router.',
    },
    {
      name: 'redo',
      usage: 'redo <message_id>',
      description: 'Re-run digest for an existing message without duplicate target replies',
      handler: async (): Promise<string> => 'Redo is handled by the router.',
    },
    {
      name: 'retag',
      usage: 'retag <message_id> <tag...>',
      description: 'Replace tags for a processed message',
      handler: async (): Promise<string> => 'Retag is handled by the router.',
    },
    {
      name: 'merge-tag',
      usage: 'merge-tag <from> <to>',
      description: 'Merge a tag alias into a canonical tag',
      handler: async (): Promise<string> => 'Tag merge is handled by the router.',
    },
    {
      name: 'ask',
      usage: 'ask <question>',
      description: 'Answer a question using stored message evidence',
      handler: async (): Promise<string> => 'Ask is handled by the router.',
    },
    {
      name: 'codex',
      usage: 'codex <prompt>',
      description: 'Run an interactive Codex CLI turn from Feishu',
      handler: async (): Promise<string> => 'Codex chat is handled by the router.',
    },
    {
      name: 'new',
      usage: 'new [prompt]',
      description: 'Start a fresh Codex CLI session for this Feishu chat',
      handler: async (): Promise<string> => 'Codex session reset is handled by the router.',
    },
    {
      name: 'detail',
      usage: 'detail <prompt>',
      description: 'Run a Codex CLI turn with detailed events',
      handler: async (): Promise<string> => 'Codex detail mode is handled by the router.',
    },
    {
      name: 'status',
      usage: 'status',
      description: 'Show daemon health and processing counts',
      handler: createStatusHandler(store, runtime),
    },
    {
      name: 'recent',
      usage: 'recent [limit]',
      description: 'Show recent captured messages',
      handler: createRecentHandler(store),
    },
    {
      name: 'errors',
      usage: 'errors [limit]',
      description: 'Show recent processing failures',
      handler: createErrorsHandler(store),
    },
    {
      name: 'sessions',
      usage: 'sessions',
      description: 'Show Doujie control-plane Codex sessions',
      handler: createSessionsHandler(runtime),
    },
    {
      name: 'backup',
      usage: 'backup',
      description: 'Create and verify a local SQLite backup',
      handler: createBackupHandler(store, runtime),
    },
    {
      name: 'export',
      usage: 'export [format:jsonl|md] [filters]',
      description: 'Export stored messages to JSONL or Markdown',
      handler: createExportHandler(store, runtime),
    },
    {
      name: 'cleanup',
      usage: 'cleanup dry-run|run messages:<days>',
      description: 'Dry-run or apply local message retention cleanup',
      handler: createCleanupHandler(store, runtime),
    },
  ];
  const allDefinitions: CommandDefinition[] = [
    {
      name: 'help',
      usage: 'help',
      description: 'Show this help message',
      handler: async (args, message) => createHelpHandler(allDefinitions)(args, message),
    },
    ...definitions,
  ];
  return allDefinitions;
}
