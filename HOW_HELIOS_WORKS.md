# How Helios Works

This file is the short entry index for Helios knowledge in this workspace.

The goal is to help a new agent quickly determine whether a task now belongs in Helios, which parts are already fully migrated, and which codebase is the canonical place to work without reading a long migration narrative first.

## Start Here

- Full docs index: [`docs/README.md`](./docs/README.md)
- Helios task index: [`docs/helios/README.md`](./docs/helios/README.md)
- Migration and ownership map: [`docs/helios/migration-and-ownership.md`](./docs/helios/migration-and-ownership.md)
- Canonical Helios app: [`bulk_additions/catalog_curation`](./bulk_additions/catalog_curation)

## Canonical Rule

- If a task touches a workflow Helios has already subsumed, work in Helios first instead of extending or reviving a separate bespoke webapp.
- The operator-facing app, shared auth/session flow, job queue, audit history, and dependency-health surfaces now live in Helios.
- Standalone scripts can still be the execution engine behind a Helios worker job, but the operator surface and new orchestration logic should go into Helios unless the user explicitly asks for a non-Helios path.
- Durable migration ownership belongs in [`docs/helios/`](./docs/helios/) docs, not only in handoff logs. Treat [`bulk_additions/catalog_curation/AGENT_TODO.md`](./bulk_additions/catalog_curation/AGENT_TODO.md) as live queue/handoff state rather than the canonical durable reference.

## Load Only What You Need

- Durable migration and ownership guidance: [`docs/helios/migration-and-ownership.md`](./docs/helios/migration-and-ownership.md)
- Current queue or handoff state: [`bulk_additions/catalog_curation/AGENT_TODO.md`](./bulk_additions/catalog_curation/AGENT_TODO.md)
- Underlying screens playbooks and safety rules: [`docs/sweed/marketing/screens-and-banners.md`](./docs/sweed/marketing/screens-and-banners.md)

## Recommended Reading Order For A New Agent

1. [`docs/helios/README.md`](./docs/helios/README.md)
2. [`docs/helios/migration-and-ownership.md`](./docs/helios/migration-and-ownership.md)
3. The one Helios code path or live handoff note that matches the task
