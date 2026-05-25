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
- [`RUNBOOK.md`](./RUNBOOK.md) — operator runbook for the phases
  that are live today (1–4) plus the rollback / observation steps
  you'll need when phases 5–6 start touching pricing reads.
- [`task-dag-breakdown.json`](./task-dag-breakdown.json) — leaf-task
  spec for
  `scripts/task-dag breakdown <epic-sha> --spec-file=docs/helios/catalog-market-data/task-dag-breakdown.json`
  once the breakdown subcommand is wired up (see "Open questions" in
  the plan). Each leaf is sized to a single agent-shot of work.

## Status

Phases 1–4 are **live in production**:

- ✅ Phase 1 — schema migration 026 applied; `fuzzy_skus` + `catalog_market_matches` exist.
- ✅ Phase 2 — deterministic scorer at [`helios/src/shared/marketMatch/confidence.ts`](../../../helios/src/shared/marketMatch/confidence.ts).
- ✅ Phase 3 — lazy parse-on-demand backfill via [`upsertFuzzySkusForObservation()`](../../../helios/src/server/db/queries/catalogMarketMatchQueries.ts) (departure from spec — see RUNBOOK.md).
- ✅ Phase 4 — reviewer UI at <https://helios.freshlybaked.us/catalog/market-data>.

Pending: phases 5a–d (pricing cutover), phase 6 (rescore cron + auto-promote).

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
