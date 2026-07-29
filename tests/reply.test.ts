import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReplyArgs, formatReply } from '../src/reply.js';
import { aiResult } from './helpers.js';

test('formatReply renders summary and tags', () => {
  const reply = formatReply(aiResult({
    summary: '1. 第一条\n2. 第二条',
    tags: ['技术', '学习'],
  }));

  assert.equal(reply, '**AI Summary**\n\n1. 第一条\n2. 第二条\n\n**Tags**: #技术 #学习');
});

test('formatReply renders high-signal structured fields', () => {
  const reply = formatReply(aiResult({
    summary: '摘要',
    tags: ['待办'],
    actionItems: ['跟进 A', '确认 B'],
    entities: ['Doujie', 'Codex'],
  }));

  assert.match(reply, /Action Items/);
  assert.match(reply, /- 跟进 A/);
  assert.match(reply, /\*\*Entities\*\*: Doujie, Codex/);
});

test('buildReplyArgs uses configured Feishu identity', () => {
  const args = buildReplyArgs('msg-1', 'hello', 'user');

  assert.deepEqual(args, [
    'im',
    '+messages-reply',
    '--message-id',
    'msg-1',
    '--content',
    JSON.stringify({ text: 'hello' }),
    '--msg-type',
    'text',
    '--as',
    'user',
  ]);
});
