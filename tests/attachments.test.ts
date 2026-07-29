import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAttachmentDownloadArgs, extractAttachments } from '../src/attachments.js';
import type { MessageContent } from '../src/types.js';

function message(messageType: string, rawContent: string): MessageContent {
  return {
    messageId: 'om_attachment',
    chatId: 'chat',
    chatType: 'p2p',
    senderId: 'sender',
    messageType,
    text: `[${messageType}] ${rawContent}`,
    rawContent,
    mentions: [],
  };
}

test('extractAttachments reads image and file message content', () => {
  const image = extractAttachments(message('image', JSON.stringify({ image_key: 'img_1', file_name: 'pic.png', file_size: 10 })));
  const file = extractAttachments(message('file', JSON.stringify({ file_key: 'file_1', file_name: 'doc.pdf', mime_type: 'application/pdf' })));

  assert.deepEqual(image, [{
    resourceKey: 'img_1',
    resourceType: 'image',
    fileName: 'pic.png',
    mime: null,
    size: 10,
  }]);
  assert.deepEqual(file, [{
    resourceKey: 'file_1',
    resourceType: 'file',
    fileName: 'doc.pdf',
    mime: 'application/pdf',
    size: null,
  }]);
});

test('buildAttachmentDownloadArgs uses lark resource download flags', () => {
  const args = buildAttachmentDownloadArgs(
    'om_1',
    { resourceKey: 'file_1', resourceType: 'file', fileName: 'doc.pdf', mime: null, size: null },
    'om_1/file_1-doc.pdf',
    'bot'
  );

  assert.deepEqual(args, [
    'im',
    '+messages-resources-download',
    '--as',
    'bot',
    '--message-id',
    'om_1',
    '--file-key',
    'file_1',
    '--type',
    'file',
    '--output',
    'om_1/file_1-doc.pdf',
  ]);
});
