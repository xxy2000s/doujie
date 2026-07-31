# 全新远程 Linux 部署指南

本文用于把豆姐部署到一台全新的远程 Linux 服务器，并接入一个新的飞书账号。默认服务器已经安装并登录 Codex CLI，而且可以通过 `ssh seed` 之类的 SSH 别名连接。

目标架构：

```text
新的飞书账号或群聊
  -> 飞书长连接事件
  -> 远程服务器上的 Doujie daemon
  -> 服务器本地的 Codex CLI 和项目 Session
```

部署完成后，运行链路不依赖操作者的个人电脑持续在线。

## 部署约定

- 使用独立的非 root Linux 用户运行豆姐。
- 使用 systemd 托管进程和自动重启。
- 源码放在 `/home/doujie/service/doujie`，运行数据放在 `/home/doujie/.doujie`。
- 飞书凭证只保存在服务器的 `lark-cli` 受限配置中，不进入 Git。
- 除非明确需要迁移，否则使用全新的豆姐和 Codex Session registry。
- 上线前必须通过新飞书账号的 OpenID 限制可执行用户。
- 初次部署时关闭“编辑后 @ 豆姐”轮询；完成 user 身份授权后，再按明确的群 ID 开启。
- 当前 Codex 项目 Agent 默认使用 `danger-full-access`。任何被鉴权放行的飞书指令，都可能获得服务器上的本地命令执行能力。

## 部署前需要的信息

以下信息应记录在 Git 之外：

| 项目 | 示例 | 说明 |
|---|---|---|
| SSH 目标 | `seed` | 已配置的 SSH 别名或主机 |
| Linux 用户 | `doujie` | 独立的非 root 服务用户 |
| 用户主目录 | `/home/doujie` | 必须与 systemd 配置一致 |
| 飞书 App ID | `cli_mock_app_id` | 不是密码，但公开示例中仍使用 mock 值 |
| 飞书 App Secret | 密钥 | 不要通过聊天发送或提交到 Git |
| 机器人 OpenID | `ou_mock_bot` | 可用于严格匹配群聊 mention |
| 操作者 OpenID | `ou_mock_operator` | 写入 `privacy.allow_user_ids` |
| 允许的群 ID | `oc_mock_ops_group` | 可选；机器人入群后再配置 |

同时确认：

- 服务器能够通过 HTTPS 访问飞书和 Codex 所使用的模型服务。
- DNS、系统时间和 CA 证书正常。
- 服务用户已安装 `node`、`pnpm`、`git`、`codex` 和 `lark-cli`。
- Codex 登录态属于实际运行 systemd 的 Linux 用户。
- 初次上线时，飞书应用的可用范围只包含操作者或测试账号。

## 1. 创建飞书应用

在飞书开放平台完成：

1. 在新账号所在租户创建企业自建应用。
2. 开启机器人能力，并将机器人名称设置为“豆姐”。
3. 开启长连接事件接收。
4. 订阅豆姐聊天主链路需要的消息事件：

```text
im.message.receive_v1
```

飞书并不保证为普通文本编辑稳定推送独立更新事件。需要支持“先发送、后编辑添加 @豆姐”时，按本文第 4 节配置 user 身份，并通过明确群 ID 的历史轮询补充；不要把编辑事件当作主链路上线前提。

5. 给 bot 开通接收消息、回复消息、更新卡片和添加表情所需的最小 IM 权限。
6. 初始阶段把应用可用范围限制为新的操作者账号。
7. 按租户要求创建并发布应用版本。

bot 身份使用 App ID 和 App Secret，不需要执行 `lark-cli auth login`。user 身份是另一套授权，只在读取群历史、编辑消息轮询等需要代表用户访问资源的场景使用。

## 2. 准备服务器

通过现有 SSH 别名连接：

```bash
ssh seed
```

后续命令应由独立服务用户执行，不要以 root 身份运行豆姐。

检查依赖：

```bash
node --version
pnpm --version
git --version
codex --version
lark-cli --version
```

验证 Codex 登录态和无头执行能力：

