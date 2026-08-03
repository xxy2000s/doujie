import os from 'node:os';
import path from 'node:path';

export function safeDisplayPath(value: string, home = os.homedir()): string {
  if (!path.isAbsolute(value)) return value;
  if (value === home) return '~';
  if (value.startsWith(`${home}${path.sep}`)) return `~/${value.slice(home.length + 1)}`;
  if (isExternalHomeRoot(value)) return '<external>';
  return `<external>/${path.basename(value) || 'path'}`;
}

function isExternalHomeRoot(value: string): boolean {
  return value === '/root' || /^\/(?:home|Users)\/[^/]+\/?$/.test(value);
}

export function formatStartupPathLogs(
  workdir: string,
  dbPath: string,
  home = os.homedir()
): readonly [string, string] {
  return [
    `[doujie] Codex workdir: ${safeDisplayPath(workdir, home)}`,
    `[doujie] DB path: ${safeDisplayPath(dbPath, home)}`,
  ];
}
