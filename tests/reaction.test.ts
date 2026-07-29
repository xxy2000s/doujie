import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReactionArgs } from '../src/reaction.js';

test('buildReactionArgs creates a Feishu reaction command', () => {
  assert.deepEqual(buildReactionArgs('om_1', 'DONE', 'bot'), [
    'im',
    'reactions',
    'create',
    '--params',
    JSON.stringify({ message_id: 'om_1' }),
    '--data',
    JSON.stringify({ reaction_type: { emoji_type: 'DONE' } }),
    '--as',
    'bot',
  ]);
});
