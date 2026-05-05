# Helios Docs

Use this index to decide whether a workflow belongs in Helios and to find the current durable ownership guidance.

## Read This First

- If Helios already owns the operator-facing workflow, work there first instead of extending a separate bespoke surface.
- Keep durable migration and ownership rules in `docs/helios/`, not only in `AGENT_TODO.md`.
- Treat `helios/AGENT_TODO.md` as live queue or handoff state, not the canonical durable reference.

## Task Map

- Current migration boundaries, owned surfaces, and not-yet-migrated areas: [`migration-and-ownership.md`](./migration-and-ownership.md)
- Durable UI standards (one nav pane to rule them all, leaf/branch row sizing, reviewer-page completeness rules): [`ui-standards.md`](./ui-standards.md)
- Repricing module planning proposal plus current implemented foundations for Midtown historical repricing: [`pricing-repricing-module-proposal.md`](./pricing-repricing-module-proposal.md)
- Active pricing-module foundation in Helios: pricing routes now live under `/pricing/review`, `/pricing/generate`, `/pricing/runs`, and `/pricing/runs/:proposalBatchId`, backed by `src/client/routes/pricing/`, `src/server/routes/pricing.ts`, `src/server/db/queries/pricingQueries.ts`, and `src/worker/pricing/`
- Current pricing implementation already supports the `midtownEverReceived` historical scope, explicit keep-price review rows, and bounded Mantle search adaptation when Lit Alerts evidence is too thin

## Suggested Reading Order For New Agents

1. [`migration-and-ownership.md`](./migration-and-ownership.md)
2. [`pricing-repricing-module-proposal.md`](./pricing-repricing-module-proposal.md) when the task touches pricing or repricing UX
3. The one Helios code path or live handoff note that matches the task