```bash
mkdir -p /home/doujie/service

codex exec \
  --json \
  --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  --cd /home/doujie/service \
  '请只回复 CODEX_SERVER_OK，不要解释'
```

预期输出中出现成功的 agent 消息，正文为 `CODEX_SERVER_OK`。

## 3. 安装豆姐

克隆并验证源码：

```bash
cd /home/doujie/service
git clone https://github.com/xxy2000s/doujie.git
cd doujie

pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

创建运行数据目录：

```bash
install -d -m 700 /home/doujie/.doujie
```

不要从其他机器复制 `node_modules` 或 `dist`。`better-sqlite3` 等原生依赖必须针对目标服务器的操作系统和 CPU 架构安装。

## 4. 配置 lark-cli

在服务器上初始化新的飞书应用配置：

```bash
lark-cli config init --new
```

通过交互流程填写新应用的 App ID 和 App Secret。不要把 App Secret 写入 Shell 历史、Git 文件、systemd 命令行参数或本文档。

在不打印 Token 的前提下检查当前身份：

```bash
LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 \
LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 \
lark-cli whoami
```

如果编辑消息轮询需要 `--as user`，应按最小权限原则给新飞书账号授权。使用 split-flow：

```bash
lark-cli auth login --scope '<群历史所需权限>' --no-wait --json
```

如果该步骤由 Agent 代为执行，Agent 必须把返回的授权链接和通过 `lark-cli auth qrcode` 生成的二维码一起展示给用户。用户确认授权完成后，再由 Agent 执行：

```bash
lark-cli auth login --device-code '<本次生成的-device-code>'
```

授权链接和 device code 不得缓存或重复使用。

## 5. 配置豆姐

创建 `/home/doujie/.doujie/config.yaml`，文件权限设为 `0600`：

```yaml
codex:
  workdir: /home/doujie/service/doujie
  sandbox: danger-full-access
  skip_git_repo_check: true
  control_session_dir: /home/doujie/.doujie/sessions

feishu:
  as: bot
  bot_mention_ids:
    - cli_mock_app_id
    - ou_mock_bot
  bot_mention_names:
    - 豆姐
  edit_polling:
    enabled: false
    chat_ids: []
    as: user
    interval_ms: 10000
    page_size: 20

privacy:
  allow_user_ids:
    - ou_mock_operator
  allow_chat_ids: []
  deny_user_ids: []
  deny_chat_ids: []
  skip_patterns: []
  redact_patterns: []

storage:
  db_path: /home/doujie/.doujie/data.db
  backup_dir: /home/doujie/.doujie/backups
  export_dir: /home/doujie/.doujie/exports
  attachment_cache_dir: /home/doujie/.doujie/attachments
```

设置权限：

```bash
chmod 600 /home/doujie/.doujie/config.yaml
```

启用群聊前，必须保证 `privacy.allow_user_ids` 非空。允许用户列表为空会扩大能够触发本地 Codex 执行的人群。

## 6. 安装 systemd 服务

创建 `/etc/systemd/system/doujie.service`：

```ini
[Unit]
Description=Doujie Feishu Agent Control Plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=doujie
Group=doujie
WorkingDirectory=/home/doujie/service/doujie
Environment=HOME=/home/doujie
Environment=PATH=/home/doujie/.local/bin:/home/doujie/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
KillMode=control-group
UMask=0077

[Install]
WantedBy=multi-user.target
```

安装前确认真实可执行文件路径：

```bash
command -v node
command -v codex
command -v lark-cli
```

根据结果调整 `ExecStart` 和 `PATH`。systemd 不会自动加载交互式 Shell 的启动文件。

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now doujie.service
sudo systemctl status doujie.service --no-pager
journalctl -u doujie.service -n 120 --no-pager
```

确认只有一个 daemon 和一个事件 listener：

```bash
pgrep -af 'node dist/index.js'
pgrep -af 'lark-cli event'
```

同一机器上的 systemd listener 运行时，不要再为同一个机器人启动 `pnpm dev`。

## 7. 端到端验收

按以下顺序验收：

1. 私聊豆姐发送 `/status`。
2. 确认状态回复中的数据库路径为 `/home/doujie/.doujie/data.db`。
3. 发送：

