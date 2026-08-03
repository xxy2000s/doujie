# ADR-0002: Separate Control Sessions from Project Agent Sessions

Status: Accepted
Date: 2026-08-02

## Context

Doujie needs conversational continuity in Feishu and also needs to create or resume named Codex/Claude workers. These identities have different ownership and lookup requirements. A chat binding alone does not contain enough information to safely resume a project Agent.

## Decision

Maintain separate state:

- Feishu-to-Codex control bindings in `~/.doujie/codex-sessions.json`;
- operator-readable control Session metadata and JSONL links in `~/.doujie/sessions/`;
- named project Agent records in `~/.doujie/agent-sessions.json`.

Project Agent records use `alias + provider + nativeSessionId + cwd` as the minimum resume identity. Alias alone and TUI `/resume` visibility are not authoritative.

## Consequences

- `/new` changes only the current Feishu control binding.
- Project Agent creation and resume do not silently replace Doujie's own chat Session.
- Session discovery may suggest candidates, but promotion into the trusted registry requires complete metadata and confirmation.
- Original Codex and Claude transcripts remain provider-owned and are not rewritten by Doujie.

## Alternatives Rejected

- One registry for every transcript: difficult to trust and expensive to keep current.
- Infer cwd from alias or current chat: ambiguous and unsafe.
- Treat the interactive TUI picker as the source of truth: headless Sessions may not appear there.
