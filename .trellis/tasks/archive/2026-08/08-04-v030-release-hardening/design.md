# v0.3.0 Release Hardening Design

## Model flow

```text
RuntimeConfigSnapshot.codex.model
  -> Router request
  -> AIPipeline.process(text, model) / AnswerPipeline.answer(text, model)
  -> queued job captures model
  -> processor(text, capturedModel)
```

Pipeline constructors retain the startup model as a compatibility fallback.
Each queued digest job stores its selected model so a later reload cannot alter
an already accepted request.

## Release contract

`release:check` remains a non-publishing local gate. It does not modify tracked
files, Git refs, services, or remotes. Its build phase may refresh ignored
`dist/`, so documentation must not call the entire command filesystem-read-only.

## Audit repair

The archived M2 task records `e502e38` as the feature implementation commit and
checks acceptance items whose evidence is already present in `implement.md`.
No historical test result or E2E claim is invented.

## Rollback

Before tagging, the hardening commit can be reverted normally. No schema,
runtime config, database, or daemon change is involved.
