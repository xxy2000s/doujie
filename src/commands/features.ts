import type { CommandHandler, MessageContent } from '../types.js';
import type { EffectiveFeatureProjection } from '../runtime-config.js';
import { commandSection, commandTitle, field, joinBlocks } from './format.js';

export function createFeaturesHandler(
  getEffectiveFeatures?: (chatId: string) => EffectiveFeatureProjection
): CommandHandler {
  return async (_args: string, message: MessageContent): Promise<string> => {
    if (!getEffectiveFeatures) {
      return commandTitle('运行时功能', '运行时配置不可用。');
    }
    const features = getEffectiveFeatures(message.chatId);
    return joinBlocks([
      commandTitle('运行时功能', '当前会话范围内的生效值。'),
      commandSection('quoted_message', [
        field('Enabled', features.quotedMessage.enabled ? 'true' : 'false'),
        field('Max chars', features.quotedMessage.maxChars),
        field('Max depth', features.quotedMessage.maxDepth),
        field('Include attachments', features.quotedMessage.includeAttachments ? 'true' : 'false'),
        field('Scope', features.quotedMessage.scope),
      ]),
    ]);
  };
}
