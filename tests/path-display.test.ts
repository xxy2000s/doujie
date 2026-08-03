import assert from 'node:assert/strict';
import test from 'node:test';
import { formatStartupPathLogs, safeDisplayPath } from '../src/path-display.js';

test('safeDisplayPath neutralizes external absolute paths and preserves safe forms', () => {
  const home = '/Users/current';
  assert.equal(safeDisplayPath(home, home), '~');
  assert.equal(safeDisplayPath('/Users/current/service/doujie', home), '~/service/doujie');
  assert.equal(safeDisplayPath('/home/other/service/doujie', home), '<external>/doujie');
  assert.equal(safeDisplayPath('/Users/other/private.db', home), '<external>/private.db');
  assert.equal(safeDisplayPath('/home/other', home), '<external>');
  assert.equal(safeDisplayPath('/Users/other', home), '<external>');
  assert.equal(safeDisplayPath('/root', home), '<external>');
  assert.equal(safeDisplayPath('relative/data.db', home), 'relative/data.db');
});

test('startup path formatter never emits external usernames or absolute paths', () => {
  const lines = formatStartupPathLogs('/home/other/workspace', '/Users/other/data.db', '/Users/current');
  assert.deepEqual(lines, [
    '[doujie] Codex workdir: <external>/workspace',
    '[doujie] DB path: <external>/data.db',
  ]);
  assert.doesNotMatch(lines.join('\n'), /\/home\/other|\/Users\/other/);
});
