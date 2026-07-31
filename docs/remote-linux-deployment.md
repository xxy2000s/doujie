# Brand-New Remote Linux Deployment

This runbook deploys Doujie for a new Feishu account on a new remote Linux server. It assumes the server already has a working Codex CLI and can be reached through an SSH alias such as `seed`.

The target architecture is:

```text
New Feishu account or group
  -> Feishu long-connection events
  -> Doujie daemon on the remote server
  -> Codex CLI and project sessions on that server
```

The operator's laptop is not part of the runtime path after deployment.

## Deployment Decisions

- Run one Doujie daemon under a dedicated, non-root Linux user.
- Use systemd to supervise the daemon.
- Keep source under `/home/doujie/service/doujie` and runtime data under `/home/doujie/.doujie`.
- Keep Feishu credentials in the server-side `lark-cli` configuration, never in Git.
- Start with empty Doujie and Codex session registries unless a migration is explicitly required.
- Restrict execution to the operator's new Feishu OpenID before production use.
- Keep edited-message polling disabled initially. Enable it only for explicit group IDs after user-identity authorization.
- Codex project Agents currently run with `danger-full-access`. Treat every accepted Feishu instruction as local command authority on the server.

## Information Required Before Deployment

Record these values outside Git:

| Item | Example | Notes |
|---|---|---|
| SSH target | `seed` | Existing SSH config alias or host |
| Linux user | `doujie` | Dedicated non-root service user |
| Home directory | `/home/doujie` | Must match the systemd unit |
| Feishu App ID | `cli_mock_app_id` | Not a secret, but do not hard-code it in public examples |
| Feishu App Secret | secret | Never send through chat or commit to Git |
| Bot OpenID | `ou_mock_bot` | Used for mention matching when available |
| Operator OpenID | `ou_mock_operator` | Required for `privacy.allow_user_ids` |
| Allowed group IDs | `oc_mock_ops_group` | Optional; add only after the bot joins the groups |

Also confirm:

- The server can reach Feishu and the configured Codex provider over HTTPS.
- DNS, clock synchronization, and CA certificates work.
- `node`, `pnpm`, `git`, `codex`, and `lark-cli` are installed for the service user.
- `codex` is authenticated as the same Linux user that will run systemd.
- The Feishu application is visible only to the intended account or test users during rollout.

## 1. Prepare the Feishu Application

In the Feishu developer console:

1. Create a new internal application for the new account or tenant.
2. Enable bot capability and set the display name to `豆姐`.
3. Enable long-connection event delivery.
4. Subscribe to the message event required by Doujie's primary chat path:

```text
im.message.receive_v1
```

Feishu does not guarantee a dedicated update event for ordinary text edits. To support a message that is sent first and edited later to mention Doujie, configure a user identity in section 4 and poll history only for explicit chat IDs. Do not make edit events a prerequisite for the primary chat path.

5. Grant the bot the minimum IM scopes needed to receive messages, reply, update cards, and add reactions.
6. Restrict the application's availability range to the new operator account during initial rollout.
7. Publish or activate the application version required by the tenant.

Bot identity uses the application credentials and does not require `lark-cli auth login`. User identity is separate and is only needed for operations such as reading group history for edited-message polling.

## 2. Prepare the Server

Connect using the existing SSH alias:

```bash
ssh seed
```

Run the remaining commands as the dedicated service user. Do not run Doujie as root.

Verify prerequisites:

```bash
node --version
pnpm --version
git --version
codex --version
lark-cli --version
```

Verify Codex authentication and non-interactive execution:

```bash
mkdir -p /home/doujie/service

codex exec \
  --json \
  --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  --cd /home/doujie/service \
  '请只回复 CODEX_SERVER_OK，不要解释'
```

Expected output includes a successful agent message containing `CODEX_SERVER_OK`.

## 3. Install Doujie

Clone and verify the repository:

