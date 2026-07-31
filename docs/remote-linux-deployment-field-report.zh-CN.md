# 远程 Linux 从 0 到 1 部署实战复盘

本文记录一次真实的豆姐远程部署：从本地源码和飞书应用凭据出发，经 SSH 部署到一台全新的 Linux 服务器，最终在指定飞书群完成消息接收、Codex 执行、回复、状态表情和 Session 持久化验收。

本文不保存真实 App Secret、Token、OpenID、Chat ID、Session ID 或 WebSocket ticket。示例身份均为 mock 值。

## 1. 最终结果

```text
飞书群中的 @豆姐
  -> im.message.receive_v1
  -> 飞书长连接
  -> systemd 管理的 Doujie daemon
  -> 独立 Linux 用户下的 Codex CLI
  -> 飞书回复和状态表情
```

本次最终状态：

- Alibaba Cloud Linux 3，x86_64。
- 独立的 `doujie` 非 root 用户。
- 源码位于 `/home/doujie/service/doujie`，数据位于 `/home/doujie/.doujie`。
- Node.js `20.19.5`，Codex CLI `0.146.0`，lark-cli `1.0.80`。
- systemd 服务运行中、开机启用、重启次数为 0。
- 飞书 listener 只有 1 个。
- Codex 使用 `approval_policy=never` 和 `danger-full-access`。
- typecheck、build 和 152 项测试通过。
- 真实群消息 `test` 被接收，Codex 执行和回复成功，THINKING/DONE 表情成功，Session 成功落盘。

## 2. 部署输入和安全边界

开始前需要确认：

| 输入 | 形式 | 能否自动发现 |
|---|---|---|
| SSH 目标 | 已配置的 SSH 别名，例如 `seed` | 是 |
| Git 仓库 | 公共 GitHub 仓库 | 是 |
| App ID/Secret | Git 外的本地受限文件 | 否 |
| 目标群 | 群名 | 否 |
| 初始操作者 | 指定用户或群主 | 部分可发现 |
| Codex 权限 | 本次为完整权限 | 必须由用户确认 |
| 历史数据 | 本次使用全新状态 | 必须由用户确认 |

安全边界：

- App Secret 不进入聊天、Git、argv、日志或 systemd unit。
- 飞书凭据只写入服务用户的 `~/.lark-cli/config.json`。
- Codex 凭据只写入服务用户的 `~/.codex`。
- 凭据、豆姐配置、数据库和 Session 映射权限均为 `0600`。
- 不开放豆姐公网 HTTP 端口，飞书使用出站 WebSocket。
- 同一 App 只运行一个 listener。

## 3. 只读审计

先只读检查服务器：

```bash
ssh seed '
  uname -a
  cat /etc/os-release
  id
  command -v git node npm pnpm codex lark-cli systemctl
  codex --version
  node --version
  find ~/.codex -maxdepth 1 -type f -printf "%f %m\n"
  systemctl status doujie --no-pager || true
  ss -lntp
'
```

本次发现 root 下已有 Codex 登录态，但缺少 `git`、`pnpm`、`lark-cli` 和部分构建工具；不存在 `doujie` 用户、旧服务或旧 listener。因此采用“独立服务用户、最小迁移 Codex 认证、全新 Doujie 状态”。

## 4. 创建服务用户并部署源码

```bash
dnf install -y git gcc-c++ python3
useradd --create-home --shell /bin/bash doujie

install -d -m 700 -o doujie -g doujie \
  /home/doujie/.codex \
  /home/doujie/.doujie \
  /home/doujie/service
```

本次仅迁移 Codex 必要认证文件，不复制 root 的全部状态：

```bash
install -m 600 -o doujie -g doujie \
  /root/.codex/auth.json /home/doujie/.codex/auth.json
install -m 600 -o doujie -g doujie \
  /root/.codex/config.toml /home/doujie/.codex/config.toml
```

必须以最终服务用户验证：

```bash
sudo -u doujie -H env PATH='<runtime-path>' codex login status

sudo -u doujie -H env PATH='<runtime-path>' codex exec \
  --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  -C /home/doujie/service/doujie \
  'Reply with exactly: SERVER_CODEX_OK'
```

克隆生产分支：

```bash
sudo -u doujie -H git clone --branch master --single-branch \
  https://github.com/example/doujie.git \
  /home/doujie/service/doujie
```

## 5. 安装稳定运行时

