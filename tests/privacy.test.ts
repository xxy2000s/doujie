import assert from 'node:assert/strict';
import test from 'node:test';
import { canRunAgent, evaluateContentPrivacy, evaluateMessagePrivacy, isPrivacyAdmin, redactForLog } from '../src/privacy.js';
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

test('scoped privacy rules separate private users, group members, agents, and admins', () => {
  const config: PrivacyConfig = {
    ...privacyConfig,
    adminUserIds: ['ou_admin'],
    privateAllowUserIds: ['ou_admin'],
    groups: [{
      chatId: 'oc_team',
      allowUserIds: ['ou_admin', 'ou_member'],
      allowAgentUserIds: ['ou_admin'],
      contextEnabled: true,
      contextMaxMessages: 50,
      contextMaxChars: 30000,
    }],
  };
  const groupEvent = textEvent({ messageId: 'group-member', chatId: 'oc_team', chatType: 'group', senderId: 'ou_member', text: 'hello' });
  const groupMessage = { messageId: 'group-member', chatId: 'oc_team', chatType: 'group', senderId: 'ou_member', messageType: 'text', text: 'hello', rawContent: '{"text":"hello"}', mentions: [] };
  const privateEvent = textEvent({ messageId: 'private-member', senderId: 'ou_member', text: 'hello' });
  const privateMessage = { ...groupMessage, messageId: 'private-member', chatId: 'oc_test', chatType: 'p2p' };

  assert.equal(evaluateMessagePrivacy(groupMessage, groupEvent, config).action, 'allow');
  assert.equal(evaluateMessagePrivacy(privateMessage, privateEvent, config).action, 'skip');
  assert.equal(canRunAgent(groupMessage, config), false);
  const fallbackEvent = textEvent({ messageId: 'fallback', chatId: 'oc_other', chatType: 'group', senderId: 'ou_member', text: 'hello' });
  const fallbackMessage = { ...groupMessage, messageId: 'fallback', chatId: 'oc_other' };
  assert.equal(evaluateMessagePrivacy(fallbackMessage, fallbackEvent, config).action, 'allow');
  assert.equal(isPrivacyAdmin('ou_admin', config), true);
  assert.equal(isPrivacyAdmin('ou_member', config), false);
});
