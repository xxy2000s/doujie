import type { CommandHandler, MessageContent } from '../types.js';
import type { Store } from '../store.js';
import type { CommandRuntime } from './index.js';
import { commandSection, commandTitle, field, joinBlocks } from './format.js';

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function createStatusHandler(
  store: Store,
  runtime: CommandRuntime
): CommandHandler {
  return async (_args: string, _message: MessageContent): Promise<string> => {
    const listener = runtime.getListenerStatus();
    const counts = store.getProcessingJobCounts();
    const modeCounts = store.getProcessingModeCounts();
    const searchDiagnostics = store.getSearchDiagnostics();
    const countText = Object.entries(counts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `${status}:${count}`)
      .join(' ') || 'none';
    const modeText = Object.entries(modeCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([mode, count]) => `${mode}:${count}`)
      .join(' ') || 'none';
    const lastEvent = listener.lastEventAt
      ? new Date(listener.lastEventAt).toLocaleString()
      : 'none';

    return joinBlocks([
      commandTitle('豆姐状态'),
      commandSection('运行', [
        field('Uptime', formatDuration(Date.now() - runtime.startedAt)),
        field('Listener', listener.state),
        field('Last event', lastEvent),
        field('Restarts', listener.restartCount),
        field('In-flight', runtime.inFlight.size),
      ]),
      commandSection('任务', [
        field('Jobs', countText),
        field('Modes', modeText),
      ]),
      commandSection('存储', [
        field('Search', `fts=${searchDiagnostics.fts_available ?? 'unknown'} backend=${searchDiagnostics.last_backend ?? 'none'}`),
        field('DB', `\`${runtime.dbPath}\``),
      ]),
    ]);
  };
}
