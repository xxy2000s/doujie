import type { CommandHandler } from '../types.js';
import { formatControlSessions, readControlSessionIndex } from '../control-sessions.js';
import type { CommandRuntime } from './index.js';

export function createSessionsHandler(runtime: CommandRuntime): CommandHandler {
  return async (): Promise<string> => {
    const index = readControlSessionIndex(runtime.controlSessionDir);
    return [
      `Control session dir: ${runtime.controlSessionDir}`,
      '',
      formatControlSessions(index),
    ].join('\n');
  };
}
