# Codex 无头会话不出现在 TUI `/resume` 中

## 现象

豆姐通过 `codex exec` 创建并持续恢复的 Codex Session：

- 原生 JSONL 文件存在；
- 豆姐可以通过 `codex exec resume <session-id> <prompt>` 恢复；
- 在 shell 中按原生 Session ID 可以定位；
- 但在项目目录启动交互式 `codex` 后，TUI 内的 `/resume` 列表可能找不到该会话。

这不是 Session 丢失，也不等同于 `cwd`、文件权限或迁移失败。

## 已验证事实

豆姐创建的无头会话首条 `session_meta` 具有类似字段：

```json
{
  "source": "exec",
  "originator": "codex_exec",
  "thread_source": "user"
}
```

人工启动 Codex TUI 创建的交互式会话通常是：

```json
{
  "source": "cli",
  "originator": "codex-tui",
  "thread_source": "user"
}
```

针对同一个豆姐无头 Session，以下命令已验证可以成功恢复：

```bash
cd <session-cwd>

codex exec resume \
  --json \
  --ignore-user-config \
  --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  <native-session-id> \
  '<prompt>'
```

从原始 `cwd` 和迁移后的新 `cwd` 按 ID 恢复均成功。因此，TUI `/resume` 找不到会话的主要差异是会话来源为 `codex_exec`，而不是文件不存在或恢复命令失效。

## `cwd` 的次要影响

Codex 的会话选择器还可能按当前目录过滤。部署目录迁移后，历史 JSONL 的首条元数据仍保留原始 `cwd`，例如：

```text
/home/doujie/service/doujie
```

而当前服务可能运行在：

```text
/root/service/doujie
```

这会进一步影响默认候选列表，但 `--all` 只解决目录过滤，不保证 `codex_exec` 会话出现在 TUI 内部 `/resume` 的交互式候选中。不要为了改变列表展示而重写历史 JSONL 的首条元数据。

## 当前绕行方式

需要人工接续时，优先使用 registry 或链接取得原生 Session ID，然后退出当前 TUI，在 shell 中执行：

```bash
codex resume <native-session-id>
```

需要继续由豆姐或自动化调度时，使用：

```bash
codex exec resume --json \
  --ignore-user-config \
  --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  <native-session-id> \
  '<prompt>'
```

豆姐应始终从 `~/.doujie/agent-sessions.json`、`~/.doujie/codex-sessions.json` 或控制 Session registry 获取原生 ID，不应以 TUI `/resume` 是否可见判断 Session 是否存在。

## 后续优化方向

1. 增加“人工接管”命令，输出目标 `cwd`、原生 Session ID 和可直接执行的 `codex resume <id>` 命令。
2. 完善自然语言按别名查找、恢复和调度项目 Agent 的路由，避免依赖人工 `/resume` 选择器。
3. 调研 Codex app-server、exec-server 或 PTY 是否能创建可被 TUI 识别的交互式 Session。
4. 验证 `codex resume <id>` 接管无头 Session 后，新产生的会话是否会进入后续 TUI `/resume` 候选；不要在未验证前依赖该行为。
5. 如果引入新的创建机制，必须保持无头流式输出、打断、超时、完整权限策略、registry 持久化和 Feishu 状态展示能力。

## 回归测试建议

后续修复应至少覆盖：

1. 豆姐创建 `codex_exec` Session，并记录原生 ID、JSONL 与 `cwd`。
2. 豆姐按 ID resume 成功。
3. shell 中 `codex resume <id>` 能进入该会话。
4. TUI `/resume` 对 `codex_exec` 与 `codex-tui` Session 的可见性差异有真实 PTY 测试证据。
5. 部署目录迁移后，旧 Session 仍可按 ID 恢复。
6. 不修改、不重写历史 JSONL，仅维护外部 registry 和链接。
