import assert from 'node:assert/strict';
import test from 'node:test';
import { runStartupDoctor, DoctorError } from '../src/doctor.js';
import { createTempDbPath, removeTempDir } from './helpers.js';

test('runStartupDoctor passes when commands exist and DB directory is writable', () => {
  const { dir, dbPath } = createTempDbPath('doujie-doctor-pass');
  try {
    assert.doesNotThrow(() => runStartupDoctor(
      {
        codex: { model: 'test-model' },
        feishu: { chatIds: [], as: 'bot' },
        storage: { dbPath },
      },
      { commandExists: () => true }
    ));
  } finally {
    removeTempDir(dir);
  }
});

test('runStartupDoctor reports missing local commands', () => {
  const { dir, dbPath } = createTempDbPath('doujie-doctor-fail');
  try {
    assert.throws(
      () => runStartupDoctor(
        {
          codex: { model: 'test-model' },
          feishu: { chatIds: [], as: 'bot' },
          storage: { dbPath },
        },
        { commandExists: (command) => command !== 'codex' }
      ),
      (err: unknown) => err instanceof DoctorError &&
        err.failures.includes('codex is not available on PATH')
    );
  } finally {
    removeTempDir(dir);
  }
});

