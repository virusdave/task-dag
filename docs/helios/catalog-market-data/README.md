# Catalog ↔ Market Data — design + task-DAG breakdown

Design and planned task-DAG breakdown for issue
[#18](https://github.com/FreshlyBakedNYC/automation/issues/18):
persisted `fuzzy_skus` records, a `catalog_market_matches` verdict
table, a deterministic confidence scorer, a reviewer UI, and a
pricing-run cutover so the pricing pipeline reads verdicts instead of
re-fuzzying competitor evidence on every run.

- [`EPIC_PLAN.md`](./EPIC_PLAN.md) — motivation, current state we are
  replacing, settled requirements lifted from the issue body,
  proposed data model (with concrete SQL), the deterministic scorer
  formula, the reviewer UI sketch, the pricing-run cutover plan,
  open questions, and a phase-by-phase rollout.
- [`task-dag-breakdown.json`](./task-dag-breakdown.json) — leaf-task
  spec for
  `scripts/task-dag breakdown <epic-sha> --spec-file=docs/helios/catalog-market-data/task-dag-breakdown.json`
  once the breakdown subcommand is wired up (see "Open questions" in
  the plan). Each leaf is sized to a single agent-shot of work.

## Status

This directory is **design-only**. No schema migrations, server
routes, worker jobs, or UI have been added yet. Implementation
happens in the leaves enumerated by `task-dag-breakdown.json`, in
the dependency order set there, after operator sign-off on the
plan.

## How this slots into the existing market-data work

The pre-existing [`market-data-sweep`](../market-data-sweep/) epic
fixed *freshness* of `litalerts_competitor_observations` (always
4-day-fresh raw evidence). This epic does **not** change that — it
sits on top, persisting "this raw LitAlerts row maps to this catalog
entry with verdict X" so the pricing pipeline stops re-deriving the
mapping from string heuristics on every run.

Concretely: the current fuzzy mapping lives inline in
[`helios/src/worker/pricing/litAlertsMarket.ts`](../../../helios/src/worker/pricing/litAlertsMarket.ts)
(`brandMatchCache`, `GENERIC_SEARCH_WORDS`, `BRAND_MANUFACTURER_ALIASES`,
`ProductComparableProfile`, etc.). Phase 5 of this plan moves that
match step out of the hot pricing path and into a persisted,
human-curatable verdict surface.
