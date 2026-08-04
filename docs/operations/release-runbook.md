# Doujie Release Runbook

Status: Active

This runbook is the source of truth for versioning and releasing Doujie. The release checker enforces deterministic facts; the operator or AI remains responsible for authorization, production judgment, deployment, and rollback.

## Release Model

- `master` is the complete development mainline.
- `release` is the exact commit approved for production deployment.
- `vX.Y.Z` is an immutable annotated tag.
- `CHANGELOG.md` is the durable human-readable release history.
- A GitHub Release is optional presentation metadata; a pushed annotated tag remains the version identity.
- Trellis task QA stores iteration-specific review and E2E evidence.

Use Semantic Versioning:

- major: incompatible behavior or configuration changes;
- minor: backward-compatible product capability;
- patch: backward-compatible fixes, deployment compatibility, or documentation corrections needed by a release.

## Hard Rules

1. Never tag a dirty working tree or an unreviewed commit.
2. Never create the immutable tag before a production-like dependency install, test, and build preflight passes.
3. `package.json`, `CHANGELOG.md`, and the intended tag must use the same version.
4. Use Node 20 and the repository-pinned pnpm version. Put the Node 20 bin directory first in `PATH`; invoking an absolute Corepack path is not sufficient when its shebang resolves another Node.
5. Do not restart while a control turn or Codex child is active.
6. Do not overwrite untracked server files. Inspect and preserve them; move generated conflicts to a timestamped backup only when their provenance is proven.
7. Push, production promotion, restart, and rollback require explicit user authorization.
8. A failed gate stops the release. Do not mark a partial deployment successful.

## Phase 1: Prepare The Release Commit

1. Finish and archive the active Trellis task with redacted QA evidence.
2. Select the version from the compatibility impact.
3. Update `package.json` and add a dated `CHANGELOG.md` section.
4. Ensure `pnpm-workspace.yaml` explicitly authorizes only required lifecycle scripts.
5. Commit the release metadata. Do not tag yet.

The clean release commit must pass:

```bash
pnpm release:check -- --version X.Y.Z
```

This is a non-publishing gate: it does not install dependencies, change tracked
files or Git refs, push, switch branches, or restart a service. Its build phase
may refresh ignored `dist/` output.

Optional read-only server environment inspection:

```bash
pnpm release:check -- --version X.Y.Z --remote seed
```

This remote check does not fetch, install, build, switch branches, or restart.

## Phase 2: Production-Like Preflight

Before tagging, validate the exact release commit in an isolated checkout or temporary server worktree. Do not run the preflight in the live service directory.

Required facts:

```text
Node 20
repository-pinned pnpm
frozen-lockfile install succeeds
native dependencies build successfully
pnpm typecheck passes
pnpm test passes
pnpm build passes
live service remains untouched
```

On Linux, set `PATH` before calling pnpm:

```bash
export PATH=/opt/node20/bin:$PATH
node --version
pnpm --version
CI=true pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Record the commit, runtime versions, test count, build result, and cleanup result in Trellis QA. Remove the isolated checkout only after retaining the evidence needed for rollback.

## Phase 3: Review And Authorization

1. Run an independent code review against the release diff.
2. Scan changed and tracked files for credentials, real Feishu IDs, tokens, private keys, runtime databases, logs, and local configuration.
3. Present the version, commit, changelog summary, preflight evidence, deployment target, and rollback commit to the user.
4. Obtain explicit authorization for the exact push and deployment actions.

## Phase 4: Publish

Create an annotated tag with concise highlights and verification evidence:

```bash
git tag -a vX.Y.Z -m "Doujie vX.Y.Z

Highlights:
- <change>

Verification:
- typecheck passed
- tests passed
- production preflight passed

See CHANGELOG.md for details."
```

Push only the approved refs. The local push guard requires the one-command authorization environment variable:

```bash
DOUJIE_ALLOW_PUSH=1 git push origin master
DOUJIE_ALLOW_PUSH=1 git push origin vX.Y.Z
git branch -f release master
DOUJIE_ALLOW_PUSH=1 git push origin release
```

After publishing:

```bash
pnpm release:check -- --phase published --version X.Y.Z
```

Create the GitHub Release from the matching Changelog section when `gh` is authenticated. Do not expose credentials to automate this step.

## Phase 5: Deploy

Before touching the live directory:

1. confirm no active Codex child or non-terminal control turn;
2. confirm the live branch is `release`;
3. inspect `git status --short` and preserve unrelated files;
4. confirm Node 20 and pinned pnpm resolve from `PATH`;
5. register the previous production commit as the rollback target.

Then fast-forward, install, test, build, and restart from a separate operator shell. Follow [Restart Safety](./runbook.md#restart-safety). Never let the active Doujie turn restart itself.

## Phase 6: Verify

Verify all of the following:

- production HEAD equals `origin/release` and the release tag;
- package version equals the tag;
- daemon is active under the expected user and working directory;
- exactly one event listener exists;
- startup doctor and WebSocket connection succeeded;
- `/status` works;
- a plain Codex smoke reply is exact and contains no `/detail` tool noise;
- expected output transport behavior works;
- no new uncaught errors, duplicate listeners, or leaked identifiers appear in logs.

If user OAuth cannot send a smoke message, report real Feishu E2E as incomplete and request one manual message. A bot self-message is not acceptable evidence.

## Rollback

Rollback is a new authorized deployment action, not an ad hoc reset:

1. identify the last verified tag/commit;
2. prove runtime data and schema compatibility;
3. point `release` to the approved rollback commit;
4. run the same install/test/build gates;
5. restart from an external operator shell;
6. verify daemon, listener, logs, `/status`, and Codex smoke;
7. record the reason and evidence in an incident or release task.

Never use `git reset --hard`, delete runtime data, or kill processes by command name as a rollback shortcut.
