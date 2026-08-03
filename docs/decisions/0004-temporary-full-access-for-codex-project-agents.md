# ADR-0004: Temporary Full Access for Codex Project Agents

Status: Accepted, temporary
Date: 2026-08-02

## Context

The operator explicitly chose full local capability for Codex project Agents created or resumed by Doujie. Earlier registry entries may record `workspace-write`, while current operations require commands such as network access, SSH, service inspection, and cross-workspace work.

## Decision

Until the operator explicitly changes the policy, Codex project Agent create and resume use the CLI-supported `--dangerously-bypass-approvals-and-sandbox` mode. Resume uses the registry cwd and native Session ID; it does not pass the unsupported `--sandbox` option to the resume subcommand.

The current global policy applies when resuming older registry records, even if their historical launch metadata says `workspace-write`.

## Consequences

- Feishu identity, chat policy, administrator role, structured confirmation, and command construction become critical security boundaries.
- Prompts must be passed through argv or stdin, never shell-concatenated.
- Full access does not grant every Feishu user authority to dispatch Agents.
- This policy must be revisited before multi-tenant or broader-user deployment.
- Historical launch metadata remains evidence of how a Session was created; it is not rewritten to fake the current policy.

## Alternatives Rejected for Now

- Default `workspace-write`: insufficient for the operator's current control-plane use cases.
- Per-request arbitrary permission strings: too easy to bypass policy and difficult to audit.
