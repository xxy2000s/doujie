import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPostMarkdownContent, buildReplyArgs, formatReply, splitPostMarkdownContent } from '../src/reply.js';
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

test('buildPostMarkdownContent wraps text as Feishu post md content', () => {
  assert.equal(
    buildPostMarkdownContent('**hello**'),
    JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: '**hello**' }]] } })
  );
});

test('splitPostMarkdownContent chunks long markdown by paragraphs', () => {
  const chunks = splitPostMarkdownContent(`## A\n\n${'a'.repeat(700)}\n\n## B\n\n${'b'.repeat(700)}`);

  assert.equal(chunks.length, 2);
  assert.match(chunks[0] ?? '', /^\(1\/2\)/);
  assert.match(chunks[1] ?? '', /^\(2\/2\)/);
});

test('buildReplyArgs sends Feishu post content with configured identity', () => {
  const args = buildReplyArgs('msg-1', 'hello', 'user');

  assert.deepEqual(args, [
    'im',
    '+messages-reply',
    '--message-id',
    'msg-1',
    '--content',
    JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: 'hello' }]] } }),
    '--msg-type',
    'post',
    '--as',
    'user',
  ]);
});
