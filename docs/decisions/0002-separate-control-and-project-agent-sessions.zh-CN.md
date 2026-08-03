# ADR-0002：控制 Session 与项目 Agent Session 分离

状态：已接受
日期：2026-08-02

## 背景

豆姐既需要保持飞书对话连续性，也需要创建和恢复命名的 Codex/Claude 工作 Agent。这两类身份的所有权和查找条件不同，仅靠飞书 chat 绑定不足以安全恢复项目 Agent。

## 决策

分别维护：

- `~/.doujie/codex-sessions.json`：飞书到 Codex 的控制会话绑定；
- `~/.doujie/sessions/`：面向操作者的控制 Session 元数据和 JSONL 链接；
- `~/.doujie/agent-sessions.json`：命名的项目 Agent registry。

项目 Agent 至少使用 `alias + provider + nativeSessionId + cwd` 作为恢复身份。别名本身和 TUI `/resume` 是否可见都不是权威依据。

## 后果

- `/new` 只改变当前飞书控制会话绑定；
- 创建或恢复项目 Agent 不会暗中替换豆姐自己的 chat Session；
- Session discovery 可以提供候选，但晋升到可信 registry 前必须具备完整元数据并经过确认；
- Codex 和 Claude 原始 transcript 仍由 provider 管理，豆姐不重写。

## 未采用方案

- 为所有 transcript 建一个可信 registry：难以保证可信，增量维护成本高；
- 根据 alias 或当前群推断 cwd：存在歧义且不安全；
- 把交互式 TUI 列表作为事实来源：无头 Session 可能不会出现在其中。