服务器原有 Node.js 24。`better-sqlite3` 没有匹配的预编译包，回退编译时又遇到系统 Python 3.6 无法解析新版 node-gyp 语法，最终改用 Node.js 20。

```bash
version=20.19.5
name="node-v${version}-linux-x64.tar.xz"
base="https://nodejs.org/download/release/v${version}"

curl -fsSL "$base/$name" -o "$name"
curl -fsSL "$base/SHASUMS256.txt" -o SHASUMS256.txt
grep " $name$" SHASUMS256.txt | sha256sum -c -
tar -xJf "$name" -C /opt
ln -sfn "/opt/node-v${version}-linux-x64" /opt/node20
```

安装 pnpm 前先设置 PATH，否则 npm 的 `#!/usr/bin/env node` 仍可能拾取旧 Node：

```bash
export PATH=/opt/node20/bin:/usr/local/bin:/usr/bin:/bin
npm install -g pnpm@10.34.4
```

安装和验证项目：

```bash
cd /home/doujie/service/doujie
sudo -u doujie -H env PATH="$PATH" pnpm install --frozen-lockfile
sudo -u doujie -H env PATH="$PATH" pnpm typecheck
sudo -u doujie -H env PATH="$PATH" pnpm test
sudo -u doujie -H env PATH="$PATH" pnpm build
```

## 6. 安装并配置 lark-cli

本次 npm registry 无法获取 `@larksuite/cli`，因此从官方 GitHub Release 下载 Linux 二进制，按发布方 SHA256 校验后安装：

```bash
install -m 755 ./lark-cli /usr/local/bin/lark-cli
lark-cli --version
```

本地凭据文件为两行：第一行 App ID，第二行 App Secret。通过 SSH stdin 传输，Secret 再通过 lark-cli stdin 输入：

```bash
ssh seed '
  IFS= read -r app_id
  IFS= read -r app_secret
  printf "%s" "$app_secret" |
    sudo -u doujie -H lark-cli config init \
      --app-id "$app_id" \
      --app-secret-stdin \
      --brand feishu
' < "$HOME/path/outside-git/.env.local"
```

App ID 是标识符；App Secret 不应进入 argv。随后检查：

```bash
sudo -u doujie -H lark-cli config default-as bot
sudo -u doujie -H lark-cli whoami --as bot
sudo -u doujie -H lark-cli doctor
```

按群名定位目标群：

```bash
sudo -u doujie -H lark-cli im +chat-search \
  --as bot \
  --query '测试群' \
  --disable-search-by-user \
  --format json
```

结果包含目标 `chat_id` 和群主 `owner_id`。本次使用群主 OpenID 作为初始唯一操作者。

## 7. 配置豆姐

创建 `/home/doujie/.doujie/config.yaml`：

```yaml
codex:
  workdir: /home/doujie/service/doujie
  sandbox: danger-full-access
  skip_git_repo_check: true
  control_session_dir: /home/doujie/.doujie/sessions

feishu:
  chat_ids:
    - oc_mock_group
  as: bot
  bot_mention_ids:
    - cli_mock_app
  bot_mention_names:
    - 豆姐
  edit_polling:
    enabled: false
    chat_ids:
      - oc_mock_group
    as: user
    interval_ms: 10000
    page_size: 20

privacy:
  allow_chat_ids:
    - oc_mock_group
  allow_user_ids:
    - ou_mock_operator

storage:
  db_path: /home/doujie/.doujie/data.db
  backup_dir: /home/doujie/.doujie/backups
  export_dir: /home/doujie/.doujie/exports
  attachment_cache_dir: /home/doujie/.doujie/attachments
```

```bash
chown doujie:doujie /home/doujie/.doujie/config.yaml
chmod 600 /home/doujie/.doujie/config.yaml
```

当前白名单是交集关系：Chat 和 User 都必须命中。上述配置表示“只有指定用户在指定群中可用”，并不自动允许该用户私聊。

## 8. 安装 systemd

创建 `/etc/systemd/system/doujie.service`：

```ini
[Unit]
Description=Doujie Feishu digital employee
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=doujie
Group=doujie
WorkingDirectory=/home/doujie/service/doujie
Environment=HOME=/home/doujie
Environment=PATH=/opt/node20/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/node20/bin/node /home/doujie/service/doujie/dist/index.js
Restart=on-failure
RestartSec=5
KillMode=control-group
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now doujie.service
systemctl status doujie.service --no-pager
journalctl -u doujie.service -n 100 --no-pager
pgrep -af 'lark-cli event.*subscribe'
```

