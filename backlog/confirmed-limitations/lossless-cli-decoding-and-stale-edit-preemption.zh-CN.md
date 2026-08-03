# 无损 CLI 解码与旧消息伪更新抢占防护

状态：未交付
优先级：P0-P1

## 背景

已发生真实事故：edit poller 对 lark-cli stdout 分块分别进行 UTF-8 解码，导致旧消息中的一个中文字符变成替换字符。内容 hash 因此变化，旧消息被当作新 generation，再次进入控制 Session 并中断更新消息的 active turn。

脱敏证据、时间线及事实边界见：

- [`../../docs/incidents/2026-08-02-utf8-chunk-decoding-replayed-old-message.zh-CN.md`](../../docs/incidents/2026-08-02-utf8-chunk-decoding-replayed-old-message.zh-CN.md)

本 Backlog 只定义尚未交付的问题与验收边界，不代表修复已经实现。详细设计和验证证据应在用户批准开发后进入对应 Trellis task。

## 用户场景

1. 用户发送消息 A 并等待豆姐处理时，较早消息 B 的 poller 重放不得因为传输解码损坏而中断 A；
2. 用户真实编辑一条消息时，豆姐仍能识别有效变化，但较旧编辑不得无条件抢占更新的 active turn；
3. 网络 EOF、listener reconnect、receive/poller 到达顺序变化和 stdout chunk 边界变化不得改变最终规范化正文；
4. 运维人员能够在不读取完整私人正文的情况下判断一次 generation 变化来自正文、mention、关系、时间还是解码异常。

## P0：阻止再次发生

### P0.1 无损 UTF-8 流式解码

范围：

- 修复 edit poller 的 lark-cli stdout/stderr 聚合方式；
- 使用 `StringDecoder`、Web `TextDecoder` 流模式或 Buffer 聚合，确保跨 chunk UTF-8 码点无损；
- 解码完成后再解析 JSON，错误输出仍遵守现有脱敏规则；
- 搜索并评估仓库内其他对子进程 Buffer 逐块 `toString()` 的路径，将共享风险纳入同一修复任务或形成明确后续项。

验收标准：

1. 任意中文、emoji 和补充平面字符的 UTF-8 字节在每个可能边界拆分后，解析正文与一次性解码完全一致；
2. 相同 lark-cli JSON 仅改变 stdout chunk 分割方式时，message event key 与 content generation key 完全相同；
3. 不产生意外 Unicode 替换字符；上游真实包含替换字符时不得误删或静默改写；
4. stdout/stderr 大小限制、超时、进程错误和日志脱敏行为保持兼容；
5. TypeScript 严格检查、完整自动测试和 build 通过。

### P0.2 旧消息不得抢占更新的 active turn

范围：

- 将“消息形成新 generation”和“该 generation 可以中断 active turn”拆分判断；
- 基于消息首次接收顺序、平台创建/更新时间、事件来源和 active turn 来源 generation 建立明确的新旧关系；
- receive、message_updated 和 poller 三条链路使用同一抢占规则；
- 时间缺失、分钟精度、格式差异或时钟不可信时采用安全降级，不允许仅凭新 content hash 让较旧消息抢占更新消息；
- 保持同一条当前消息的 transport enrichment、真实新消息打断和迟到 close generation 防护。

验收标准：

1. A active 后，较早 B 的伪更新不会启动可抢占 A 的 turn，且 A 自然完成；
2. A active 后，B 即使存在真实文本修改也不会无条件中断 A；B 的后续处理策略必须明确、幂等且可观察；
3. A 之后真正发送的新消息 C 仍只打断 A 一次；
4. receive 与 poller 对同一消息乱序、重复或并发时只形成一次有效处理；
5. 不同 Session 互不影响；
6. 迟到 stdout、close、状态卡更新或 retry 不得覆盖当前 generation。

## P1：可观测性与纵深防护

### P1.1 脱敏 generation 诊断

每次观察到 message generation 变化时，记录结构化且不可逆的诊断字段：

- source：receive、message_updated 或 poller；
- 首次接收时间、事件观察时间、平台 create/update 时间是否存在及相对顺序；
- message type、规范化版本、正文字符数和 UTF-8 字节数；
- 使用项目专用 keyed digest 或等价不可逆摘要，不记录正文；
- mention、direct parent、root、addressed-to-bot 是否变化；
- Unicode 替换字符计数及其是否变化；
- 决策结果：store、skip、process、queue、interrupt 或 reject，以及脱敏 reason code。

