import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  deactivateControlSession,
  findCodexSessionFile,
  formatControlSessions,
  readControlSessionIndex,
  recordControlSession,
} from '../src/control-sessions.js';

test('recordControlSession writes a Doujie control index and jsonl link', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doujie-control-sessions-'));
  const codexHome = path.join(dir, 'codex-home');
  const registryDir = path.join(dir, 'registry');
  const sessionFile = path.join(
    codexHome,
    'sessions',
    '2026',
    '07',
    '29',
    'rollout-2026-07-29T22-39-24-session-1.jsonl'
  );
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, '{}\n', 'utf-8');

  try {
    assert.equal(findCodexSessionFile('session-1', codexHome), sessionFile);

    const record = recordControlSession({
      sessionKey: 'oc_group',
      sessionId: 'session-1',
      workdir: '/repo/control',
      registryDir,
      codexHome,
      now: () => new Date('2026-07-29T00:00:00.000Z'),
    });

    assert.equal(record.codexJsonlPath, sessionFile);
    const index = readControlSessionIndex(registryDir);
    assert.equal(index.sessions.oc_group?.sessionId, 'session-1');
    assert.equal(index.sessions.oc_group?.workdir, '/repo/control');
    assert.equal(index.sessions.oc_group?.active, true);
    assert.ok(fs.existsSync(path.join(registryDir, 'README.md')));
    assert.ok(fs.existsSync(path.join(registryDir, 'links', 'oc_group.jsonl')));
    assert.match(formatControlSessions(index), /oc_group \[active\]/);

    deactivateControlSession('oc_group', registryDir);
    assert.equal(readControlSessionIndex(registryDir).sessions.oc_group?.active, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
