# Backlog

This directory indexes confirmed limitations and planned improvements that are not yet delivered. Item files live under `confirmed-limitations/`.

Each item should stay problem-focused and include:

- the observed behavior and reproduction conditions;
- verified evidence separated from assumptions;
- the current workaround;
- implementation boundaries and acceptance criteria;
- a link to the incident or evidence that confirmed it;
- a link to the active Trellis task once implementation starts.

Detailed design, execution plans, Review, and E2E evidence belong in the active `.trellis/tasks/` directory, not in a second backlog specification. When behavior is implemented and stable, update the appropriate `docs/` category and resolve or reduce the backlog item. Do not use backlog files as proof that a feature already exists.

## Open Items

- [Codex 无头会话不出现在 TUI `/resume` 中](./confirmed-limitations/codex-headless-tui-resume.zh-CN.md)：调研无头 Session 的人工 TUI 接管与自然语言按别名恢复能力。
- [Durable Run、Daemon 重启恢复与 Guardian](./confirmed-limitations/durable-runs-and-self-restart.zh-CN.md)：解决跨重启任务失联、孤儿 Codex、状态卡不终态和豆姐无法可靠自管理的问题。
- [无损 CLI 解码与旧消息伪更新抢占防护](./confirmed-limitations/lossless-cli-decoding-and-stale-edit-preemption.zh-CN.md)：修复 UTF-8 跨 chunk 解码，并阻止较旧 generation 抢占更新消息的 active turn。
