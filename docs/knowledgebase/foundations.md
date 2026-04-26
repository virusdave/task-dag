# Knowledgebase Foundations

This workspace knowledgebase is organized to help low-context agents load only the knowledge they need.

## Design Goals

- Minimal initial context use when loading required knowledge.
- Effective log(N)-style discovery through flat and tree indexes.
- Strong discoverability so agents can infer where to look quickly.

## Canonical Structure

The intended layout is:

1. `AGENTS.md` and `AGENTS_MUST_KNOW.md` for cross-workspace rules and operating constraints.
2. Top-level `HOW_<DOMAIN>_WORKS.md` files for short domain entry indexes.
3. `docs/README.md` for the master flat index across canonical domains.
4. `docs/<domain>/README.md` for the domain task map.
5. `docs/<domain>/**/*.md` for narrow workflow, subsystem, or reference docs.

That gives agents two equivalent low-context starting paths:

1. If the domain is obvious, open the matching top-level `HOW_<DOMAIN>_WORKS.md` file.
2. If the domain is unclear, open [`../README.md`](../README.md) and choose the matching domain index.

From there, the agent should usually read only one narrower task doc unless the first one points somewhere else.

## Canonical File Types

### Cross-Workspace Rules

- `AGENTS.md` tells agents how to start work in this workspace.
- `AGENTS_MUST_KNOW.md` holds durable global rules that many tasks need immediately.

### Domain Entry Indexes

- Top-level `HOW_<DOMAIN>_WORKS.md` files exist because workspace guidance can point to them directly.
- They should stay short and predictable.
- Their job is to route the agent into the right `docs/<domain>/README.md` or very small set of narrow docs.

### Master And Domain Indexes

- [`../README.md`](../README.md) is the master map for canonical domains.
- `docs/<domain>/README.md` is the main task map within that domain.
- These indexes should make it obvious what the next read should be.

### Narrow Task Docs

- Narrow docs hold the durable details for one subsystem, workflow, or reference set.
- Durable findings belong here, not only in threads, handoff logs, or generated artifacts.

### Shortcut Aliases

- A task-specific `HOW_*` file is allowed when it materially improves discoverability for a common workflow.
- Those files must say explicitly that they are shortcut aliases rather than the main domain index.
- They should point back to the domain index and the canonical narrow doc.

## Discovery Rules

- Prefer a flat first step and a narrow second step.
- Keep entrypoints consistent enough that file naming communicates what kind of doc it is.
- Avoid making agents scan large narrative docs to decide where to look next.
- If a domain grows large, add one intermediate subsystem doc only when the domain index becomes hard to scan.
