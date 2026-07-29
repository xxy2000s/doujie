# Doujie Architecture

## Product Boundary

Doujie is a local control-plane daemon for one user. The user talks to 豆姐 through Feishu, and Doujie bridges those messages to local tools, Codex CLI sessions, local memory, and future project agents.

Doujie should not be coupled to any specific project directory. Its own working directory is the control-plane project:

```text
~/service/doujie
```

Future project work should be dispatched through an explicit project/agent registry rather than by changing Doujie's default workdir per Feishu group.

## Runtime Flow

```text
Feishu event stream
  -> EventListener
  -> Router
  -> command handler OR default Codex chat
  -> reply client
  -> Feishu message reply
```

Important files:

- `src/index.ts`: process entrypoint and dependency wiring.
- `src/listener.ts`: `lark-cli event +subscribe` integration.
- `src/router.ts`: message extraction, mention gating, command routing, default Codex routing.
- `src/reply.ts`: Feishu reply integration.
- `src/reaction.ts`: Feishu reaction integration.
- `src/config.ts`: config loading and migration fallback.

## Control Sessions

Doujie has two session layers:

1. `~/.doujie/codex-sessions.json`: maps Feishu session keys to Codex session ids.
2. `~/.doujie/sessions/`: operator-facing registry with metadata and links to Codex jsonl files.

Session key rules:

- Private chat: `chatId:senderId`
- Group chat: `chatId`

Codex original session jsonl files remain under `~/.codex/sessions/YYYY/MM/DD/`. Doujie does not move them.

Relevant files:

- `src/ai/codex-chat.ts`
- `src/control-sessions.ts`
- `src/commands/sessions.ts`

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
- Default output hides tool/session details.
- `/detail` enables detailed Codex events.

Legacy memory mode:

- Search, recent, digest, Q&A, backup, export, cleanup.
- This is inherited from InfoHunter and is now Doujie's memory/search capability.

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

Legacy `~/.infohunter` paths exist only for fallback/import. New work should not write there.

Precedence:

1. `DOUJIE_*` env
2. `~/.doujie/config.yaml`
3. legacy `INFOHUNTER_*` env
4. defaults

## Deployment

Launchd runs the built JavaScript:

```text
ProgramArguments: /opt/homebrew/opt/node@20/bin/node dist/index.js
WorkingDirectory: ~/service/doujie
StandardOutPath: /tmp/doujie.log
StandardErrorPath: /tmp/doujie.log
```

The service does not run `tsx` in production. After source changes, run `pnpm build` and restart launchd.

The old InfoHunter daemon has been retired:

```text
~/Library/LaunchAgents/com.infohunter.daemon.plist.disabled
```

## Architectural Direction

Next major capability should be a project/agent registry:

```ts
type AgentRecord = {
  id: string;
  name: string;
  root: string;
  kind: 'codex';
  defaultSessionId?: string;
  status: 'idle' | 'running' | 'blocked';
  lastSeenAt?: string;
};
```

This would let Doujie answer questions such as "dispatch this to the Ashare agent" or "resume the devix website session" without changing Doujie's own control-plane working directory.
