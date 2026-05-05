# How Helios Works

This file is the short entry index for Helios knowledge in this workspace.

The goal is to help a new agent quickly determine whether a task now belongs in Helios, which parts are already fully migrated, and which codebase is the canonical place to work without reading a long migration narrative first.

## Start Here

- Full docs index: [`docs/README.md`](./docs/README.md)
- Helios task index: [`docs/helios/README.md`](./docs/helios/README.md)
- Migration and ownership map: [`docs/helios/migration-and-ownership.md`](./docs/helios/migration-and-ownership.md)
- Canonical Helios app: [`helios`](./helios)

## Canonical Rule

- If a task touches a workflow Helios has already subsumed, work in Helios first instead of extending or reviving a separate bespoke webapp.
- The operator-facing app, shared auth/session flow, job queue, audit history, and dependency-health surfaces now live in Helios.
- Standalone scripts can still be the execution engine behind a Helios worker job, but the operator surface and new orchestration logic should go into Helios unless the user explicitly asks for a non-Helios path.
- Durable migration ownership belongs in [`docs/helios/`](./docs/helios/) docs, not only in handoff logs. Treat [`helios/AGENT_TODO.md`](./helios/AGENT_TODO.md) as live queue/handoff state rather than the canonical durable reference.
- Helios has exactly one primary navigation surface (the left-hand `PrimarySidebar` rendered with the canonical `TreeNav`). Do not add per-page nav rails, second sidebars, or packet-internal nav strips. See [`docs/helios/ui-standards.md`](./docs/helios/ui-standards.md) for the full rule set.

## Load Only What You Need

- Durable UI standards (one nav pane to rule them all, leaf/branch row sizing, reviewer-page completeness rules): [`docs/helios/ui-standards.md`](./docs/helios/ui-standards.md)
- Durable migration and ownership guidance: [`docs/helios/migration-and-ownership.md`](./docs/helios/migration-and-ownership.md)
- Repricing module planning proposal and reviewer workflow: [`docs/helios/pricing-repricing-module-proposal.md`](./docs/helios/pricing-repricing-module-proposal.md)
- Active pricing-module implementation now lives in `helios/src/client/routes/pricing/`, `src/server/routes/pricing.ts`, `src/server/db/queries/pricingQueries.ts`, and `src/worker/pricing/`
- Active Config-module background workers (Stock, Litalerts, Catalog) and their Workers > Scheduling editor pages live in `helios/src/worker/jobs/configWorkers*.ts`, `src/worker/runtime/configWorkersScheduler.ts`, `src/server/routes/config.ts`, and `src/client/routes/config/Config*SchedulePage.tsx`
- Current pricing foundations already include the `midtownEverReceived` historical scope, explicit `keep-price` review rows, and bounded Lit Alerts search adaptation for thin-comp repricing cases
- Current queue or handoff state: [`helios/AGENT_TODO.md`](./helios/AGENT_TODO.md)
- Underlying screens playbooks and safety rules: [`docs/sweed/marketing/screens-and-banners.md`](./docs/sweed/marketing/screens-and-banners.md)

## Recommended Reading Order For A New Agent

1. [`docs/helios/README.md`](./docs/helios/README.md)
2. [`docs/helios/migration-and-ownership.md`](./docs/helios/migration-and-ownership.md)
3. The one Helios code path or live handoff note that matches the task
