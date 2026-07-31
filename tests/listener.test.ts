import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSubscribeArgs,
  DEFAULT_EVENT_TYPES,
  redactListenerLog,
  shouldAcceptChatEvent,
} from '../src/listener.js';
import type { FeishuEvent } from '../src/types.js';

function messageEvent(chatType: 'group' | 'p2p', chatId: string): FeishuEvent {
  return {
    schema: '2.0',
    header: { event_id: `event-${chatId}`, event_type: 'im.message.receive_v1', create_time: '1' },
    event: {
      message: {
        message_id: `message-${chatId}`,
        chat_id: chatId,
        chat_type: chatType,
        message_type: 'text',
        content: '{"text":"hello"}',
      },
    },
  };
}

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

test('chat allowlist filters groups without dropping private messages', () => {
  const allowed = ['oc_allowed_group'];

  assert.equal(shouldAcceptChatEvent(messageEvent('group', 'oc_allowed_group'), allowed), true);
  assert.equal(shouldAcceptChatEvent(messageEvent('group', 'oc_other_group'), allowed), false);
  assert.equal(shouldAcceptChatEvent(messageEvent('p2p', 'oc_private_chat'), allowed), true);
});
