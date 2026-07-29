# AGENTS.md

This file is for AI agents working on Doujie.

## Mission

Doujie is the user's Feishu-facing local computer control plane. It is the single "豆姐" entrypoint for managing the user's local computer and coordinating other agents. Do not treat Doujie as a project-specific coding worker.

Correct mental model:

```text
Doujie = Feishu entrypoint + local control plane + Codex session bridge + memory/search module
InfoHunter = legacy memory/search/digest capability now embedded inside Doujie
Project agents = separate workers that Doujie should dispatch or resume explicitly
```

## Non-Negotiable Runtime Facts

- Source path: `~/service/doujie`
- Config path: `~/.doujie/config.yaml`
- Runtime data root: `~/.doujie`
- SQLite DB: `~/.doujie/data.db`
- Codex session state: `~/.doujie/codex-sessions.json`
- Control session registry: `~/.doujie/sessions`
- LaunchAgent label: `com.doujie.daemon`
- LaunchAgent file: `~/Library/LaunchAgents/com.doujie.daemon.plist`
- Runtime log: `/tmp/doujie.log`
- Retired old plist: `~/Library/LaunchAgents/com.infohunter.daemon.plist.disabled`

Do not write new runtime state under `~/.infohunter`. That path exists only for legacy fallback/import.

## Safety Rules

- Never print or commit real `~/.doujie/config.yaml`, Feishu credentials, OpenAI keys, access tokens, or event WebSocket tickets.
- Do not restore `com.infohunter.daemon.plist` unless explicitly rolling back.
- Do not run two Feishu listeners for the same bot at the same time.
- Do not delete or rewrite `~/.codex/sessions`; Doujie only indexes and links to Codex jsonl files.
- Keep `node_modules`, `dist`, `data`, `*.db`, logs, and local config out of git.
- When touching launchd, verify both new and old services:
  - `launchctl print gui/$(id -u)/com.doujie.daemon`
  - `launchctl print gui/$(id -u)/com.infohunter.daemon 2>/dev/null || echo old-service-not-loaded`

## Coding Conventions

- TypeScript ESM, strict mode.
- Use existing modules and patterns before adding abstractions.
- Keep source in `src/`, tests in `tests/`.
- Build output goes to `dist/` and is not committed.
- Prefer focused tests near changed behavior.
- Use `apply_patch` for manual edits.
- Use `rg` for code search.

## Configuration Precedence

`src/config.ts` intentionally prefers:

1. `DOUJIE_*` environment variables
2. `~/.doujie/config.yaml`
3. legacy `INFOHUNTER_*` environment variables
4. built-in defaults under `~/.doujie`

If `~/.doujie/config.yaml` is absent, the loader may read `~/.infohunter/config.yaml` as a legacy fallback. This is for migration compatibility only.

Important variables:

```text
CODEX_MODEL
DOUJIE_CODEX_WORKDIR
DOUJIE_CODEX_SANDBOX
DOUJIE_CODEX_SKIP_GIT_REPO_CHECK
DOUJIE_CODEX_CONTROL_SESSION_DIR
DOUJIE_FEISHU_BOT_MENTION_IDS
DOUJIE_FEISHU_BOT_MENTION_NAMES
DOUJIE_DB_PATH
```

Legacy `INFOHUNTER_*` variables should not be introduced into new deployment config.

## Feishu Routing Rules

- Private chat: process normal messages directly.
- Group chat: store all messages; only process when the message mentions the configured bot.
- Group session key: `chatId`.
- Private session key: `chatId:senderId`.
- Default mode is Codex chat.
- `/detail <prompt>` shows verbose Codex events.
- Plain messages hide tool/session noise by default.
- Production config must keep `feishu.bot_mention_ids` or `feishu.bot_mention_names` populated. If both are empty, any mention in a group message can pass the group mention gate.

## Session Rules

Codex stores original jsonl files by creation date under:

```text
~/.codex/sessions/YYYY/MM/DD/
```

Doujie keeps its own control-plane index under:

```text
~/.doujie/sessions/index.json
~/.doujie/sessions/README.md
~/.doujie/sessions/links/*.jsonl
```

Use `/sessions` in Feishu to inspect mappings. Use `/new` to clear the current Feishu binding and start a fresh Codex session on the next turn.

## Required Verification Before Handoff

For code changes:

```bash
pnpm typecheck
pnpm test
pnpm build
```

For daemon/runtime changes:

```bash
launchctl kickstart -k gui/$(id -u)/com.doujie.daemon
launchctl print gui/$(id -u)/com.doujie.daemon
tail -n 120 /tmp/doujie.log
```

Also confirm the plist shape when service behavior changes:

```text
ProgramArguments: /opt/homebrew/opt/node@20/bin/node dist/index.js
WorkingDirectory: ~/service/doujie
StandardOutPath: /tmp/doujie.log
StandardErrorPath: /tmp/doujie.log
```

For Feishu E2E changes, send a real message and verify the bot reply:

```text
/status
```

Expected reply starts with `Doujie Status` and shows DB `~/.doujie/data.db`.

Codex E2E:

```text
请只回复：DOUJIE_E2E_OK，不要解释
```

Expected reply is exactly `DOUJIE_E2E_OK`.

## Known Follow-Ups

- Add a first-class project/agent registry so Doujie can dispatch work to project agents instead of doing everything inside its own control-plane session.
- Rename `InfoHunterWebServer*` symbols to Doujie names when touching the web memory module.
- Consider upgrading `lark-cli`; current CLI has reported a newer version is available.
