import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSubscribeArgs, DEFAULT_EVENT_TYPES, redactListenerLog } from '../src/listener.js';

test('buildSubscribeArgs uses configured Feishu identity', () => {
  assert.deepEqual(buildSubscribeArgs('user'), [
    'event',
    '+subscribe',
    '--as',
    'user',
    '--event-types',
    DEFAULT_EVENT_TYPES.join(','),
  ]);
});

test('buildSubscribeArgs accepts explicit event types', () => {
  assert.deepEqual(buildSubscribeArgs('bot', ['im.message.receive_v1']), [
    'event',
    '+subscribe',
    '--as',
    'bot',
    '--event-types',
    'im.message.receive_v1',
  ]);
});

test('redactListenerLog removes sensitive connection query values', () => {
  assert.equal(
    redactListenerLog('connected to wss://example/ws?access_key=abc123&ticket=def456&service_id=1'),
    'connected to wss://example/ws?access_key=[REDACTED]&ticket=[REDACTED]&service_id=1'
  );
});
