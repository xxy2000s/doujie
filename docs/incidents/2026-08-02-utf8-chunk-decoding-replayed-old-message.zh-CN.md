# UTF-8 分块解码导致旧消息伪更新并抢占当前回合复盘

状态：影响已结束，代码缺陷未修复
事件日期：2026-08-02

## 事件摘要

用户只发送了一条当前消息 A，但豆姐界面显示该回合被打断。只读诊断确认：更早的用户消息 B 被编辑消息轮询器再次拉取时，一个中文字符因子进程 stdout 的 UTF-8 字节跨 Buffer 分块而被错误解码成替换字符。正文 hash 随之变化，B 被误判为新的内容 generation，再次进入同一控制 Session，并按“同 Session 新消息”规则中断了正在运行的 A。

本次事件不是状态卡单独误报。A 的 Codex turn 确实收到了中断；触发者是内容已损坏的旧消息 B。

本文只使用 A/B 和短描述，不保存真实 chat、message、user、Session 标识、完整正文或 raw event。

## 影响

- 当前消息 A 的 Codex turn 被非预期中断；
- 用户看到“当前回合被打断”，但没有主动发送第二条消息或编辑旧消息；
- 旧消息 B 被重复提交给同一控制 Session；
- SQLite 中 B 的最新正文和 raw event 被 poller 版本覆盖，历史 receive raw event 无法再直接读取；
- 没有发现凭证泄漏、跨 chat 影响、daemon 退出或 Session 损坏。

## 已验证时间线

以下均为本地时间，精确标识已省略：

1. 01:43:45：receive 首次保存并处理旧消息 B；
2. 01:44:05：B 的原始规范化正文进入 Codex 控制会话；
3. 01:44:10：poller 拉到 B，但内容 generation 未变，router 正确跳过；
4. 01:48:27：当前消息 A 由 poller 首先捕获，稍后的 receive 被判为重复；
5. 01:48:33：A 的 Codex turn 开始运行；
6. 01:48:42：poller 再次拉取 B；飞书 `update_time` 仍停留在 01:43，但一个中文字符已被解码成三个替换字符；
7. B 的规范化正文长度从 62 变为 64，content generation hash 改变；
8. router 将 B 当成新输入启动 Codex turn，并中断同 Session 中的 A；
9. 01:48:50：损坏后的 B 再次出现在 Codex 控制会话记录中。

## 证据链

### 已确认事实

- SQLite、日志和控制 Session 记录指向同一顺序：处理 A、重新处理 B、中断 A；
- A 与 B 是同一位用户在同一控制 Session 中发送的两条不同消息，B 早于 A；
- B 的两个正文 generation 只在一个中文字符处不同：原字符在 poller 版本中变成三个 Unicode 替换字符；
- B 两代的消息类型相同，均通过机器人 mention 门控，且都没有 parent/root 关系；
- B 的平台 `update_time` 在第二次处理时没有前进；
- `src/edited-message-poller.ts` 对每个 stdout Buffer 分块分别调用 UTF-8 解码，再拼接字符串；
- Node.js pipe 的 Buffer 边界不保证与 UTF-8 码点边界一致；
- router 的 content generation 包含规范化正文，因此替换字符会产生不同 hash；
- 启动新 Codex turn 时，router 会中断同 Session 中仍 active 的旧 turn；
- 事故附近存在网络 EOF/reconnect，但没有 daemon 退出或 retry job 触发。

### 高置信度推断

- 旧消息 B 的伪更新由 stdout 分块恰好切开多字节中文字符触发。该推断同时解释了唯一字符差异、替换字符数量、长度变化和代码中的逐块解码方式；
- 网络异常可能改变 receive 与 poller 的到达先后，使 A 先由 poller 捕获，但不能把一个有效中文字符直接变成替换字符；
- A 的“被打断”状态是实际 Abort/interrupt 的后果，流式状态卡和重试机制不是触发源。

### 仍未知

