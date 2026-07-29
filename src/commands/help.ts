import type { CommandDefinition, CommandHandler, MessageContent } from '../types.js';

const DEFAULT_BEHAVIOR =
  'Default behavior: private messages and mentioned group messages are routed to Codex chat. Use /detail for verbose Codex events; use /digest when you want memory summarization/classification.';

export function formatHelp(definitions: CommandDefinition[]): string {
  const lines = definitions
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((definition) => `/${definition.usage} - ${definition.description}`);
  return `Available commands:\n\n${lines.join('\n')}\n\n${DEFAULT_BEHAVIOR}`;
}

export function createHelpHandler(definitions: CommandDefinition[]): CommandHandler {
  return async (_args: string, _message: MessageContent): Promise<string> => {
    return formatHelp(definitions);
  };
}
