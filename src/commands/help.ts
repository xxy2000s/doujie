import type { CommandDefinition, CommandHandler, MessageContent } from '../types.js';
import { bullet, commandSection, commandTitle, joinBlocks } from './format.js';

const DEFAULT_BEHAVIOR =
  '私聊和群聊 @豆姐 默认进入 Codex 会话；/detail 会显示详细事件；/digest 用于记忆摘要和分类。';

const COMMAND_GROUPS: Array<{ title: string; names: string[] }> = [
  { title: '会话控制', names: ['new', 'codex', 'detail', 'output', 'agent-sessions'] },
  { title: '记忆检索', names: ['ask', 'search', 'recent'] },
  { title: '消息整理', names: ['save', 'digest', 'skip', 'redo', 'retag', 'merge-tag'] },
  { title: '运行状态', names: ['status', 'features', 'reload', 'session', 'sessions', 'errors'] },
  { title: '数据维护', names: ['backup', 'export', 'cleanup'] },
];

export function formatHelp(definitions: CommandDefinition[]): string {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const grouped = new Set<string>();
  const sections = COMMAND_GROUPS.map((group) => {
    const lines = group.names.flatMap((name) => {
      const definition = byName.get(name);
      if (!definition) return [];
      grouped.add(name);
      return [bullet(`\`/${definition.usage}\` - ${definition.description}`)];
    });
    return commandSection(group.title, lines);
  });
  const other = definitions
    .filter((definition) => !grouped.has(definition.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((definition) => bullet(`\`/${definition.usage}\` - ${definition.description}`));

  return joinBlocks([
    commandTitle('豆姐命令', DEFAULT_BEHAVIOR),
    commandSection('基础', other),
    ...sections,
  ]);
}

export function createHelpHandler(definitions: CommandDefinition[]): CommandHandler {
  return async (_args: string, _message: MessageContent): Promise<string> => {
    return formatHelp(definitions);
  };
}
