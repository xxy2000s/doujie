import assert from 'node:assert/strict';
import test from 'node:test';
import { formatGroupContextPrompt, parseGroupContextRequest } from '../src/group-context.js';

test('parseGroupContextRequest recognizes bounded natural-language requests', () => {
  assert.deepEqual(parseGroupContextRequest('总结最近 20 条聊天'), { maxMessages: 20 });
  assert.deepEqual(parseGroupContextRequest('结合过去 2 小时的上下文给结论'), { hours: 2 });
  assert.equal(parseGroupContextRequest('普通问题'), null);
});

test('formatGroupContextPrompt orders supplied messages and respects max chars', () => {
  const prompt = formatGroupContextPrompt('总结一下', [
    { messageId: '1', senderName: 'A', senderType: 'user', createdAt: '10:00', text: 'alpha' },
    { messageId: '2', senderName: 'B', senderType: 'user', createdAt: '10:01', text: 'beta' },
  ], 100);
  assert.match(prompt, /A: alpha/);
  assert.match(prompt, /B: beta/);
  assert.match(prompt, /实际读取消息数：2/);
});
