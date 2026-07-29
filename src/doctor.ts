import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './types.js';

export class DoctorError extends Error {
  failures: string[];

  constructor(failures: string[]) {
    super(`Startup doctor failed:\n- ${failures.join('\n- ')}`);
    this.name = 'DoctorError';
    this.failures = failures;
  }
}

export type CommandExists = (command: string) => boolean;

export type StartupDoctorOptions = {
  commandExists?: CommandExists;
};

export function defaultCommandExists(command: string): boolean {
  const result = spawnSync(command, ['--version'], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

export function runStartupDoctor(
  config: AppConfig,
  options: StartupDoctorOptions = {}
): void {
  const commandExists = options.commandExists ?? defaultCommandExists;
  const failures: string[] = [];

  for (const command of ['lark-cli', 'codex']) {
    if (!commandExists(command)) {
      failures.push(`${command} is not available on PATH`);
    }
  }

  try {
    const dbDir = path.dirname(config.storage.dbPath);
    fs.mkdirSync(dbDir, { recursive: true });
    fs.accessSync(dbDir, fs.constants.W_OK);
  } catch (err) {
    failures.push(`storage.db_path parent directory is not writable: ${(err as Error).message}`);
  }

  if (failures.length > 0) {
    throw new DoctorError(failures);
  }
}
