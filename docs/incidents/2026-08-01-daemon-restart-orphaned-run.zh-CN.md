# Daemon 重启导致主控任务失联复盘

状态：已恢复，修复项未完成
事件日期：2026-08-01

## 事件摘要

2026-08-01，用户通过豆姐主控会话调度项目 Agent `dou-dev` 开发 M1。项目 Agent 最终完成代码、测试、Review、真实飞书 E2E 和本地提交，但负责等待结果并向用户汇报的豆姐主控回合在开发期间多次重启 daemon 后失联。

随后用户发送“怎么样了”，豆姐启动新的 Codex resume；该回合又遇到 daemon 重启，Codex 子进程脱离父进程成为孤儿，SQLite 任务和飞书状态卡长期停留在处理中。

本次事件的性质是：**执行平面完成，控制平面在重启中丢失**。M1 交付物没有损坏，但用户无法从主控会话得到可靠的最终状态。

## 影响

- 两条飞书请求在 SQLite 中长期保持 `processing/codex_chat`；
- 一张状态卡长期显示“思考中”；
- 一个 `codex exec resume` 进程脱离 daemon，成为 PPID 1 的孤儿进程；
- 用户无法判断任务是仍在运行、已经完成还是已经失败；
- `/status` 的 processing 计数包含跨重启遗留任务；
- 代码开发和项目 Agent Session 本身未丢失。

## 已验证时间线

以下时间只用于事件顺序，不记录真实消息、群或 Session 标识：

1. 20:26：主控收到“调度 dou-dev 开发 M1 并持续管理”的请求；
2. 20:27 至 20:59：主控持续返回调度和 Review 进展；
3. 开发过程中：为验证 runtime、launchd 和真实飞书 E2E，多次重启豆姐 daemon；
4. 21:46：用户发送进度询问，豆姐启动新的 Codex resume 并创建状态卡；
5. 后续 daemon 再次重启，新的 Codex resume 失去父进程和输出接收方；
6. 22:21 至 22:22：M1 代码、Trellis task 归档和交付日志形成提交；
7. 23:36 后：人工诊断确认 listener 正常、孤儿 Codex 存在、两条任务陈旧；
8. 人工完成清理、状态修复和真实飞书恢复验证。

## 交付完成证据

- M1 功能提交已存在；
- Trellis 任务已归档；
- `pnpm typecheck` 通过；
- `pnpm test` 188/188 通过；
- `pnpm build` 通过；
- 真实飞书 E2E 覆盖 `/status`、Codex smoke、引用开启、引用关闭和非文本降级；
- 两轮独立 Review 完成，最终无阻塞项；
- 本地提交尚未因本事件自动推送远程。

上述证据证明项目 Agent 的开发结果完成，不证明主控回合正常完成。两者必须分别判断。

## 根因

### 直接原因

豆姐 daemon 的 active turn、generation、AbortController、子进程输出回调和状态卡 handle 主要存在于进程内存。daemon 重启后，新进程只恢复 Session 映射和持久化数据，不会恢复正在等待的主控任务。

### 架构原因

当前系统已经持久化：

- 飞书消息和 processing job；
- Codex Session 映射；
- 项目 Agent registry；
- Trellis 和 Git 交付物。

但尚未持久化完整的 durable run：

- 主控任务与项目 Agent 调度的父子关系；
- 当前 generation 和运行状态；
- 子进程 PID、进程组和启动时间；
- 状态卡消息 ID 与最终回执目标；
- daemon 重启后的接管/终止策略；
- 已完成 Agent 结果的回收状态。

因此磁盘上的交付可以完成，而飞书控制面无法重新建立等待关系。

### 进程管理原因

LaunchAgent 重启了豆姐 Node 主进程，但没有可靠地终止或接管其全部 Codex 后代进程。失去父进程的 `codex exec resume` 仍可继续存在，其 stdout/stderr 管道已经没有有效消费者。

项目 Agent 能完成，是因为代码、Trellis task、Git 和 native Session 属于独立持久化执行上下文，不依赖豆姐主控进程的内存；部分外部 Agent/测试进程也可能跨 daemon 重启继续执行。该行为不能作为可靠机制依赖。

## 触发条件

同时满足以下条件时容易复现：

1. 飞书主控回合正在等待 Codex 或项目 Agent；
2. 任务内部构建并重启豆姐自身 daemon；
3. daemon 没有先 drain 当前任务；
4. 子进程没有统一进程组和退出策略；
5. 新 daemon 没有 startup reconciliation；
6. 用户继续向同一主控 Session 发送新消息。

## 已排除因素

- 飞书 listener 并未永久离线，恢复探针可以正常收发；
- reaction 未注册 handler 的日志噪声不是本次卡住的直接原因；
- edit poller 的短暂 EOF 不是主控任务失联的根因；
- Codex Session 没有损坏，清理后可按原 Session 继续 resume；
- M1 代码和 Git 提交没有因 daemon 重启丢失。

## 人工处置

1. 检查 launchd、listener、Codex 进程和 SQLite processing jobs；
2. 读取主控群最近消息，重建事件顺序；
3. 对运行数据执行备份；
4. 终止唯一可确认失联的孤儿 Codex 进程及其子进程；
5. 将两条陈旧任务标记为 `failed/interrupted`；
6. 把历史状态卡更新为“daemon 重启导致任务失联”；
7. 在原消息下发送恢复说明；
8. 真实验证 `/status` 和普通 Codex resume；
9. 确认无 processing 任务、无孤儿 Codex、单 listener 正常。

## 当前安全操作规则

在 durable run 和 Guardian 完成前：

- 不允许运行中的豆姐主控任务直接重启自身 daemon；
- runtime 开发需要重启时，先向用户/主控报告检查点并结束当前回合；
- 重启由独立运维步骤执行，重启后发起新的验证回合；
- 不把“子 Agent 仍在运行”当作主控一定能回收结果；
- `/status` 发现长期 processing 时必须同时核对进程、日志和消息历史；
- 清理孤儿前必须确认 PID、父进程、cwd、Session 和持续时间，禁止按命令名批量杀进程。

## 后续工作

具体功能拆解、优先级和验收标准见：

- [`../../backlog/confirmed-limitations/durable-runs-and-self-restart.zh-CN.md`](../../backlog/confirmed-limitations/durable-runs-and-self-restart.zh-CN.md)
