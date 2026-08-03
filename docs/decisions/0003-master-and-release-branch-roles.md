# ADR-0003: Master Is the Development Line and Release Is the Deployment Pointer

Status: Accepted
Date: 2026-08-02

## Context

The server needs a predictable deployment reference without maintaining a second, stripped copy of the source tree. Removing documentation or development files from a deployment branch creates unnecessary merge conflicts and does not affect the built `dist/` artifact.

## Decision

- `master` is the complete development mainline.
- `release` points to the exact commit approved for server deployment.
- The server fetches and checks out `release`, then installs, verifies, builds, and restarts the service.
- Documentation remains in both branches; deployment consumes build output rather than a manually reduced source branch.
- Remote push requires the user's explicit authorization for that operation.

## Consequences

- Promoting a release normally moves `release` to an already verified `master` commit.
- Rollback selects a previously verified commit and rebuilds without deleting runtime data.
- Branch equality is not assumed; it must be checked before each deployment.
- Current remote state is operational data and must be queried, not documented as permanent fact.

## Alternatives Rejected

- Maintain a code-only release branch: creates drift without reducing runtime risk.
- Deploy directly from an arbitrary working tree: weak auditability and rollback behavior.