listener 必须只有 1 个。systemd 运行时不要再启动 `pnpm dev` 或另一个 `lark-cli event +subscribe`。

## 9. 配置飞书后台

服务器连接成功不代表应用会投递事件。还必须在飞书开发者后台：

1. 创建企业自建应用并开启机器人能力。
2. 在“事件与回调 -> 事件配置”选择“使用长连接接收事件”。
3. 添加 `im.message.receive_v1`。
4. 以应用身份开通私聊和群聊 @ 机器人所需权限。
5. 设置应用可用范围，把机器人加入目标群。
6. 创建并发布新版本，使权限和事件配置生效。
7. 发布后重启 daemon，让 listener 重新建连。

聊天主链路只要求接收消息事件。消息已读、reaction 创建和 reaction 删除不是必需事件。

## 10. 真实端到端验收

先由 bot 主动发一条部署提示，验证凭据、群可见性和出站消息：

```bash
sudo -u doujie -H lark-cli im +messages-send \
  --as bot --chat-id oc_mock_group \
  --text '服务已上线，请 @豆姐 发送 test。'
```

用户发送：

```text
@豆姐 test
```

服务端检查：

```bash
journalctl -u doujie.service --since '5 minutes ago' --no-pager
systemctl show doujie.service -p ActiveState -p NRestarts
pgrep -af 'lark-cli event.*subscribe'
find /home/doujie/.codex/sessions -type f -name '*.jsonl' \
  -printf '%T@ %p\n' | sort -n | tail
```

本次成功证据依次为：

```text
[listener] im.message.receive_v1
[router] Processing with Codex chat
[reaction] Added THINKING
[reply] Sent reply
[reaction] Added DONE
```

数据库 job 为 `status=replied`、`stage=reply`、`mode=codex_chat`、`last_error=null`。新建 Codex jsonl 中确认：

```text
cwd=/home/doujie/service/doujie
approval_policy=never
sandbox_policy.type=danger-full-access
```

不能只以“bot 能主动发消息”或“WebSocket Connected”作为成功标准。必须有真实用户事件进入、Agent 执行、回复成功并持久化。

## 11. 踩坑点

### 11.1 WebSocket Connected 不代表事件订阅生效

本次最耗时的问题是：长连接成功，bot 也能主动发消息，但用户多次 @ 后数据库始终为 0。根因在飞书后台的接收事件订阅、发布或生效链路。后台修复并发布版本、重连 listener 后，事件才进入服务。

推荐排查顺序：

1. bot 主动发消息是否成功；
2. WebSocket 是否连接；
3. 飞书事件日志是否出现 `im.message.receive_v1`；
4. daemon 是否收到事件；
5. 数据库是否保存消息和 job；
6. Codex Session 是否创建；
7. 回复是否成功。

### 11.2 API 调用日志不是事件日志

“API 调用日志”只记录服务器主动调用群搜索、消息发送、群历史等 API，不能证明飞书是否投递事件。接收问题必须查看“日志检索 -> 事件日志检索”。

事件日志为空时，问题仍在飞书平台配置、版本、可用范围或 @ 的机器人身份，不在 Router 或 Codex。

### 11.3 应用身份和用户身份权限不能混用

用户身份权限不能替代 bot 的应用身份权限，反之亦然。但也不能用无关 API 的缺权错误推断消息事件权限。例如，群成员列表缺 `im:chat.members:read`，只能证明群成员 API 不可用，不能证明接收消息事件不可用。

### 11.4 后台已添加不等于线上已生效

事件、权限、机器人能力或可用范围变化后，应创建并发布新版本。发布后建议重启 systemd，使长连接获取最新配置快照。

### 11.5 编辑后再 @ 不能依赖 bot 读取完整群历史

新应用的 bot 通常只能获得 @ 当前机器人的消息，不能读取完整群历史。群历史接口可能提示旧权限 `im:message.group_msg`，而该权限未必对新应用开放。

编辑轮询应使用 user OAuth 和 `im:message.group_msg:get_as_user` 等最小用户权限，把 `edit_polling.as` 设为 `user`，并只轮询明确群 ID。授权前关闭轮询，避免每 10 秒产生错误和日志噪声。普通实时 @ 不受影响。

### 11.6 Node 24、原生依赖和旧 Python 组合失败

`better-sqlite3` 在 Node 24 下没有预编译包时触发源码编译；系统 Python 3.6 又无法解析新版 node-gyp 语法。改用项目验证过的 Node 20 后安装成功。生产部署应优先选择已验证的 Node LTS。

