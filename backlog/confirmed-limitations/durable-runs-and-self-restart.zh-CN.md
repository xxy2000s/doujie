# Durable Run、Daemon 重启恢复与 Guardian

状态：未交付
优先级：P0-P2

## 背景

已发生一次真实故障：项目 Agent 完成开发，但豆姐主控在 daemon 重启后失去等待关系；后续 Codex resume 成为孤儿，任务和状态卡永久停在处理中。

事件证据和处置过程见：

- [`../../docs/incidents/2026-08-01-daemon-restart-orphaned-run.zh-CN.md`](../../docs/incidents/2026-08-01-daemon-restart-orphaned-run.zh-CN.md)

本 Backlog 不代表功能已实现。

## P0：防止再次失联

### 1. 重启前 Drain

- daemon 发现仍有 active turn 时拒绝普通自重启；
- 管理员可以选择等待、取消或强制中断；
- 重启前停止接收新任务，并等待受控时间；
- 给所有受影响飞书消息发送明确状态；
- 超时后按策略终止完整进程组，而不是只终止 Node 父进程。

### 2. 启动时 Reconciliation

- 启动时扫描 `processing/retrying` 任务；
- 根据 PID、启动时间、Session、进程组和心跳判断任务是否仍真实运行；
- 不能恢复的任务自动标记为 `interrupted`；
- 更新遗留状态卡，并向原消息发送一次回执；
- 重复启动必须保持幂等，不能重复通知或重复中断。

### 3. 子进程生命周期

- 每个 Codex turn 记录 PID、进程组、native Session ID、cwd 和启动时间；
- daemon 正常退出时终止或明确移交子进程；
- 打断按进程组执行，覆盖 CLI wrapper 和 native binary；
- 迟到 stdout、stderr、close 事件必须带 generation 校验；
- 定期检测 PPID 1 且属于 Doujie run 的孤儿进程，只报告，不默认批量杀除。

## P1：Durable Run 模型

新增独立于 processing job 的 durable run，至少记录：

```text
run_id
parent_run_id
chat/session key
source_message_id
status_card_message_id
provider
native_session_id
cwd
pid/process_group
generation
requested_by
started_at/heartbeat_at/finished_at
status
result_checkpoint
error_summary
reply_state
```

需要覆盖：

- 主控回合与项目 Agent 调度的父子关系；
- 子 Agent 已完成但主控未回收结果；
- daemon 重启后的继续等待、重新查询或中断；
- 最终回复与状态卡更新的 exactly-once/幂等语义；
- 新消息打断与跨进程 generation 一致性。

## P1：自重启操作

- 自重启必须成为持久化运维任务，不能直接调用 `launchctl kickstart`/`systemctl restart` 后期待旧进程回复；
- 旧进程先发送“重启请求已提交”；
- 独立 helper 延迟执行重启；
- 新进程恢复运维任务，完成健康检查后回复原消息；
- 健康检查至少包含 daemon、单 listener、DB、配置、Session 路径和构建版本；
- 连续失败需要熔断，避免无限重启。

## P2：Guardian

引入独立最小 Guardian：

- 通过权限受限的 Unix Socket 接收结构化动作；
- 只允许 `status/start/stop/restart/health-check/rollback/logs`；
- 不接受 shell 字符串、任意服务名或任意路径；
- 不运行 Codex，不读取聊天内容，不使用业务 Session；
- Linux 适配 systemd，macOS 适配 launchd；
- 未来确有无人值守需求时，再考虑独立运维机器人。

## 数据迁移与兼容

- 现有 `processing_jobs` 保留为消息处理状态；
- durable run 使用新表和显式 migration；
- 升级后首次启动应把旧的 processing 任务安全归类，但不能猜测成功；
- 不修改 Codex 原始 JSONL；
- 不改变现有 chat/session key 和项目 Agent registry 语义。

## 可观测性

- `/status` 区分 active、recovering、interrupted 和 stale；
- 增加 `/runs` 或等价管理员命令查看脱敏运行状态；
- 展示 daemon instance ID、run generation 和最近心跳；
- 日志包含 run ID，不打印 Prompt、Token、完整身份 ID；
- 状态卡在重启、恢复、失败后必须终态化。

## 验收标准

1. 长任务执行期间请求普通重启，系统拒绝或先 drain；
2. 强制重启后，新 daemon 能识别并终态化旧任务；
3. 子 Agent 在重启期间完成，新 daemon 能回收结果并只回复一次；
4. 不可恢复任务被标记 interrupted，状态卡不再永久思考；
5. wrapper 与 native Codex 都被进程组打断，无孤儿残留；
6. 重复飞书事件、重复启动和迟到 close 不产生重复回复；
7. 新消息只打断同 session 仍真实运行的当前 generation；
8. daemon 启动失败时，独立 helper/Guardian 能报告失败；
9. `pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过；
10. 真实飞书 E2E 覆盖自然完成、等待重启、强制重启、跨重启完成、失败恢复和再次正常对话；
11. macOS 单 listener 验证通过，Linux systemd 行为有等价测试；
12. 所有日志、数据库诊断和回复不泄露敏感信息。

## 回归测试矩阵

- daemon 在 Codex 启动前、启动后、输出中、回复前分别退出；
- 子 Agent 先于主控、晚于主控、恰逢重启完成；
- 新 daemon 启动一次和连续启动多次；
- 原进程已经死亡、仍运行、PID 被复用；
- 状态卡创建失败、更新失败、最终回复失败；
- 同 session 新消息与 startup reconciliation 并发；
- 两个不同 chat/session 同时运行，仅一个需要中断；
- launchd/systemd 正常重启、崩溃重启和人工 kill。

## 实施顺序

1. P0：startup reconciliation、陈旧任务终态化、进程组清理；
2. P0：重启前 drain 和自重启门禁；
3. P1：durable run 数据模型和父子调度关系；
4. P1：持久化自重启任务和新进程回执；
5. P2：独立 Guardian；
6. P2：可选独立运维机器人。
