# ADR-0001: Doujie Is the Agent Control Plane

Status: Accepted
Date: 2026-08-02

## Context

Doujie began as a Feishu-to-local-AI bridge, but the intended product is the user's digital employee for supervising and coordinating agents across projects. Treating each Feishu chat as a project workspace would couple the control plane to arbitrary repositories and blur authority boundaries.

## Decision

Doujie is the operator-facing digital employee, Feishu entrypoint, and Agent control plane. Her own default workspace is the Doujie repository. Project-specific work is delegated to explicit project Agents with their own provider, native Session ID, cwd, alias, and permissions.

Doujie is not a project-specific coding worker and is not a continuation of the former InfoHunter product.

## Consequences

- Feishu groups identify control conversations, not implicit project directories.
- Project work requires explicit registry metadata and dispatch.
- Doujie owns routing, policy, observability, recovery, and audit behavior.
- Project Agents own implementation inside their registered workspace.
- Documentation and naming must describe Doujie as a digital employee and control plane.

## Alternatives Rejected

- Bind every group directly to a project cwd: simple initially, but unsuitable for a central control employee.
- Let Doujie edit every target project directly: removes useful separation between management and execution.