验收标准：

1. 仅凭脱敏观测即可判断 generation 由哪个字段类别触发；
2. 日志、SQLite 诊断和错误回复均不包含正文、真实 ID、Token、配置或 raw event；
3. digest 不能跨部署或跨用途被用作用户内容字典，密钥不进入日志或 Git；
4. 观测失败不得阻塞正常消息处理。

### P1.2 外部进程解码审计

- 盘点 lark-cli、Codex 和其他外部进程的 stdout/stderr 解码；
- 对 JSON/JSONL 流分别采用适配其 framing 的增量解码和分帧方式；
- 建立项目级规范：Buffer chunk 是传输边界，不是字符或记录边界；
- 若产生可复用约束，在实现任务完成时更新 `.trellis/spec/`，不要提前把未交付方案写成现状。

## 回归测试矩阵

### 解码层

- 两字节、三字节、四字节 UTF-8 字符分别在每个字节边界拆分；
- 一个 JSON 跨多个 chunk、多个 JSON/JSONL 记录落在同一 chunk；
- chunk 在转义序列、换行和 JSON framing 边界拆分；
- stdout 正常、stderr 非 UTF-8/不完整尾字节、进程超时和非零退出；
- 上游正文真实包含 `�` 与解码错误产生 `�` 的区分策略。

### 路由层

- B receive → B unchanged poller → A active → B corrupted poller；
- B receive → A active → B 真实编辑，平台更新时间前进；
- B 与 A 的 update_time 相同或只有分钟精度；
- A poller 先到、receive 后到；receive 先到、poller 后到；
- mention 表示改变但有效正文不变；
- reply/root transport enrichment 与正文同时变化；
- 同 Session 新消息打断一次、不同 Session 零打断；
- status card 失败、网络 EOF/reconnect、retry 和迟到 close 不改变抢占判断。

### 真实飞书 E2E

- 在指定测试群发送带唯一标记的多字节文本，确认 poller/receive 乱序下只处理一次；
- 运行一个可观察的长 turn，再让较早测试消息进入 poller，确认当前 turn 不被旧 generation 抢占；
- 发送真正的新消息，确认仍能准确打断一次；
- 如平台支持，真实编辑较早消息并验证既定 queue/skip/process 策略；
- 联合核对单 listener、SQLite job/generation、脱敏日志和最终回复；
- 不把自动测试或“机器人有回复”冒充 E2E 成功。

## 兼容与安全约束

- 不改变配置优先级、chat/session key、项目 Agent registry 或 Codex JSONL 所有权；
- 不通过禁用所有编辑消息能力掩盖缺陷；临时关闭 poller 只能作为明确的运维降级；
- 不依赖本地时钟绝对准确来授权抢占；必须定义时间缺失和乱序策略；
- 不保存完整私人正文、raw event、真实 chat/message/user ID 或可逆内容摘要；
- 不把替换字符一律删除，因为它可能是用户真实输入；
- 不因网络重连启动第二个 listener；
- 运行时代码变更后必须按 AGENTS.md 完成 typecheck、test、build、launchd、单 listener 和真实飞书 E2E；
- push、远程部署和 daemon 重启仍需要各自适用的明确授权。

## 非范围

- Durable Run、daemon 跨重启恢复和 Guardian；
- 多层引用消息或附件内容增强；
- 重写 Codex/Claude 原始 Session JSONL；
- 以此次事故为由改变飞书权限、管理员模型或完整权限 Agent 策略；
- 在 Backlog 中提前决定队列数据模型、数据库 migration 或具体类结构；这些属于后续 Trellis design；
- 修复本身、提交、push、部署或运行时配置变更。

## 当前绕行

- 遇到无来源的异常打断时，按消息首次接收顺序核对 receive、poller 和控制 Session，不要只看“机器人是否回复”；
- 检查旧消息是否出现正文长度、digest 或替换字符变化，以及平台 `update_time` 是否实际前进；
- 如风险持续且业务允许，可由操作者明确决定临时关闭指定群的 edit polling；该操作需要配置变更与 daemon 重启，不属于本 Backlog 文档更新；
- 在修复交付前，不能宣称旧消息抢占风险已经消除。
