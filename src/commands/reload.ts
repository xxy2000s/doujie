import type { CommandHandler } from '../types.js';
import type { ConfigReloadResult } from '../runtime-config.js';
import { bullet, commandSection, commandTitle, joinBlocks } from './format.js';

export function formatReloadResult(result: ConfigReloadResult): string {
  if (!result.ok) {
    return joinBlocks([
      commandTitle('配置重载失败', '当前运行时配置保持不变。'),
      commandSection('结果', [
        bullet(`版本：${result.version}（未变化）`),
        bullet('原因：configuration validation failed'),
      ]),
    ]);
  }

  const restart = result.restartRequired.length > 0
    ? result.restartRequired.map((field) => bullet(field))
    : [bullet('无')];
  return joinBlocks([
    commandTitle('配置重载成功', result.changed ? '新功能配置已应用到后续请求。' : '可热更新的功能配置没有变化。'),
    commandSection('结果', [
      bullet(`版本：${result.previousVersion} → ${result.version}`),
      bullet(`状态：${result.changed ? 'applied' : 'no_change'}`),
    ]),
    commandSection('restart_required', restart),
  ]);
}

export function createReloadHandler(
  reloadConfig?: () => Promise<ConfigReloadResult>
): CommandHandler {
  return async (): Promise<string> => {
    if (!reloadConfig) {
      return formatReloadResult({
        ok: false,
        previousVersion: 0,
        version: 0,
        changed: false,
        restartRequired: [],
        error: 'runtime reload is not configured',
      });
    }
    return formatReloadResult(await reloadConfig());
  };
}
