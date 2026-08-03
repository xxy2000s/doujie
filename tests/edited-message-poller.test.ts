import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EditedMessagePoller,
  buildChatMessagesListArgs,
  listMessageToEditedEvent,
  parseChatMessagesListOutput,
  Utf8Accumulator,
  type FeishuListMessage,
} from '../src/edited-message-poller.js';

test('Utf8Accumulator preserves multi-byte code points across every byte boundary', () => {
  const input = JSON.stringify({ text: 'A¢中😊𠮷Z' });
  const bytes = Buffer.from(input, 'utf8');

  for (let boundary = 1; boundary < bytes.length; boundary += 1) {
    const accumulator = new Utf8Accumulator();
    accumulator.append(bytes.subarray(0, boundary));
    accumulator.append(bytes.subarray(boundary));
    const decoded = accumulator.finish();
    assert.equal(decoded, input, `boundary ${boundary}`);
    assert.doesNotMatch(decoded, /�/, `boundary ${boundary}`);
  }
});

test('Utf8Accumulator flushes an incomplete trailing sequence deterministically', () => {
  const accumulator = new Utf8Accumulator();
  accumulator.append(Buffer.from([0xe4, 0xb8]));
  assert.equal(accumulator.finish(), '�');
});

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
    parent_id: 'om_parent',
    reply_to: 'om_reply_fallback',
    root_id: 'om_root',
    updated: true,
  }, 'oc_fallback');

  assert.equal(event?.header.event_type, 'im.message.message_updated_v1');
  assert.equal(event?.event.message.message_id, 'om_edit');
  assert.equal(event?.event.message.chat_id, 'oc_group');
  assert.equal(event?.event.sender?.sender_id?.open_id, 'ou_user');
  assert.equal(event?.event.message.content, JSON.stringify({ text: '@豆姐 hello' }));
  assert.equal(event?.event.message.parent_id, 'om_parent');
  assert.equal(event?.event.message.reply_to, 'om_reply_fallback');
  assert.equal(event?.event.message.root_id, 'om_root');
});

test('listMessageToEditedEvent normalizes the live reply_to shape as direct parent', () => {
  const event = listMessageToEditedEvent({
    message_id: 'om_reply_message',
    chat_id: 'oc_group',
    chat_type: 'group',
    msg_type: 'text',
    content: '@豆姐 reply',
    reply_to: 'om_direct_parent',
    updated: true,
  }, 'oc_fallback');

  assert.equal(event?.event.message.reply_to, 'om_direct_parent');
  assert.equal(event?.event.message.parent_id, 'om_direct_parent');
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

test('EditedMessagePoller emits a new generation when reply relationships change', async () => {
  const first: FeishuListMessage = {
    message_id: 'om_reply',
    content: '@豆姐 same text',
    reply_to: 'om_parent_1',
    updated: true,
  };
  const second: FeishuListMessage = {
    ...first,
    reply_to: 'om_parent_2',
  };
  const batches = [[first], [second], [second]];
  const parents: Array<string | undefined> = [];
  const poller = new EditedMessagePoller((event) => {
    parents.push(event.event.message.parent_id);
  }, ['oc_group'], {
    feishuAs: 'user',
    intervalMs: 1000,
    pageSize: 20,
    skipExistingOnStart: false,
    listMessages: async () => batches.shift() || [],
  });

  await poller.pollOnce();
  await poller.pollOnce();
  await poller.pollOnce();

  assert.deepEqual(parents, ['om_parent_1', 'om_parent_2']);
});

test('EditedMessagePoller hashes text and known parent changes even when update_time is unchanged', async () => {
  const first: FeishuListMessage = {
    message_id: 'om_same_update',
    content: '@豆姐 first',
    reply_to: 'om_parent_1',
    update_time: '1783530002000',
    updated: true,
  };
  const second: FeishuListMessage = { ...first, content: '@豆姐 second' };
  const third: FeishuListMessage = { ...second, reply_to: 'om_parent_2' };
  const batches = [[first], [second], [third], [third]];
  const observed: Array<{ content: string; parent?: string }> = [];
  const poller = new EditedMessagePoller((event) => {
    observed.push({
      content: event.event.message.content,
      parent: event.event.message.parent_id,
    });
  }, ['oc_group'], {
    feishuAs: 'user',
    intervalMs: 1000,
    pageSize: 20,
    skipExistingOnStart: false,
    listMessages: async () => batches.shift() || [],
  });

  await poller.pollOnce();
  await poller.pollOnce();
  await poller.pollOnce();
  await poller.pollOnce();

  assert.deepEqual(observed, [
    { content: JSON.stringify({ text: '@豆姐 first' }), parent: 'om_parent_1' },
    { content: JSON.stringify({ text: '@豆姐 second' }), parent: 'om_parent_1' },
    { content: JSON.stringify({ text: '@豆姐 second' }), parent: 'om_parent_2' },
  ]);
});