```text
请只回复 DOUJIE_REMOTE_OK，不要解释
```

4. 确认回复严格等于 `DOUJIE_REMOTE_OK`。
5. 把机器人加入一个测试群，确认普通群消息会被存储但不会执行。
6. 在群里 `@豆姐`，确认只产生一轮回复。
7. 启动一个长 Codex 任务，然后在同一会话发送新指令，确认只出现一次中断通知，并执行新任务。
8. 前一任务完成后再次正常 `@豆姐`，确认不会误报中断。
9. 让豆姐创建一个带别名的 Codex 项目 Agent，确认结构化确认中包含 provider、alias、cwd、prompt 和 `danger-full-access`。
10. Resume 该 Agent，确认命令在 registry 记录的 cwd 中执行。
11. 使用不在 `privacy.allow_user_ids` 中的飞书账号测试，确认不会执行 Codex 工作。
12. 重启服务器，确认 systemd 自动恢复，并且仍然只有一个 listener。

常用诊断命令：

```bash
systemctl status doujie.service --no-pager
journalctl -u doujie.service --since '10 minutes ago' --no-pager
cat /proc/$(pgrep -f 'node dist/index.js' | head -1)/status | head
```

不要把未脱敏的完整日志粘贴到公开 Issue。至少要移除 WebSocket ticket、access key、消息正文、OpenID 和 Session ID。

## 8. 全新状态与 Session 迁移

### 推荐：使用全新状态

对于新的账号和服务器，建议不复制以下文件：

```text
~/.doujie/data.db
~/.doujie/codex-sessions.json
~/.doujie/agent-sessions.json
~/.doujie/sessions/
```

直接在远程服务器上创建新的项目 Agent，并确保每个 cwd 都是服务器上的真实目录。

### 可选：迁移已有 Session

只复制 registry 记录无法 Resume。Codex Session 迁移必须同时包含匹配的 provider transcript，并修正服务器路径：

```text
~/.codex/sessions/
~/.codex/session_index.jsonl
~/.doujie/agent-sessions.json
```

迁移前必须：

- 分别备份源端和目标端状态。
- 通过加密 SSH 通道传输。
- 把 registry 中每个 cwd 映射到服务器真实目录。
- 保留正确的文件所有者和受限权限。
- daemon 运行时不得覆盖服务器上的活动 registry。
- 派发任务前逐项校验 alias、native session ID 和 cwd。

不要在无关的飞书账号之间迁移认证 Token。

## 9. 升级与回滚

升级：

```bash
cd /home/doujie/service/doujie
git fetch origin
git switch master
git pull --ff-only
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
sudo systemctl restart doujie.service
sudo systemctl status doujie.service --no-pager
```

升级前应记录当前 commit，并使用豆姐的备份命令或 SQLite 备份工具创建可验证备份。

只回滚代码，不删除运行数据：

```bash
cd /home/doujie/service/doujie
git switch --detach '<上一个已验证的-commit>'
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart doujie.service
```

不要对存在未提交修改的生产目录执行 `git reset --hard`。代码回滚时不要删除 `~/.codex/sessions` 或 `~/.doujie`。

## 10. 部署检查清单

- [ ] 已创建独立的非 root Linux 用户。
- [ ] Codex 能以该用户无头运行。
- [ ] 飞书机器人能力、权限、长连接、可用范围和应用版本已配置。
- [ ] App Secret 只保存在服务器的受限配置中。
- [ ] 操作者 OpenID 已写入 `privacy.allow_user_ids`。
- [ ] 服务器上依赖安装、typecheck、测试和构建全部通过。
- [ ] systemd 使用正确的 `node`、`codex` 和 `lark-cli` 路径。
- [ ] 当前只有一个飞书事件 listener。
- [ ] 私聊、群聊 mention、打断、恢复、Agent 创建和 Resume 已通过测试。
- [ ] 非授权账号不能执行 Agent 工作。
- [ ] 服务器重启后能自动恢复服务。
- [ ] 正式使用前已经记录备份和回滚命令。
