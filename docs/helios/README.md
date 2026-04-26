# Helios Docs

Use this index to decide whether a workflow belongs in Helios and to find the current durable ownership guidance.

## Read This First

- If Helios already owns the operator-facing workflow, work there first instead of extending a separate bespoke surface.
- Keep durable migration and ownership rules in `docs/helios/`, not only in `AGENT_TODO.md`.
- Treat `bulk_additions/catalog_curation/AGENT_TODO.md` as live queue or handoff state, not the canonical durable reference.

## Task Map

- Current migration boundaries, owned surfaces, and not-yet-migrated areas: [`migration-and-ownership.md`](./migration-and-ownership.md)

## Suggested Reading Order For New Agents

1. [`migration-and-ownership.md`](./migration-and-ownership.md)
2. The one Helios code path or live handoff note that matches the task
