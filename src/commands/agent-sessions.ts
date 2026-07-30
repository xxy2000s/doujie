import {
  AgentSessionRegistryStore,
  DEFAULT_AGENT_SESSION_REGISTRY_PATH,
  formatAgentSessionList,
  formatAgentSessionRecord,
} from '../agent-session-registry.js';
import type { CommandHandler } from '../types.js';

export type AgentSessionCommandRuntime = {
  agentSessionRegistryPath?: string;
};

export function createAgentSessionsHandler(runtime: AgentSessionCommandRuntime = {}): CommandHandler {
  return async (args: string): Promise<string> => {
    const store = new AgentSessionRegistryStore(runtime.agentSessionRegistryPath ?? DEFAULT_AGENT_SESSION_REGISTRY_PATH);
    const alias = args.trim();
    if (alias) {
      const record = store.get(alias);
      return record ? formatAgentSessionRecord(record) : `没有找到 alias 为 \`${alias}\` 的 Agent session。`;
    }
    return ['Agent Sessions', '', formatAgentSessionList(store.list())].join('\n');
  };
}
