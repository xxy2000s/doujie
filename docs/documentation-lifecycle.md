# Documentation Lifecycle

Status: Active
Last updated: 2026-08-02

Doujie keeps different kinds of knowledge in different locations so that stable facts, historical evidence, planned work, and implementation details do not compete as sources of truth.

## Document Classes

| Location | Purpose | Update rule |
|---|---|---|
| `README.md` | Fast human introduction and setup | Keep concise and current |
| `AGENTS.md` | Non-negotiable runtime and maintenance rules for agents | Update when an invariant changes |
| `docs/architecture/` | How the delivered system currently works | Update after behavior is delivered |
| `docs/decisions/` | Why a consequential decision was made | Append ADRs; supersede, do not rewrite history |
| `docs/deployment/` | Supported deployment procedures | Update when deployment behavior changes |
| `docs/operations/` | Current checks, recovery, and E2E procedures | Keep executable; link to incidents for history |
| `docs/incidents/` | Evidence-backed production or operational failures | Immutable history except factual corrections |
| `docs/security/` | Trust boundaries, permissions, and secret-handling policy | Review when authority or exposure changes |
| `docs/ai-governance/` | AI authority, evidence, model/tool policy, and lifecycle governance | Review when Agent autonomy or development policy changes |
| `backlog/confirmed-limitations/` | Confirmed problems not yet delivered | Keep problem-focused; link to active Trellis task |
| `.trellis/tasks/` | Requirement, design, implementation, review, and verification for one iteration | Becomes the implementation source of truth while active |
| `.trellis/spec/` | Stable project-wide development conventions | Update only with reusable knowledge |
| `brainstorm/` | Local, unconfirmed ideas | Ignored by Git; promote deliberately |

## Knowledge Flow

```text
brainstorm
  -> confirmed limitation or ADR candidate
  -> Trellis task after implementation approval
  -> code + stable docs + ADR updates
  -> archived Trellis evidence
```

Incidents follow a separate path:

```text
incident
  -> docs/incidents postmortem
  -> current safety rule in runbook
  -> confirmed limitation
  -> Trellis remediation task
```

## Source-of-Truth Rules

1. Delivered runtime behavior belongs in code, tests, `AGENTS.md`, and stable architecture/operations docs.
2. An ADR records a decision and its consequences; it does not prove implementation.
3. A backlog item records an unresolved problem; it must not claim that a feature exists.
4. Once a Trellis task starts, detailed implementation design belongs there rather than being duplicated in backlog.
5. Verification evidence belongs in the active or archived Trellis task. Stable docs summarize behavior without copying transient IDs or logs.
6. Fast-changing state such as current PID, branch distance, CLI notices, OAuth expiry, or remote daemon status must be queried at runtime instead of maintained in long-lived docs.
7. Never store credentials, tokens, event tickets, real chat/user IDs, full prompts, or transcript bodies in any documentation class.

## Required Metadata

ADRs and incidents must identify status and date near the top. Backlog items must state that they are not delivered. When a decision changes, add a new ADR and mark the old one `Superseded by ADR-NNNN`.

## Task Completion Check

Before closing a non-trivial Trellis task, check:

- Does stable architecture or operations documentation need to change?
- Was a consequential choice made that requires an ADR?
- Did a real incident occur that requires a postmortem?
- Can a backlog item be closed, reduced, or linked to the archived task?
- Did the task produce reusable rules for `.trellis/spec/`?
- Do all links resolve, and does a sensitive-data scan remain clean?
