# Doujie Architecture

## Product Boundary

Doujie is the user's digital employee. The user talks to 豆姐 through Feishu, and Doujie turns those chat instructions into local agent control: route work to Codex CLI sessions, resume prior sessions, track what happened, and prepare for dispatching work to project-specific agents.

Doujie should not be coupled to any specific project directory. Her own working directory is the control-plane project:

```text
~/service/doujie
```

Project work should be dispatched through an explicit project/agent registry rather than by changing Doujie's default workdir per Feishu group.

## Runtime Flow

```text
Feishu event stream
  -> EventListener
  -> Router
  -> command handler OR project Agent intent OR default Codex chat
  -> reply client
  -> Feishu message reply
```

Important files:

- `src/index.ts`: process entrypoint and dependency wiring.
- `src/listener.ts`: `lark-cli event +subscribe` integration.
- `src/router.ts`: message extraction, mention gating, command routing, default Codex routing.
- `src/reply.ts`: Feishu reply integration.
- `src/reaction.ts`: Feishu reaction integration.
- `src/config.ts`: config loading and validation.

## Control Sessions

Doujie has three session layers:

1. `~/.doujie/codex-sessions.json`: maps Feishu session keys to Codex session ids.
2. `~/.doujie/sessions/`: operator-facing registry with metadata and links to Codex jsonl files.
3. `~/.doujie/agent-sessions.json`: project Agent registry keyed by user-facing alias.

Session key rules:

- Private chat: `chatId:senderId`
- Group chat: `chatId`

Codex original session jsonl files remain under `~/.codex/sessions/YYYY/MM/DD/`. Doujie does not move them.

Relevant files:

- `src/ai/codex-chat.ts`
- `src/control-sessions.ts`
- `src/agent-session-registry.ts`
- `src/headless-agent-runner.ts`
- `src/agent-session-intent.ts`
- `src/commands/sessions.ts`
- `src/commands/agent-sessions.ts`

Project Agent records store `alias + provider + nativeSessionId + cwd + jsonlPath`. Alias alone is never enough to resume a provider session; dispatch must use the stored provider and cwd with the native session id.

## Message Processing Modes

Command mode:

- `/status`
- `/sessions`
- `/new`
- `/detail`
- `/codex`
- memory/search/maintenance commands

Default mode:

- Normal messages are routed to Codex chat.
- Natural-language requests to create a Codex or Claude Code project Agent session are intercepted before default Codex chat.
- Agent creation always sends a structured confirmation first. The same Feishu user in the same chat must reply `确认`; `取消` clears the pending action.
- Default output hides tool/session details.
- `/detail` enables detailed Codex events.

Memory mode:

- Search, recent, digest, Q&A, backup, export, cleanup.

Relevant files:

- `src/commands/*`
- `src/store.ts`
- `src/maintenance.ts`
- `src/qa.ts`
- `src/fetcher.ts`
- `src/ai/pipeline.ts`
- `src/ai/answer-pipeline.ts`

## Feishu Mention Gating

Group chat behavior is intentional:

- Non-mention group messages are stored but not processed or replied to.
- Mentioned group messages are stripped of bot mention text before processing.
- If no mention matcher is configured, any mention can pass. Treat that as unsafe for production. Production config should keep `feishu.bot_mention_ids` or `feishu.bot_mention_names` configured.

Private chat behavior:

- Messages are processed directly.

Relevant code:

- `Router.shouldProcessMessage`
- `Router.hasBotMention`
- `Router.stripBotMentionText`

## Configuration

Primary config lives at:

```text
~/.doujie/config.yaml
```

Defaults are under:

```text
~/.doujie
```

Precedence:

1. `DOUJIE_*` env
2. `~/.doujie/config.yaml`
3. defaults

## Deployment

Launchd runs the built JavaScript:

```text
ProgramArguments: /opt/homebrew/opt/node@20/bin/node dist/index.js
WorkingDirectory: ~/service/doujie
StandardOutPath: /tmp/doujie.log
StandardErrorPath: /tmp/doujie.log
```

The service does not run `tsx` in production. After source changes, run `pnpm build` and restart launchd.

## Architectural Direction

The project Agent registry is now the first source for named Agent lookup. Future dispatch/resume work should prefer the registry and only scan `~/.codex/sessions` or `~/.claude/projects` when no registry record matches.
