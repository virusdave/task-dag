# LLM Use Registry

This directory is the compact policy surface for current LLM access in this workspace.

Use it when you need the shortest answer to any of these questions:

- which backends are currently allowed
- which exact model IDs are approved vs limited-trial
- what conditions apply before a model can be used

## Canonical File

- Current registry: [`registry.yaml`](./registry.yaml)

## Status Meanings

- `approved`: normal use is allowed for the documented use cases.
- `approved-with-explicit-user-authorization`: allowed only after explicit user opt-in.
- `limited-trial`: keep usage inside the listed experiment bounds.
- `rejected`: do not reuse for that use case without a new review.
- `retired`: kept for history, not new work.

## Quick Trial Pattern

When a user wants to try a new model or backend, add or update a `limited-trial` entry in `registry.yaml` first, keep the use case narrow, then promote or reject it after evaluation.

```yaml
- id: example.model-or-backend
  backend: some.backend
  status: limited-trial
  allowed_use_cases:
    - one-named-workflow-only
  notes:
    - Compare against the current approved baseline before widening use.
```

## Update Rule

- Edit `registry.yaml` whenever a backend, model, or allowed-use boundary changes.
- If the change is durable, update the matching doc under [`../../docs/private-llm`](../../docs/private-llm) and the root index [`../../HOW_PRIVATE_LLM_ACCESS_WORKS.md`](../../HOW_PRIVATE_LLM_ACCESS_WORKS.md).
- Do not let local LibreChat config, prompt-lab output, or handoff notes become the de facto allowlist.
