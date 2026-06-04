-- One-shot historical TRUNCATE of `catalog_taxonomy_snapshot_rows`.
--
-- Helios DB-cost epic, phase F1 (virusdave/top-level#11). Pairs
-- with the new TTL-prune step in
-- `helios/src/worker/jobs/configWorkersCatalogRefreshJob.ts` that
-- keeps the table bounded going forward (default 24 h retention).
--
-- Why this migration exists:
--   * `catalog_taxonomy_snapshot_rows` had accumulated ~32 million
--     rows / ~15 GB across ~4,263 snapshots taken on a 5-minute
--     daytime / 15-minute overnight cadence over ~29 days. None of
--     those rows are read by application code (verified by grep —
--     only `loadRecentCatalogTaxonomySnapshots` reads from the
--     parent `catalog_taxonomy_snapshots`, never from the rows
--     table).
--   * The new in-job TTL prune handles steady-state retention, but
--     it deletes "rows whose snapshot is older than the window".
--     It will catch up to the historical backlog eventually, but at
--     ~7,500 rows per snapshot and ~200 snapshots/day each prune
--     pass is bounded to deleting only the day's worth of newly-aged
--     rows. Catching up to 32M rows organically would take weeks.
--   * A single TRUNCATE drops all 15 GB in O(1) wall-clock time and
--     immediately returns the storage to TigerData.
--
-- Why this is irreversible (and why that's fine):
--   * The data is purely a "what did the Sweed state catalog look
--     like at time T" write-only audit. No application path reads
--     it.
--   * Fresh snapshots resume immediately after the truncate; the
--     next scheduled refresh (within ≤ 15 min) repopulates the
--     table with the current catalog state.
--   * If, against expectations, some operator workflow ever
--     depended on having historical snapshots, the only recovery
--     is to wait for fresh snapshots to accumulate again under the
--     new 24 h retention window. The parent
--     `catalog_taxonomy_snapshots` summary rows are kept (operator
--     dashboard reads from there).
--
-- Locking:
--   * `TRUNCATE` takes ACCESS EXCLUSIVE on the target table. The
--     only writer is `configWorkersCatalogRefreshJob`, which holds
--     a transaction open for the duration of `persistSnapshotRows`
--     (~5-10 s). With `lock_timeout = '15s'` we will either acquire
--     the lock cleanly between refreshes or fail fast and the
--     operator can retry; we will not block production indefinitely.
--   * No reader path on this table exists, so we will never block
--     a user-facing request.

\set ON_ERROR_STOP on
\timing on

set lock_timeout      = '15s';
set statement_timeout = '1min';

-- Single-statement: TRUNCATE is its own transaction in non-pipelined
-- psql, and explicit BEGIN/COMMIT around it is harmless.
begin;

-- Show the size we're about to release so the migration output
-- captures the win.
select pg_size_pretty(pg_total_relation_size('public.catalog_taxonomy_snapshot_rows'))
  as pre_truncate_total_size;
select count(*) as pre_truncate_row_count
  from public.catalog_taxonomy_snapshot_rows;

truncate table public.catalog_taxonomy_snapshot_rows;

select pg_size_pretty(pg_total_relation_size('public.catalog_taxonomy_snapshot_rows'))
  as post_truncate_total_size;

commit;

-- `VACUUM` cannot run inside a transaction block, hence the bare
-- statement here. ANALYZE-only (without FULL) is enough since the
-- table will refill quickly and we just want the planner stats
-- reset.
vacuum (analyze) public.catalog_taxonomy_snapshot_rows;