### 11.7 sudo 和 systemd 不加载交互式 PATH

工具已安装不代表 `sudo -u doujie` 或 systemd 能找到。必须使用与 unit 一致的显式 PATH；`ExecStart` 最好使用绝对 Node 路径。

### 11.8 lark-cli 不一定能从当前 npm registry 获取

本次 registry 对 `@larksuite/cli` 返回 404，最终使用官方 Linux Release 并校验 SHA256。不能把 macOS 二进制直接复制到 Linux。

### 11.9 Codex 登录态必须属于最终服务用户

root 下登录成功不代表 `doujie` 用户可用。必须迁移或重新登录，并以最终用户运行 smoke test。只迁移必要认证文件，保持 `0600`，不要复制 root 的全部 `~/.codex`。

### 11.10 同一 App 不能运行多个 listener

飞书长连接是集群分发，不是广播。多个 listener 会随机分走事件，造成偶发不回复。systemd 运行时不能同时启动前台开发 listener。

### 11.11 日志可能泄露临时连接凭据

SDK 连接日志可能包含 WebSocket ticket 和 access key。对外展示前必须脱敏，不要把完整连接 URL 粘贴到聊天、Issue 或公开 CI。

### 11.12 当前白名单是 Chat 与 User 的交集

同时配置 `allow_chat_ids` 和 `allow_user_ids` 时，两者都必须命中。允许一个群不会自动允许群内所有成员；允许一个用户也不会自动允许其私聊。部署前应明确群、用户、私聊和群共享 Session 策略。

## 12. 需要用户协助配合的点

### 12.1 提供或确认输入

用户需要确认 SSH 目标、飞书凭据来源、目标群、初始操作者、Codex 权限、是否迁移数据，以及是否开放多人/私聊。凭据应放在 Git 外的受限文件中，不直接发送到聊天。

### 12.2 完成飞书开发者后台操作

如果 Agent 没有已登录的受控浏览器，用户必须完成：

- 创建或选择企业自建应用；
- 开启机器人能力；
- 选择长连接事件订阅；
- 添加 `im.message.receive_v1`；
- 申请应用身份权限；
- 设置应用可用范围；
- 创建并发布版本；
- 把机器人加入目标群。

完成后应明确告知“已发布”，而不只是“页面已勾选”。

### 12.3 配合一次真实入站验收

bot 不能伪造真实用户 @ 的平台事件。用户需要在目标群发送一次 `@豆姐 test`。固定文本不是强制要求，只是便于自动判定。

没有回复时，用户可能还需查看“事件日志检索”，确认平台是否产生和投递事件。API 调用日志不能替代。

### 12.4 编辑轮询需要一次用户 OAuth

启用“先发消息、后编辑添加 @”时，远端 lark-cli 需要代表用户读取群历史。用户需要打开 device-flow 授权链接或扫码，并确认授权完成。Agent 可生成链接和二维码、完成后续配置，但不能替用户登录或提供验证码。

### 12.5 多人开放前必须确认权限模型

Codex 为完整权限时，允许用户意味着其可能间接执行服务器命令。开放多人前必须确认每个群允许哪些 OpenID、谁能私聊、谁是管理员、谁能 `/new` 或创建/恢复 Agent，以及群成员是否共享 Session 并互相打断。

## 13. 交付检查表

- [ ] 完成服务器只读审计，无旧 daemon 或重复 listener。
- [ ] 使用独立非 root 用户。
- [ ] Codex 在最终用户下通过 smoke test。
- [ ] 使用已验证的 Node LTS，原生依赖安装成功。
- [ ] lark-cli 来源和校验值可信。
- [ ] App Secret 通过 stdin 配置，未进入 Git、argv 或日志。
- [ ] 目标群、操作者和白名单已确认。
- [ ] typecheck、全部测试和 build 通过。
- [ ] systemd 使用绝对路径、受限 UMask 和单 listener。
- [ ] 长连接、接收消息事件、应用权限和发布版本均生效。
- [ ] 真实用户 @ 事件进入数据库。
- [ ] Codex 回复、状态表情和 Session 持久化通过。
- [ ] jsonl 中 cwd、approval policy 和 sandbox policy 正确。
- [ ] 凭据、配置、数据库和 Session 文件为 `0600`。
- [ ] 没有 user OAuth 时编辑轮询保持关闭。
- [ ] 已记录需要用户配合的后台、授权和验收动作。
