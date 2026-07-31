# Doujie

Doujie is the user's digital employee behind the Feishu bot named "豆姐". Its primary job is to act as the operator-facing control point for local and project agents: receive instructions in Feishu, route work into Codex CLI sessions, keep session state, and make agent work observable from chat.

Read this first:

- Product role: a digital employee for supervising, resuming, and coordinating agents.
- Audience: one operator who wants to manage local/project agents through Feishu.
- Runtime shape: a local Node.js daemon managed by launchd.
- Input: Feishu/Lark IM events from `lark-cli event +subscribe`.
- Output: Feishu replies and reactions.
- Agent bridge: normal messages go to Codex chat by default; `/detail` shows verbose Codex events for inspection.
- Session model: private chats use `chatId:senderId`; group chats use `chatId`; `/new` starts a fresh Codex binding.
- State: config and runtime data live under `~/.doujie`; build artifacts and local data are not committed.
- Boundary: Doujie is not a project-specific coding worker. It should control, resume, and dispatch other agents through explicit project/agent metadata.

## Current Runtime

- Source: `~/service/doujie`
- Config: `~/.doujie/config.yaml`
- SQLite DB: `~/.doujie/data.db`
- Codex session state: `~/.doujie/codex-sessions.json`
- Doujie session registry: `~/.doujie/sessions/`
- Project Agent registry: `~/.doujie/agent-sessions.json`
- LaunchAgent: `~/Library/LaunchAgents/com.doujie.daemon.plist`
- Log: `/tmp/doujie.log`

## What It Does

- Listens to Feishu/Lark events through `lark-cli event +subscribe`.
- Stores incoming messages in SQLite.
- In group chats, stores non-mention messages but only processes messages that mention the configured bot.
- In private chats, processes messages directly.
- Defaults normal messages to Codex chat mode.
- Supports `/detail` for verbose Codex tool/session output.
- Adds Feishu reactions for Codex status: thinking, done, error.
- Tracks per-chat Codex sessions in `~/.doujie/codex-sessions.json`.
- Maintains a readable session registry and jsonl links in `~/.doujie/sessions/`.
- Creates named project Agent sessions from natural language after structured confirmation.
- Registers named project Agent sessions in `~/.doujie/agent-sessions.json` with provider, cwd, native session id, and JSONL path.
- Provides message search, recent history, digest, Q&A, backup, export, cleanup, and a read-only local memory web UI.

## Commands

Feishu commands:

```text
/help
/status
/sessions
/agent-sessions [alias]
/new [prompt]
/detail <prompt>
/codex <prompt>
/ask <question>
/search <keyword>
/recent [limit]
/errors [limit]
/retry <message_id>
/save <text>
/digest <text>
/skip [reason]
/redo <message_id>
/retag <message_id> <tag...>
/merge-tag <from> <to>
/backup
/export [format:jsonl|md] [filters]
/cleanup dry-run|run messages:<days>
```

Normal non-command messages are routed to Codex chat by default.

Natural-language project Agent creation uses a confirmation step before any CLI session is launched:

```text
去 /home/doujie/service/doujie 开个 codex session，叫 doujie-main，让它先熟悉项目
```

Doujie replies with a structured draft containing provider, alias, cwd, prompt, and default permission. Reply `确认` to execute or `取消` to discard. Codex project Agent sessions currently default to `danger-full-access`; Claude Code sessions default to `default` permission mode.

## Setup

Install dependencies:

```bash
pnpm install
```

Create local config:

```bash
mkdir -p ~/.doujie
```

Use `~/.doujie/config.yaml` for runtime config. The `.env.example` file only documents optional environment overrides; this app does not load a `.env` file by itself. Do not commit real secrets or local config.

Minimal config:

```yaml
codex:
  workdir: ~/service/doujie
  sandbox: danger-full-access
  control_session_dir: ~/.doujie/sessions

feishu:
  as: bot
  bot_mention_ids:
    - cli_your_bot_app_id
    - ou_your_bot_open_id
  bot_mention_names:
    - 飞书 CLI
    - 豆姐
  # Optional: poll edited group messages because Feishu may not push edit events.
  # Use an identity that can read chat history for these groups.
  edit_polling:
    enabled: false
    chat_ids:
      - oc_your_group_chat_id
    as: user
    interval_ms: 10000
    page_size: 20

storage:
  db_path: ~/.doujie/data.db

privacy:
  # Administrators may use management commands and project Agents.
  admin_user_ids:
    - ou_mock_admin
  private:
    allow_user_ids:
      - ou_mock_admin
  groups:
    - chat_id: oc_mock_group
      # Members may use the explicitly enabled group-context feature.
      allow_user_ids:
        - ou_mock_admin
        - ou_mock_member
      # Only these users may run arbitrary Codex/project Agent instructions.
      allow_agent_user_ids:
        - ou_mock_admin
      context:
        enabled: true
        max_messages: 50
        max_chars: 30000
```

