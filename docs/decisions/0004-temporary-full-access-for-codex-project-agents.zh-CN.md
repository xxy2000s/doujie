# ADR-0004：Codex 项目 Agent 暂时默认完整权限

状态：已接受，临时策略
日期：2026-08-02

## 背景

操作者明确选择让豆姐创建和恢复的 Codex 项目 Agent 具备完整本地能力。旧 registry 记录可能保存 `workspace-write`，但当前控制面工作需要网络、SSH、服务检查和跨工作区操作。

## 决策

在操作者明确改变策略前，Codex 项目 Agent 的 create 和 resume 都使用 CLI 支持的 `--dangerously-bypass-approvals-and-sandbox`。Resume 使用 registry 中的 cwd 和原生 Session ID，不向 resume 子命令传递其不支持的 `--sandbox`。

恢复旧 registry 记录时采用当前全局策略，即使历史 launch 元数据记录为 `workspace-write`。

## 后果

- 飞书身份、群规则、管理员角色、结构化确认和安全命令构造成为关键边界；
- Prompt 必须通过 argv 或 stdin 传递，禁止拼接 shell 字符串；
- Agent 具备完整权限不等于所有飞书用户都有权调度 Agent；
- 在开放多人或多租户之前必须重新评估该策略；
- 历史 launch 元数据保留其创建事实，不通过重写伪造当前策略。

## 当前未采用方案

- 默认 `workspace-write`：无法满足当前操作者的控制面场景；
- 每条请求接受任意权限字符串：容易绕过策略，也难以审计。
