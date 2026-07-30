import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EditedMessagePoller,
  buildChatMessagesListArgs,
  listMessageToEditedEvent,
  parseChatMessagesListOutput,
  type FeishuListMessage,
} from '../src/edited-message-poller.js';

test('buildChatMessagesListArgs uses chat id paging and identity', () => {
  assert.deepEqual(buildChatMessagesListArgs('oc_1', 12, 'user'), [
    'im',
    '+chat-messages-list',
    '--chat-id',
    'oc_1',
    '--page-size',
    '12',
    '--as',
    'user',
  ]);
});

test('parseChatMessagesListOutput extracts data messages', () => {
  const messages = parseChatMessagesListOutput(JSON.stringify({
    ok: true,
    data: {
      messages: [
        { message_id: 'om_1', content: 'hello', updated: true },
      ],
    },
    _notice: { update: { current: '1', latest: '2' } },
  }));

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.message_id, 'om_1');
});

test('listMessageToEditedEvent converts updated list messages to router events', () => {
  const event = listMessageToEditedEvent({
    message_id: 'om_edit',
    chat_id: 'oc_group',
    chat_type: 'group',
    msg_type: 'text',
    content: '@豆姐 hello',
    sender: { id: 'ou_user', id_type: 'open_id', sender_type: 'user' },
    mentions: [{ id: 'ou_bot', name: '豆姐', key: '@_user_1' }],
    updated: true,
  }, 'oc_fallback');

  assert.equal(event?.header.event_type, 'im.message.message_updated_v1');
  assert.equal(event?.event.message.message_id, 'om_edit');
  assert.equal(event?.event.message.chat_id, 'oc_group');
  assert.equal(event?.event.sender?.sender_id?.open_id, 'ou_user');
  assert.equal(event?.event.message.content, JSON.stringify({ text: '@豆姐 hello' }));
});

test('EditedMessagePoller seeds existing edits then emits only new edited versions', async () => {
  const first: FeishuListMessage = {
    message_id: 'om_old',
    content: '@豆姐 old',
    mentions: [{ id: 'ou_bot', name: '豆姐' }],
    updated: true,
  };
  const second: FeishuListMessage = {
    message_id: 'om_new',
    content: '@豆姐 new',
    mentions: [{ id: 'ou_bot', name: '豆姐' }],
    updated: true,
  };
  const batches = [
    [first],
    [first, second],
    [first, second],
  ];
  const events: string[] = [];
  const poller = new EditedMessagePoller((event) => {
    events.push(event.event.message.message_id);
  }, ['oc_group'], {
    feishuAs: 'user',
    intervalMs: 1000,
    pageSize: 20,
    listMessages: async () => batches.shift() || [],
  });

  await poller.pollOnce();
  await poller.pollOnce();
  await poller.pollOnce();

  assert.deepEqual(events, ['om_new']);
});
