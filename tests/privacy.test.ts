import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateContentPrivacy, evaluateMessagePrivacy, redactForLog } from '../src/privacy.js';
import type { PrivacyConfig } from '../src/types.js';
import { textEvent } from './helpers.js';

const privacyConfig: PrivacyConfig = {
  allowChatIds: [],
  denyChatIds: ['oc_denied'],
  allowUserIds: [],
  denyUserIds: ['ou_denied'],
  skipPatterns: [{ name: 'token', pattern: 'SECRET-[0-9]+' }],
  redactPatterns: [{ name: 'email', pattern: '[^\\s]+@example\\.com', replacement: '[EMAIL]' }],
};

test('evaluateMessagePrivacy skips denylisted chats before content handling', () => {
  const event = textEvent({ messageId: 'privacy-1', chatId: 'oc_denied', text: 'hello' });
  const message = {
    messageId: 'privacy-1',
    chatId: 'oc_denied',
    senderId: 'ou_user',
    messageType: 'text',
    text: 'hello',
    rawContent: '{"text":"hello"}',
  };

  const decision = evaluateMessagePrivacy(message, event, privacyConfig);

  assert.equal(decision.action, 'skip');
  if (decision.action === 'skip') {
    assert.equal(decision.reason, 'privacy_skip:deny_chat');
    assert.doesNotMatch(decision.rawEvent, /hello/);
  }
});

test('evaluateContentPrivacy skips or redacts configured patterns', () => {
  const skipped = evaluateContentPrivacy('contains SECRET-123', privacyConfig);
  const redacted = evaluateContentPrivacy('mail me at user@example.com', privacyConfig);

  assert.equal(skipped.action, 'skip');
  assert.equal(redacted.action, 'redact');
  if (redacted.action === 'redact') {
    assert.equal(redacted.text, 'mail me at [EMAIL]');
  }
});

test('redactForLog removes configured sensitive text', () => {
  assert.equal(redactForLog('failed for user@example.com', privacyConfig), 'failed for [EMAIL]');
});