```bash
cd /home/doujie/service
git clone https://github.com/xxy2000s/doujie.git
cd doujie

pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Create the runtime directory:

```bash
install -d -m 700 /home/doujie/.doujie
```

Do not copy local `node_modules` or `dist` from another machine. Native dependencies such as `better-sqlite3` must be installed for the target server architecture.

## 4. Configure lark-cli

Initialize a new server-side application profile:

```bash
lark-cli config init --new
```

Enter the new application's App ID and App Secret through the interactive flow. Do not place the App Secret in shell history, Git-tracked files, service arguments, or this runbook.

Verify bot identity without printing tokens:

```bash
LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 \
LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 \
lark-cli whoami
```

If edited-message polling will use `--as user`, authorize the new Feishu account with the smallest required scope. Use split-flow authentication:

```bash
lark-cli auth login --scope '<required-history-scope>' --no-wait --json
```

When an agent performs this step, it must show both the returned verification URL and a QR code generated with `lark-cli auth qrcode`. After the operator confirms authorization, the agent completes it with:

```bash
lark-cli auth login --device-code '<fresh-device-code>'
```

Do not cache or reuse verification URLs or device codes.

## 5. Configure Doujie

Create `/home/doujie/.doujie/config.yaml` with mode `0600`:

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

Then enforce ownership and permissions:

```bash
chmod 600 /home/doujie/.doujie/config.yaml
```

Before enabling group access, keep `privacy.allow_user_ids` populated. An empty allowlist broadens who may be able to invoke local Codex execution.

## 6. Install the systemd Service

Create `/etc/systemd/system/doujie.service`:

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

Resolve the actual binaries before installing the unit:

```bash
command -v node
command -v codex
command -v lark-cli
```

Adjust `ExecStart` and `PATH` to those resolved locations. systemd does not load interactive shell startup files.

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now doujie.service
sudo systemctl status doujie.service --no-pager
journalctl -u doujie.service -n 120 --no-pager
```

Verify there is exactly one daemon and one event listener:

```bash
pgrep -af 'node dist/index.js'
pgrep -af 'lark-cli event'
```

Do not start `pnpm dev` while the systemd listener is running for the same bot.

## 7. End-to-End Acceptance

Run acceptance in this order:

1. Private-message the bot with `/status`.
2. Confirm the response references `/home/doujie/.doujie/data.db`.
3. Send:

```text
请只回复 DOUJIE_REMOTE_OK，不要解释
```

4. Confirm the reply is exactly `DOUJIE_REMOTE_OK`.
5. Add the bot to one test group and verify that a normal group message is stored but ignored.
6. Mention `@豆姐` and verify one response is produced.
7. Start a long Codex task, send a newer instruction in the same chat, and verify one interruption notice followed by the new result.
8. Send another normal mention after completion and verify it is not misreported as interrupted.
9. Ask Doujie to create a named Codex project Agent. Verify the confirmation shows the provider, alias, cwd, prompt, and `danger-full-access`.
10. Resume that Agent and verify the command runs in the registry cwd.
11. Test from a Feishu account outside `privacy.allow_user_ids`; it must not execute Codex work.
12. Restart the server and verify systemd restores one listener automatically.

Useful diagnostics:

```bash
systemctl status doujie.service --no-pager
journalctl -u doujie.service --since '10 minutes ago' --no-pager
cat /proc/$(pgrep -f 'node dist/index.js' | head -1)/status | head
```

Never paste full logs into public issues without removing WebSocket tickets, access keys, message content, OpenIDs, and session IDs.

## 8. Fresh State Versus Migration

### Recommended: fresh state

For a new account and server, start without copying:

```text
~/.doujie/data.db
~/.doujie/codex-sessions.json
~/.doujie/agent-sessions.json
~/.doujie/sessions/
```

Create new remote project Agents whose cwd paths exist on the server.

### Optional: migrate existing sessions

A registry entry alone is insufficient. A resumable Codex migration requires the matching provider transcripts and corrected server paths:

```text
~/.codex/sessions/
~/.codex/session_index.jsonl
~/.doujie/agent-sessions.json
```

Before migration:

- Back up both source and destination state.
- Transfer over an encrypted SSH channel.
- Re-map every registry cwd to a real server directory.
- Preserve file ownership and restrictive permissions.
- Never overwrite an active server registry while the daemon is running.
- Validate each alias and native session ID before dispatch.

Do not migrate authentication tokens between unrelated Feishu accounts.

## 9. Upgrade and Rollback

Upgrade:

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

Before an upgrade, record the current commit and create a verified backup through Doujie or SQLite backup tooling.

Rollback code without deleting runtime state:

```bash
cd /home/doujie/service/doujie
git switch --detach '<previous-known-good-commit>'
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart doujie.service
```

Do not use `git reset --hard` against a dirty production checkout. Do not delete `~/.codex/sessions` or `~/.doujie` as part of code rollback.

## 10. Deployment Checklist

- [ ] Dedicated non-root Linux user exists.
- [ ] Codex works non-interactively for that user.
- [ ] Feishu bot capability, scopes, long connection, visibility, and app version are configured.
- [ ] App Secret is stored only in restricted server-side configuration.
- [ ] Operator OpenID is in `privacy.allow_user_ids`.
- [ ] Repository dependencies, typecheck, tests, and build pass on the server.
- [ ] systemd uses the correct `node`, `codex`, and `lark-cli` paths.
- [ ] Exactly one event listener is running.
- [ ] Private chat, group mention, interruption, recovery, Agent create, and Agent resume tests pass.
- [ ] Unauthorized-user behavior is verified.
- [ ] Reboot recovery is verified.
- [ ] Backup and rollback commands are recorded before production use.
