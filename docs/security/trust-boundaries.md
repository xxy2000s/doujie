# Trust Boundaries

Status: Active
Last updated: 2026-08-02

## Authority Model

Doujie can launch full-access local Agents, so message receipt is not equivalent to authorization.

- Private access is controlled by the private user allowlist.
- Group use is controlled by the group rule and group user allowlist.
- Arbitrary Codex/project Agent dispatch is separately controlled by administrator and Agent-user rules.
- Management commands require administrator authority.
- Natural-language project Agent creation requires structured confirmation from the same user in the same chat.

Group-context permission and computer-control permission must remain separate.

## Feishu Boundary

- Bot identity and user OAuth identity are distinct and cannot substitute for each other.
- Open IDs are application-scoped and must not be copied blindly between Feishu applications.
- App scopes added in the developer console may require a published app version before taking effect.
- Production mention matching must identify the configured bot. Empty mention matchers are unsafe because another mention may pass the group gate.
- One Feishu application should have one logical event listener. Competing listeners can split events.

## Local Execution Boundary

- Codex project Agents currently run with temporary full-access policy per ADR-0004.
- CLI commands must be constructed as argv arrays or stdin; user prompts must never be shell-concatenated.
- Resume must use trusted registry metadata for provider, native Session ID, and cwd.
- Doujie must not rewrite provider-owned transcript JSONL files.
- Service restart, deployment, rollback, and arbitrary Agent execution are distinct authorities.
- Until durable runs and Guardian exist, an active Doujie task must not restart its own daemon.

## Data Boundary

Never commit or print:

- Feishu App Secret, access tokens, event WebSocket tickets, or OAuth device codes;
- OpenAI/Codex credentials;
- real `~/.doujie/config.yaml` or private `.env` files;
- SQLite databases, runtime logs, attachment caches, or transcript contents;
- real chat/user/message IDs in documentation or test fixtures;
- full private prompts or Session JSONL content.

Use mock identifiers in tracked examples. Operational diagnostics may inspect sensitive state locally, but reports must redact it.

## Network Boundary

- A local HTTP dashboard bound to `127.0.0.1` is not directly public.
- Public access requires TLS, authentication outside the URL, rate limiting, and network-level restrictions where possible.
- Tokens must not be placed in query strings because URLs leak through history, logs, referrers, and screenshots.
- SSH tunnels or private overlays are preferred for operator-only access.

## Deployment Boundary

- Runtime state under `~/.doujie` and provider state under `~/.codex`/`~/.claude` are not source code.
- Deployment must not overwrite or delete runtime Session data.
- `release` is a Git deployment pointer; it does not authorize deployment by itself.
- Push, release promotion, daemon restart, and remote rollout require the user's applicable authorization.
- Logs must be inspected for temporary connection credentials before sharing.

## Review Triggers

Revisit this document when:

- additional users or tenants are allowed;
- a public endpoint is introduced;
- Agent permission defaults change;
- Guardian or an operations bot is deployed;
- Feishu identity or application topology changes;
- durable cross-restart execution is implemented.
