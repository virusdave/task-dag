# P2 — Rollup storage + idempotent refresh job

> Child epic [FreshlyBakedNYC/automation#47](https://github.com/FreshlyBakedNYC/automation/issues/47),
> owning child of [virusdave/top-level#18](https://github.com/virusdave/top-level/issues/18).
> Authoritative design: `docs/epics/gads-landing-analytics/EPIC_PLAN.md` §3
> in `virusdave/top-level`. Locked semantics: [`P0_AUDIT.md`](./P0_AUDIT.md).

Implements the cheap, out-of-band rollup the operator decreed (one small
table refreshed on a schedule; no per-assignment fact table, no
hourly+daily pair, no always-on worker, no CAGGs / hypertable /
compression / HLL).

## What shipped

- **Migration `087_gads_lp_rollup.sql`** (+ `.down.sql`):
  - `gads_lp_rollup` — day-grain rollup. Grain (parent §3):
    `(assignment_day, site, family, cluster_slug, experiment_id,
    policy_id, policy_rule_id, branch_id)`. Measures: `assignments`,
    `impressions`, `redirects`, `conversions_7d/30d/90d`,
    `sum_served_prob_bps`, `assignments_with_prob`,
    `allocated_cost_micros` (nullable), `cost_attribution_status`.
    A `NULLS NOT DISTINCT` unique index enforces one row per grain
    (the grain has nullable columns, so a natural PK is impossible); a
    `(site, assignment_day)` index serves the per-scope serving path.
  - `gads_lp_rollup_refresh_state` — singleton freshness row
    (`last_started_at`, `last_completed_at`, `source_min_at`,
    `source_max_at`, `status`, `error_message`, `rows_written`).
- **Refresh helper** `helios/src/server/db/queries/gadsLpRollupQueries.ts`
  — the idempotent bounded-90-day recompute (delete + re-insert of the
  horizon in one advisory-locked transaction), plus the refresh-state
  read/write helpers.
- **Worker job** `config.workers.gads_lp_rollup_refresh`
  (`helios/src/worker/jobs/refreshGadsLpRollupJob.ts`), scheduled
  **every 60 minutes** (P0 §6) via the config-workers scheduler.
- **Paid-traffic predicate** `helios/src/shared/domain/gadsTraffic.ts`
  (`isPaidGadsTraffic`) + `gadsTraffic.test.ts` encoding the P0 §2.2
  truth table verbatim. Its SQL mirror (`GADS_PAID_TRAFFIC_SQL`) lives
  in the query helper and is kept in lock-step.

## Locked semantics encoded (P0 §5)

- Funnel counts are **assignment-level-unique**: the anchor CTE picks
  the true earliest `lp_assignment` per `assignment_id` (`distinct on`,
  tie-break by `id`); `bool_or` over outcome events collapses duplicate
  posts. Verified against an ephemeral Postgres: two duplicate
  impression posts for one assignment count once.
- `assignment_day` is the anchor event's date in **America/New_York**.
- `conversions_Nd` counts an assignment iff it has an `lp_conversion` in
  the **half-open** window `[assignment_ts, assignment_ts + N days)`.
  The lower bound excludes a pre-assignment conversion sharing the
  `assignment_id` (verified).
- **Bounded horizon**: each run recomputes only `assignment_day >=
  today_ny - 90`, leaving older "frozen" rows untouched. Late
  conversions for cohorts still inside the horizon correctly update
  their older bucket (verified); conversions for cohorts aged past the
  horizon are intentionally not recomputed (the operator's decree /
  epic #11).
- **Idempotent**: re-running the refresh any number of times yields a
  byte-stable rollup (verified).

## Cost is deliberately "unavailable" in V1

There is **no in-DB GAds cost snapshot** — cost lives only as JSONL in
`ads/google/snapshots/`, never loaded into helios. So
`allocated_cost_micros` is `NULL` and `cost_attribution_status =
'unavailable'`. No fake numbers (P0 §2.3 / §5.5). Revenue / ROAS are
omitted entirely (deferred to V2, no source). The columns ship now so
**wiring the offline cost snapshot needs no further migration** — that
allocation (allocated cost summing back to the snapshot total per
day/site/campaign bucket) is the remaining cost slice of this child
epic, blocked on a cost-snapshot source landing in the helios DB.

## EXPLAIN / index decision (P0 §4 deferral resolved)

`lp_events` is **empty in prod**, so a realistic-volume EXPLAIN is not
meaningful yet (re-run when data accrues, per P0 §1.4). On a synthetic
fixture the refresh plan uses the **existing** indexes:
`lp_events_type_ts_idx` for the anchor scan (`event_type =
'lp_assignment'`) and the partial `lp_events_assignment_idx` for the
outcome-event join. So **no new `lp_events` index is added** — the P0 §4
candidate partial index stays deferred unless a real-volume EXPLAIN
later shows the refresh seq-scanning a large table.

## Operator note

Migration `087_gads_lp_rollup.sql` is applied **manually** (helios has
no boot-time migration runner; the pending-migration banner surfaces it
via `pendingMigrations.ts`). Apply it before/around the deploy:

```sh
psql "$DATABASE_URL" -f helios/src/server/db/migrations/087_gads_lp_rollup.sql
```

Inspect the last refresh:

```sql
select * from gads_lp_rollup_refresh_state;
```

Force a one-off rebuild: enqueue `config.workers.gads_lp_rollup_refresh`
with `{"trigger":"manual_run"}` (optionally `"horizonDays": N`).
