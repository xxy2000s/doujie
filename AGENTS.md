# AGENTS.md

This file is for AI agents working on Doujie.

## Mission

Doujie is the user's digital employee. It is the single "豆姐" Feishu entrypoint for supervising, resuming, and coordinating local/project agents on the user's computer. Do not treat Doujie as a project-specific coding worker.

Correct mental model:

```text
Doujie = digital employee + Feishu entrypoint + agent control plane + Codex session bridge + memory/search module
Project agents = separate workers that Doujie dispatches, resumes, or audits explicitly
```

## Non-Negotiable Runtime Facts

- Source path: `~/service/doujie`
- Config path: `~/.doujie/config.yaml`
- Runtime data root: `~/.doujie`
- SQLite DB: `~/.doujie/data.db`
- Codex session state: `~/.doujie/codex-sessions.json`
- Control session registry: `~/.doujie/sessions`
- Project Agent registry: `~/.doujie/agent-sessions.json`
- LaunchAgent label: `com.doujie.daemon`
- LaunchAgent file: `~/Library/LaunchAgents/com.doujie.daemon.plist`
- Runtime log: `/tmp/doujie.log`

## Safety Rules

- Never print or commit real `~/.doujie/config.yaml`, Feishu credentials, OpenAI keys, access tokens, or event WebSocket tickets.
- Do not run two Feishu listeners for the same bot at the same time.
- Do not delete or rewrite `~/.codex/sessions`; Doujie only indexes and links to Codex jsonl files.
- Keep `node_modules`, `dist`, `data`, `*.db`, logs, and local config out of git.
- When touching launchd, verify `launchctl print gui/$(id -u)/com.doujie.daemon`.

## Coding Conventions

- TypeScript ESM, strict mode.
- Use existing modules and patterns before adding abstractions.
- Keep source in `src/`, tests in `tests/`.
- Build output goes to `dist/` and is not committed.
- Prefer focused tests near changed behavior.
- Use `apply_patch` for manual edits.
- Use `rg` for code search.

## Trellis Development Workflow

This repository is initialized with Trellis for development workflow support only. Trellis does not change Doujie's runtime role, Feishu routing, config precedence, or agent control-plane boundaries.

- Keep this `AGENTS.md` as the primary source for Doujie runtime facts and safety rules.
- Use `.trellis/workflow.md` and `.trellis/spec/` to structure non-trivial development tasks and preserve project conventions.
- Trellis platform files live in `.codex/`, `.claude/`, and `.agents/skills/`; they are development-time agent helpers, not Doujie project Agent session records.
- Do not store secrets, Feishu credentials, OpenAI keys, runtime logs, event tickets, or real local config in `.trellis/tasks/`, `.trellis/workspace/`, or Trellis specs.
- Before updating Trellis-managed files, run `trellis update --dry-run`; use `trellis update --migrate` only when Trellis reports a required migration.

## Configuration Precedence

`src/config.ts` intentionally prefers:

1. `DOUJIE_*` environment variables
2. `~/.doujie/config.yaml`
3. built-in defaults under `~/.doujie`

Important variables:

```text
DOUJIE_OUTPUT_TRANSPORT
CODEX_MODEL
DOUJIE_CODEX_WORKDIR
DOUJIE_CODEX_SANDBOX
DOUJIE_CODEX_SKIP_GIT_REPO_CHECK
DOUJIE_CODEX_CONTROL_SESSION_DIR
DOUJIE_FEISHU_BOT_MENTION_IDS
DOUJIE_FEISHU_BOT_MENTION_NAMES
DOUJIE_DB_PATH
```

## Feishu Routing Rules

- Private chat: process normal messages directly.
- Group chat: store all messages; only process when the message mentions the configured bot.
- Edited group messages can be handled by event subscription when available, or by optional `feishu.edit_polling` history polling for configured `feishu.edit_polling.chat_ids`.
- Group session key: `chatId`.
- Private session key: `chatId:senderId`.
- Default mode is Codex chat.
- Natural-language project Agent creation is intercepted before default Codex chat when provider, cwd, alias, and session intent can be parsed.
- Project Agent creation requires a structured confirmation; only the same Feishu user in the same chat can reply `确认` or `取消`.
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

Project Agent sessions are separate from Doujie's own Feishu binding:

```text
~/.doujie/agent-sessions.json
```

Each record stores `alias`, `provider`, `nativeSessionId`, `cwd`, `jsonlPath`, creator metadata, and launch defaults. Use `/agent-sessions [alias]` in Feishu to inspect this registry. For named project Agent lookup, check this registry before scanning `~/.codex/sessions` or `~/.claude/projects`.

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

- Add natural-language dispatch/resume to existing project Agent aliases.
- Headless sessions created by `codex exec` are resumable by native ID but may not appear in the interactive Codex TUI `/resume` picker. See `backlog/confirmed-limitations/codex-headless-tui-resume.zh-CN.md` before changing session creation or discovery behavior.
- Until durable run recovery is delivered, an active Doujie control turn must not restart its own daemon. Follow `docs/operations/runbook.md` and the linked incident procedure.
- Consider upgrading `lark-cli`; current CLI has reported a newer version is available.