### Access Isolation And Group Context

The scoped privacy configuration separates four capabilities that were previously controlled by one global allowlist:

- `privacy.private.allow_user_ids` controls private-chat access.
- `privacy.groups[].allow_user_ids` controls who may use Doujie in that group.
- `privacy.groups[].allow_agent_user_ids` controls arbitrary Codex and project Agent execution in that group. Administrators are always allowed.
- `privacy.admin_user_ids` controls management commands such as `/new`, `/sessions`, exports, cleanup, and Agent session management.

For compatibility, installations without any scoped private/group/admin rules continue to use the legacy `privacy.allow_user_ids` behavior. Once scoped rules are configured, keep the intended users explicit.

When a permitted group member explicitly asks to summarize or review recent group discussion, Doujie fetches the bounded history configured under that group's `context` block and runs the request in a new isolated read-only Codex session. Ordinary non-mention messages are not processed as commands. They are only read later through Feishu history when an allowed user explicitly requests context. This feature requires a valid user OAuth identity with permission to read that group's message history.

### Edited Group Mentions

Feishu may not push message-edit events reliably. To support the workflow where a group message is sent first and edited later to mention 豆姐, enable edited-message polling for explicit groups only.

This is intentionally not automatic group discovery. Doujie only polls the group chat IDs listed in `feishu.edit_polling.chat_ids`.

Mock example:

```yaml
feishu:
  edit_polling:
    enabled: true
    chat_ids:
      - oc_mock_dev_group_001
      - oc_mock_ashare_group_002
      - oc_mock_agent_ops_group_003
    as: user
    interval_ms: 10000
    page_size: 20
```

Behavior:

- The poller reads recent messages from the configured groups with the configured identity.
- Messages marked `updated: true` are considered, then unchanged content versions are discarded. This prevents bot reactions or card updates from replaying an already handled @mention.
- Group messages still require a configured @豆姐 mention before processing.
- Router privacy rules still apply after polling.
- Edited message versions are deduplicated, so the same edit is not replied to repeatedly.

To add a real group later, find its `chat_id` and append it to `feishu.edit_polling.chat_ids`, then rebuild and restart the daemon. You can also ask 豆姐 to add a named group to edited-message polling; it should resolve the group, update `~/.doujie/config.yaml`, and restart `com.doujie.daemon`.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

Run in foreground for local debugging:

```bash
pnpm dev
```

Start the local memory web UI:

```bash
pnpm web -- --host 127.0.0.1 --port 8787
```

## Service Operations

Check daemon state:

```bash
launchctl print gui/$(id -u)/com.doujie.daemon
```

Restart daemon:

```bash
pnpm build
launchctl kickstart -k gui/$(id -u)/com.doujie.daemon
```

Inspect logs:

```bash
tail -n 120 /tmp/doujie.log
```

The production plist should run:

```text
ProgramArguments: /opt/homebrew/opt/node@20/bin/node dist/index.js
WorkingDirectory: ~/service/doujie
StandardOutPath: /tmp/doujie.log
StandardErrorPath: /tmp/doujie.log
```

## End-To-End Smoke Test

Use Feishu to send `/status` to the existing Doujie private chat or mention 豆姐 in a group. Expected reply starts with:

```text
Doujie Status
```

For Codex chat, send:

```text
请只回复：DOUJIE_E2E_OK，不要解释
```

Expected reply:

```text
DOUJIE_E2E_OK
```

The latest verified smoke tests were:

- `pnpm typecheck`: passed
- `pnpm test`: 139 passed
- `pnpm build`: passed
- Feishu `/status`: returned `Doujie Status` with DB `~/.doujie/data.db`
- Feishu Codex chat after restart: returned `DOUJIE_AFTER_RESTART_OK`
- Feishu Agent create flow: structured confirmation returned, `@豆姐 确认` created alias `doujie-e2e-0731a` and wrote `~/.doujie/agent-sessions.json`

## Documentation

- [AGENTS.md](./AGENTS.md): rules for AI agents working in this repository.
- [docs/architecture.md](./docs/architecture.md): architecture and ownership boundaries.
- [docs/remote-linux-deployment.md](./docs/remote-linux-deployment.md): deploy a brand-new Doujie for a new Feishu account on a remote Linux server (English).
- [docs/remote-linux-deployment.zh-CN.md](./docs/remote-linux-deployment.zh-CN.md): 全新飞书账号和远程 Linux 服务器部署指南（中文）。
- [docs/remote-linux-deployment-field-report.zh-CN.md](./docs/remote-linux-deployment-field-report.zh-CN.md): 从源码、服务器到飞书真实 E2E 的部署实战、踩坑复盘和用户配合清单。
- [docs/operations.md](./docs/operations.md): service, config, session, and E2E procedures.
