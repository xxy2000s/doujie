# Documentation

Stable documentation is grouped by purpose. Read [Documentation lifecycle](./documentation-lifecycle.md) ([中文](./documentation-lifecycle.zh-CN.md)) before adding a new document or duplicating a Trellis task specification.

## Architecture

- [Architecture overview](./architecture/overview.md): system boundaries, runtime components, and ownership.

## Decisions

- [ADR-0001](./decisions/0001-doujie-is-the-agent-control-plane.md) ([中文](./decisions/0001-doujie-is-the-agent-control-plane.zh-CN.md)): Doujie is the digital employee and Agent control plane.
- [ADR-0002](./decisions/0002-separate-control-and-project-agent-sessions.md) ([中文](./decisions/0002-separate-control-and-project-agent-sessions.zh-CN.md)): control Sessions and project Agent Sessions remain separate.
- [ADR-0003](./decisions/0003-master-and-release-branch-roles.md) ([中文](./decisions/0003-master-and-release-branch-roles.zh-CN.md)): `master` is the development line and `release` is the deployment pointer.
- [ADR-0004](./decisions/0004-temporary-full-access-for-codex-project-agents.md) ([中文](./decisions/0004-temporary-full-access-for-codex-project-agents.zh-CN.md)): Codex project Agents temporarily default to full access.

## Deployment

- [Remote Linux deployment](./deployment/remote-linux.md): brand-new deployment for a new Feishu account and Linux server.
- [远程 Linux 部署](./deployment/remote-linux.zh-CN.md)：全新飞书账号和远程 Linux 服务器部署指南。
- [远程部署实战复盘](./deployment/remote-linux-field-report.zh-CN.md)：真实 E2E 过程、踩坑点和用户配合清单。

## Operations

- [Operations runbook](./operations/runbook.md): service, configuration, Session, recovery, and E2E procedures.

## Incidents

- [2026-08-01 Daemon 重启导致主控任务失联](./incidents/2026-08-01-daemon-restart-orphaned-run.zh-CN.md)：项目 Agent 完成但主控回合跨重启失联的证据、根因和处置。
- [2026-08-02 UTF-8 分块解码导致旧消息伪更新](./incidents/2026-08-02-utf8-chunk-decoding-replayed-old-message.zh-CN.md)：poller 损坏多字节字符后把旧消息误判为新 generation，并抢占当前回合。

## Security

- [Trust boundaries](./security/trust-boundaries.md) ([中文](./security/trust-boundaries.zh-CN.md)): Feishu authority, full-access Agents, data handling, network exposure, and deployment boundaries.

## AI Governance

- [AI 维护软件的完整生命周期](./ai-governance/ai-maintained-software-lifecycle.zh-CN.md)：产品、设计、实现、验证、发布、运行、事故、维护和退役的全景框架及豆姐当前缺口。

Unresolved investigations and planned improvements belong in [`../backlog/confirmed-limitations/`](../backlog/README.md), not in stable documentation. Iteration-specific requirements and verification belong in `.trellis/tasks/`.
