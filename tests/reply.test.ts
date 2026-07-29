import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPostMarkdownContent,
  buildReplyArgs,
  buildStatusCard,
  buildStatusCardPatchArgs,
  buildStatusCardReplyArgs,
  formatReply,
  splitPostMarkdownContent,
} from '../src/reply.js';
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

test('buildStatusCard creates updateable interactive card content', () => {
  const card = buildStatusCard({
    state: 'thinking',
    stage: '启动 Codex session',
    elapsedMs: 3200,
    dots: 2,
  }) as {
    config: { update_multi?: boolean };
    header: { title: { content: string } };
    elements: Array<{ text?: { content?: string } }>;
  };

  assert.equal(card.config.update_multi, true);
  assert.match(card.header.title.content, /思考中\.\./);
  assert.match(card.elements[0]?.text?.content ?? '', /启动 Codex session/);
  assert.match(card.elements[0]?.text?.content ?? '', /3s/);
});

test('status card reply and patch args use interactive and Feishu patch API', () => {
  const params = { state: 'done' as const, stage: '完成', sessionId: 'session-1' };

  const replyArgs = buildStatusCardReplyArgs('msg-1', params, 'bot');
  assert.deepEqual(replyArgs.slice(0, 4), ['im', '+messages-reply', '--message-id', 'msg-1']);
  assert.equal(replyArgs[replyArgs.indexOf('--msg-type') + 1], 'interactive');

  const patchArgs = buildStatusCardPatchArgs('card-1', params, 'bot');
  assert.deepEqual(patchArgs.slice(0, 3), ['api', 'PATCH', '/open-apis/im/v1/messages/card-1']);
  const data = JSON.parse(patchArgs[patchArgs.indexOf('--data') + 1]) as { content: string };
  const card = JSON.parse(data.content) as { config: { update_multi?: boolean } };
  assert.equal(card.config.update_multi, true);
});
