# Runtime Configuration Operations

## Observe

- `/status` reports config version, source, watcher state, lifecycle actions, and sanitized failure state.
- `/features` reports effective quoted-message settings for the current chat without exposing chat/user IDs.
- `/reload` is administrator-only and explicitly applies a completed configuration file.

## Hot And Restart-Bound Fields

Hot-applied for subsequent requests:

- output transport;
- global and group feature settings;
- privacy routing and content rules;
- Codex model, workdir, sandbox, and skip-git defaults;
- bot mention matchers;
- edited-message poller configuration;
- attachment extraction policy.

Restart-bound:

- storage roots;
- Codex control-session root;
- Feishu listener identity and listener chat subscriptions;
- daemon process/environment settings.

## Watcher Safety Gate

The file watcher rejects a candidate before snapshot installation when it could be a syntactically valid partial write that weakens security. It does not automatically:

- add, remove, or alter allow/admin/private/group Agent authorization sets;
- remove existing deny-chat or deny-user entries;
- remove or alter existing skip/redact patterns;
- add, remove, or alter configured bot mention ID/name matcher sets;
- clear a non-empty Codex model;
- change the actual Codex workdir location (equivalent normalized spellings and symlinks to the same existing target are allowed);
- move to a more permissive sandbox;
- change skip-git-repo-check from false to true.

The rejection is reported as a fixed configuration-validation failure. The active snapshot/version is preserved, and audit/status output contains only allowlisted paths/enums, never values or IDs.

For an intentional policy removal or permission broadening:

1. Finish writing the complete `~/.doujie/config.yaml`.
2. Review the file locally without pasting secrets into chat or logs.
3. Run `/reload` as an administrator.
4. Check `/status` and `/features`.

This explicit step trades some hot-edit convenience for protection against editor truncate/replace intermediate states.

## Quoted Messages

`features.quoted_message` supports `enabled`, `max_chars`, `max_depth`, and `include_attachments`. Group overrides live under `privacy.groups[].features.quoted_message`.

Traversal is direct-parent-only, bounded, cycle-safe, and formatted oldest-to-newest under one Unicode content budget. Post/card content must parse into known structures. Attachment handling is metadata-only. If any direct level is missing, malformed, unauthorized, or not displayable under the active attachment policy, Doujie discards the whole chain and sends only the current message to Codex.
