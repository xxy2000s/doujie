# v0.3.0 release hardening

## Goal

Close the independent-review findings on the v0.3.0 release candidate before
creating the immutable local tag.

## Requirements

- A Codex model installed by runtime reload must apply consistently to default
  Codex chat, project Agent launch defaults, `/digest`, and `/ask` on the next
  request while in-flight requests retain their captured model.
- The release checker and runbook must accurately state that quality gates can
  update ignored build output even though they never mutate tracked files,
  refs, services, or remotes.
- The archived runtime-control-plane task must identify its implementation
  commit and checked acceptance evidence.
- No production daemon restart, remote mutation, push, or credential access.

## Acceptance Criteria

- [x] Pipeline queues capture the request-selected model and do not read a
      later model when the job starts.
- [x] Router `/digest` and `/ask` calls use the immutable request snapshot model.
- [x] Existing callers remain source-compatible when no model override is given.
- [x] Release documentation and checker help describe ignored `dist/` writes.
- [x] Archived task metadata and acceptance boxes reflect existing evidence.
- [x] Focused tests, full release check, isolated preflight, and independent
      review pass before tagging.

## Verification Evidence

- Focused pipeline and Router suites: 100/100 passed.
- Full gates: typecheck, 281/281 tests, build, and diff check passed.
- Independent review found the original model inconsistency and release-check
  contract issue; both English and Chinese contracts were corrected and the
  final re-review reported no release blockers.

## Notes

- This task does not broaden v0.3.0 product scope.
