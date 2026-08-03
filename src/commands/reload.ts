import type { CommandHandler } from '../types.js';
import type { ConfigReloadResult } from '../runtime-config.js';
import { bullet, commandSection, commandTitle, joinBlocks } from './format.js';

export function formatReloadResult(result: ConfigReloadResult): string {
  if (!result.ok) {
    const reconciliationFailed = result.error === 'component reconciliation failed';
    const changedFields = (result.changedFields ?? []).map((value) => bullet(value));
    const restartRequired = result.restartRequired.map((value) => bullet(value));
    return joinBlocks([
      commandTitle(
        reconciliationFailed ? '配置已应用，组件协调失败' : '配置重载失败',
        reconciliationFailed ? '新配置已生效，失败组件将在后续重载时重试。' : '当前运行时配置保持不变。'
      ),
      commandSection('结果', [
        bullet(reconciliationFailed
          ? `版本：${result.previousVersion} → ${result.version}`
          : `版本：${result.version}（未变化）`),
        bullet(`原因：${reconciliationFailed ? 'component reconciliation failed' : 'configuration validation failed'}`),
        ...(reconciliationFailed ? [bullet('lifecycle_actions：poller:error')] : []),
      ]),
      ...(reconciliationFailed ? [
        commandSection('changed_fields', changedFields.length > 0 ? changedFields : [bullet('无')]),
        commandSection('restart_required', restartRequired.length > 0 ? restartRequired : [bullet('无')]),
      ] : []),
    ]);
  }

  const restart = result.restartRequired.length > 0
    ? result.restartRequired.map((field) => bullet(field))
    : [bullet('无')];
  const changedFieldValues = result.changedFields ?? [];
  const lifecycleActionValues = result.lifecycleActions ?? [];
  const changedFields = changedFieldValues.length > 0
    ? changedFieldValues.map((field) => bullet(field))
    : [bullet('无')];
  const lifecycleActions = lifecycleActionValues.length > 0
    ? lifecycleActionValues.map((action) => bullet(action))
    : [bullet('无')];
  return joinBlocks([
    commandTitle('配置重载成功', result.changed ? '新功能配置已应用到后续请求。' : '可热更新的功能配置没有变化。'),
    commandSection('结果', [
      bullet(`版本：${result.previousVersion} → ${result.version}`),
      bullet(`状态：${result.changed ? 'applied' : 'no_change'}`),
    ]),
    commandSection('changed_fields', changedFields),
    commandSection('lifecycle_actions', lifecycleActions),
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
        changedFields: [],
        restartRequired: [],
        lifecycleActions: [],
        error: 'runtime reload is not configured',
      });
    }
    return formatReloadResult(await reloadConfig());
  };
}