- 原始 receive raw event 已被最新 poller raw event 覆盖，无法再恢复 B 的全部原始字段；
- 当前受限诊断环境无法访问 lark-cli 用户 keychain，因此未能从飞书只读 API 重新取得平台秒级 `create_time`；
- 飞书为什么在消息初始阶段将 A/B 标为 `updated=true` 尚未确定；这不影响“01:48 的 B 不是一次新的真实编辑”这一判断；
- 本次具体 stdout Buffer 的字节切分位置未被日志记录，根因由字符级差异和解码实现交叉确定，而不是由原始 chunk 观测直接证明。

## 根因

### 直接原因：有状态编码被无状态分块解码

poller 启动 lark-cli 后，在每次 stdout `data` 回调中把当前 Buffer 独立转换成 UTF-8 字符串。多字节字符跨 chunk 时，两侧残缺字节会分别成为 Unicode 替换字符。后续 JSON 仍然是合法 JSON，因此解析不会报错，损坏内容继续进入版本计算和路由。

### 放大原因：旧消息的新 hash 可以抢占更新的 turn

content generation 防线只能判断“内容是否相同”，不能判断“这条较旧消息是否有资格抢占一条更新消息的 active turn”。一旦解码损坏制造出新 hash，旧消息 B 就沿正常新输入路径启动 turn，并触发同 Session 打断规则。

## 触发条件

事故需要同时满足：

1. edit poller 拉取一条带多字节 UTF-8 字符的历史消息；
2. lark-cli stdout 的 chunk 边界落在该字符字节序列中间；
3. 分块分别解码后，整体 JSON 仍可解析；
4. 损坏发生在影响规范化正文的字段；
5. 新 content hash 尚未被记录；
6. 同 Session 中存在一条更新消息的 active Codex turn。

Buffer 切分具有时序和数据量相关性，因此该故障可能低频、难以通过相同人工步骤稳定复现。

## 为什么现有防线未阻止

- poller version key 正确组合了更新时间与内容 hash，但无法区分真实内容变化和上游解码损坏；
- unchanged generation 防线曾在 01:44 正确跳过 B，但 01:48 的损坏正文确实产生了不同 hash；
- receive/message ID 去重只能阻止同一事件表示的重复，不能阻止同一消息的新 content generation；
- active-turn generation guard 能防止旧 close 覆盖新 turn，不能阻止旧消息先启动一个新 turn；
- UTF-8 分块边界未纳入 poller 测试；现有测试使用完整字符串，不会模拟多字节字符跨 chunk；
- 日志没有记录脱敏的正文 digest、长度、替换字符计数或事件时间关系，诊断依赖 SQLite 与控制 Session 交叉恢复。

## 恢复与当前状态

- A 的被打断回合已经结束，用户可继续正常对话；
- daemon、listener 和控制 Session 没有因本事件损坏；
- 未执行数据改写、daemon 重启或飞书补发；
- UTF-8 解码缺陷和旧消息抢占风险仍存在，不能把本次人工定位视为已修复；
- 待开发需求见 [`../../backlog/confirmed-limitations/lossless-cli-decoding-and-stale-edit-preemption.zh-CN.md`](../../backlog/confirmed-limitations/lossless-cli-decoding-and-stale-edit-preemption.zh-CN.md)。

## 长期预防

1. 所有流式子进程文本输出必须使用跨 chunk 保留解码状态的方式，或收集 Buffer 后统一解码；
2. 对 lark-cli 输出增加 UTF-8 边界、替换字符和合法 JSON 但正文损坏的回归测试；
3. 将“发现内容变化”和“允许抢占 active turn”拆成两个决策，旧消息不得仅凭新 hash 抢占更新消息；
4. 为 message generation 增加隐私安全的结构化观测，只记录来源、时间关系、长度、digest 和差异类别；
5. 审计其他逐 chunk 解码的外部进程适配器，避免相同缺陷出现在回复、reaction、附件或 Agent 输出链路；
6. 保持日志与文档脱敏，不为了诊断保存完整私人正文或 raw event。
