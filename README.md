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

Doujie replies with a structured draft containing provider, alias, cwd, prompt, and default permission. Reply `确认` to execute or `取消` to discard. Codex sessions default to `workspace-write`; Claude Code sessions default to `default` permission mode.

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

storage:
  db_path: ~/.doujie/data.db
```

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
- [docs/operations.md](./docs/operations.md): service, config, session, and E2E procedures.
