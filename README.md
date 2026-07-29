# Doujie

Doujie is the local computer control-plane daemon behind the Feishu bot named "豆姐". It receives Feishu messages, routes commands, runs local Codex CLI turns, tracks Codex sessions, and keeps a local memory/search database.

The key design point: Doujie is the user's control-plane employee, not a project-specific worker. It should stay in this repository and dispatch or resume project agents by explicit session/project metadata. The older InfoHunter behavior now lives here as memory/search/digest capability, not as the product identity.

## Current Runtime

- Source: `~/service/doujie`
- Config: `~/.doujie/config.yaml`
- SQLite DB: `~/.doujie/data.db`
- Codex session state: `~/.doujie/codex-sessions.json`
- Doujie session registry: `~/.doujie/sessions/`
- LaunchAgent: `~/Library/LaunchAgents/com.doujie.daemon.plist`
- Log: `/tmp/doujie.log`

The retired InfoHunter LaunchAgent is intentionally disabled as:

```text
~/Library/LaunchAgents/com.infohunter.daemon.plist.disabled
```

Do not restore it unless explicitly rolling back.

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
- Keeps the old message search, digest, Q&A, backup, export, and web memory tools.

## Commands

Feishu commands:

```text
/help
/status
/sessions
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

Confirm old service is not loaded:

```bash
test ! -f ~/Library/LaunchAgents/com.infohunter.daemon.plist && echo old-plist-disabled
launchctl print gui/$(id -u)/com.infohunter.daemon 2>/dev/null || echo old-service-not-loaded
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

The latest verified migration tests were:

- `pnpm typecheck`: passed
- `pnpm test`: 126 passed
- `pnpm build`: passed
- Feishu `/status`: returned `Doujie Status` with DB `~/.doujie/data.db`
- Feishu Codex chat after restart: returned `DOUJIE_AFTER_RESTART_OK`

## Documentation

- [AGENTS.md](./AGENTS.md): rules for AI agents working in this repository.
- [docs/architecture.md](./docs/architecture.md): architecture and ownership boundaries.
- [docs/operations.md](./docs/operations.md): service, config, session, and E2E procedures.
