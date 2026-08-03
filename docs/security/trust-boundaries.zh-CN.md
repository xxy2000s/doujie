# 信任与安全边界

状态：生效中
最后更新：2026-08-02

## 权限模型

豆姐能够启动完整权限的本地 Agent，因此“消息被收到”不等于“消息有权执行”。

- 私聊访问由私聊用户白名单控制；
- 群聊使用由群规则和群用户白名单控制；
- 任意 Codex/项目 Agent 调度由管理员和 Agent 用户规则单独控制；
- 管理命令要求管理员权限；
- 自然语言创建项目 Agent 时，必须由同一 chat 中的同一用户完成结构化确认。

群上下文读取权限和电脑控制权限必须始终分离。

## 飞书边界

- Bot 身份和用户 OAuth 身份相互独立，不能互相替代；
- OpenID 具有应用维度，不能在不同飞书应用间直接照搬；
- 开发者后台新增 scope 后，可能需要发布应用版本才会实际生效；
- 生产环境必须准确匹配当前机器人，mention matcher 为空时，其他 mention 可能错误通过群门控；
- 同一个飞书应用应只有一个逻辑 listener，多个 listener 会竞争事件。

## 本地执行边界

- Codex 项目 Agent 当前按 ADR-0004 使用临时完整权限策略；
- CLI 命令必须使用 argv 数组或 stdin，用户 Prompt 禁止拼接到 shell；
- Resume 必须从可信 registry 读取 provider、原生 Session ID 和 cwd；
- 豆姐不得重写 provider 管理的 transcript JSONL；
- 服务重启、发布、回滚和任意 Agent 执行是不同权限；
- Durable Run 和 Guardian 完成前，活跃豆姐任务不得重启自身 daemon。

## 数据边界

不得提交或输出：

- 飞书 App Secret、访问 Token、事件 WebSocket ticket 或 OAuth device code；
- OpenAI/Codex 凭证；
- 真实 `~/.doujie/config.yaml` 或私人 `.env`；
- SQLite 数据库、运行日志、附件缓存或 transcript 正文；
- 文档和测试 fixture 中的真实 chat/user/message ID；
- 完整私人 Prompt 或 Session JSONL 内容。

受 Git 管理的示例使用 mock 标识。运维诊断可以在本机读取敏感状态，但对外报告必须脱敏。

## 网络边界

- 绑定 `127.0.0.1` 的本地 HTTP 看板不会直接暴露到公网；
- 公网访问必须使用 TLS、URL 之外的鉴权、限流，并尽可能增加网络层访问限制；
- Token 不得放在 URL 查询参数中，因为 URL 会进入历史、日志、Referrer 和截图；
- 仅操作者使用时优先选择 SSH tunnel 或私有网络覆盖。

## 部署边界

- `~/.doujie` 运行数据和 `~/.codex`/`~/.claude` provider 数据不是源码；
- 部署不得覆盖或删除运行 Session 数据；
- `release` 是 Git 部署指针，本身不等于部署授权；
- Push、release 晋升、daemon 重启和远程上线分别需要适用的用户授权；
- 分享日志前必须检查并清理临时连接凭证。

## 重新评估触发条件

以下情况发生时必须复核本文：

- 开放更多用户或租户；
- 引入公网入口；
- Agent 默认权限改变；
- 部署 Guardian 或运维机器人；
- 飞书身份或应用拓扑改变；
- 实现跨重启 Durable Run。
