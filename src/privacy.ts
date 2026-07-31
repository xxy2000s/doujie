import type { FeishuEvent, MessageContent, PrivacyConfig, PrivacyPattern } from './types.js';

export type PrivacyDecision =
  | {
      action: 'allow';
      text: string;
      rawContent: string;
      rawEvent: string;
      matchedRules: string[];
    }
  | {
      action: 'redact';
      text: string;
      rawContent: string;
      rawEvent: string;
      matchedRules: string[];
    }
  | {
      action: 'skip';
      safeText: string;
      rawEvent: string;
      reason: string;
      matchedRules: string[];
    };

export type ContentPrivacyDecision =
  | { action: 'allow'; text: string; matchedRules: string[] }
  | { action: 'redact'; text: string; matchedRules: string[] }
  | { action: 'skip'; safeText: string; reason: string; matchedRules: string[] };

export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  allowChatIds: [],
  denyChatIds: [],
  allowUserIds: [],
  denyUserIds: [],
  adminUserIds: [],
  privateAllowUserIds: null,
  groups: [],
  skipPatterns: [],
  redactPatterns: [],
};

export function evaluateMessagePrivacy(
  message: MessageContent,
  event: FeishuEvent,
  config: PrivacyConfig = DEFAULT_PRIVACY_CONFIG
): PrivacyDecision {
  const identitySkip = evaluateIdentityRules(message, config);
  if (identitySkip) {
    return {
      action: 'skip',
      safeText: privacyPlaceholder(identitySkip),
      rawEvent: privacyRawEvent(message, identitySkip),
      reason: identitySkip,
      matchedRules: [identitySkip],
    };
  }

  const contentDecision = evaluateContentPrivacy(message.text, config);
  if (contentDecision.action === 'skip') {
    return {
      action: 'skip',
      safeText: contentDecision.safeText,
      rawEvent: privacyRawEvent(message, contentDecision.reason),
      reason: contentDecision.reason,
      matchedRules: contentDecision.matchedRules,
    };
  }

  if (contentDecision.action === 'redact') {
    return {
      action: 'redact',
      text: contentDecision.text,
      rawContent: redactRawContent(message, contentDecision.text),
      rawEvent: redactEvent(event, contentDecision.text),
      matchedRules: contentDecision.matchedRules,
    };
  }

  return {
    action: 'allow',
    text: message.text,
    rawContent: message.rawContent,
    rawEvent: JSON.stringify(event),
    matchedRules: [],
  };
}

export function evaluateContentPrivacy(
  text: string,
  config: PrivacyConfig = DEFAULT_PRIVACY_CONFIG
): ContentPrivacyDecision {
  for (const rule of config.skipPatterns) {
    if (compilePattern(rule).test(text)) {
      const reason = `privacy_skip:${rule.name}`;
      return {
        action: 'skip',
        safeText: privacyPlaceholder(reason),
        reason,
        matchedRules: [rule.name],
      };
    }
  }

  const redactResult = redactText(text, config.redactPatterns);
  if (redactResult.matchedRules.length > 0) {
    return {
      action: 'redact',
      text: redactResult.text,
      matchedRules: redactResult.matchedRules,
    };
  }

  return { action: 'allow', text, matchedRules: [] };
}

export function redactForLog(text: string, config: PrivacyConfig = DEFAULT_PRIVACY_CONFIG): string {
  return redactText(text, config.redactPatterns).text;
}

function evaluateIdentityRules(message: MessageContent, config: PrivacyConfig): string | null {
  if (config.denyChatIds.includes(message.chatId)) {
    return 'privacy_skip:deny_chat';
  }
  if (config.denyUserIds.includes(message.senderId)) {
    return 'privacy_skip:deny_user';
  }
  if (message.chatType !== 'group' && config.privateAllowUserIds !== undefined && config.privateAllowUserIds !== null) {
    return config.privateAllowUserIds.includes(message.senderId) ? null : 'privacy_skip:private_user_miss';
  }
  if (message.chatType === 'group' && (config.groups?.length ?? 0) > 0) {
    const group = config.groups?.find((rule) => rule.chatId === message.chatId);
    if (group) return group.allowUserIds.includes(message.senderId) ? null : 'privacy_skip:group_user_miss';
  }
  if (config.allowChatIds.length > 0 && !config.allowChatIds.includes(message.chatId)) {
    return 'privacy_skip:allow_chat_miss';
  }
  if (config.allowUserIds.length > 0 && !config.allowUserIds.includes(message.senderId)) {
    return 'privacy_skip:allow_user_miss';
  }
  return null;
}

export function isPrivacyAdmin(senderId: string, config: PrivacyConfig): boolean {
  const roleRulesEnabled = (config.adminUserIds?.length ?? 0) > 0 || (config.groups?.length ?? 0) > 0 || config.privateAllowUserIds != null;
  return roleRulesEnabled ? (config.adminUserIds?.includes(senderId) ?? false) : true;
}

export function findPrivacyGroupRule(chatId: string, config: PrivacyConfig) {
  return config.groups?.find((rule) => rule.chatId === chatId) ?? null;
}

export function canRunAgent(message: MessageContent, config: PrivacyConfig): boolean {
  if (isPrivacyAdmin(message.senderId, config)) return true;
  if (message.chatType !== 'group') return config.privateAllowUserIds?.includes(message.senderId) ?? true;
  const group = findPrivacyGroupRule(message.chatId, config);
  return group ? (group.allowAgentUserIds?.includes(message.senderId) ?? false) : true;
}

function redactText(text: string, patterns: PrivacyPattern[]): { text: string; matchedRules: string[] } {
  let redacted = text;
  const matchedRules: string[] = [];
  for (const rule of patterns) {
    const pattern = compilePattern(rule);
    if (!pattern.test(redacted)) continue;
    matchedRules.push(rule.name);
    redacted = redacted.replace(pattern, rule.replacement ?? '[REDACTED]');
  }
  return { text: redacted, matchedRules };
}

function compilePattern(rule: PrivacyPattern): RegExp {
  return new RegExp(rule.pattern, 'gu');
}

function privacyPlaceholder(reason: string): string {
  return `[privacy skipped: ${reason}]`;
}

function privacyRawEvent(message: MessageContent, reason: string): string {
  return JSON.stringify({
    privacy: 'skipped',
    reason,
    messageId: message.messageId,
    chatId: message.chatId,
    senderId: message.senderId,
    messageType: message.messageType,
  });
}

function redactRawContent(message: MessageContent, redactedText: string): string {
  if (message.messageType === 'text') {
    return JSON.stringify({ text: redactedText });
  }
  return redactedText;
}

function redactEvent(event: FeishuEvent, redactedText: string): string {
  const sanitized: FeishuEvent = JSON.parse(JSON.stringify(event)) as FeishuEvent;
  sanitized.event.message.content = JSON.stringify({ text: redactedText });
  return JSON.stringify(sanitized);
}
