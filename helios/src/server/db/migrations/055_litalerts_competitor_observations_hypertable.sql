-- Convert litalerts_competitor_observations to a Timescale hypertable.
--
-- DB-cost epic phase C1 (virusdave/top-level#11), table 3 of 3.
-- Pairs with migration 054 (prep: view exposes next_refresh_at,
-- partial latest-succeeded index, scheduler UPDATEs by
-- (id, captured_at) instead of id alone).
--
-- Pre-checks verified live before writing this file:
--   * timescaledb 2.26.4 (outbound FKs from hypertables to regular
--     tables are supported since 2.11).
--   * No publications include this table (logical replication safe).
--   * No incoming FK references this table.
--   * No triggers.
--   * Only PK uniqueness on (id); reshape to (id, captured_at) is
--     invisible to the rest of the schema since no other table
--     FK-references this table's id.
--   * All three outbound FKs are clean (0 orphan rows for job_id,
--     queue_row_id, source_snapshot_id).
--   * captured_at is NOT NULL for every existing row.
--   * Migration 054 has been applied: partial latest-succeeded
--     index exists and scheduler reads UPDATE by (id, captured_at).
--
-- Decisions per oracle review:
--   * Time column: captured_at.
--   * Chunk interval: 14 days. Rationale (oracle): 7-day chunks
--     are unnecessarily small for this table's write rate and
--     several important queries lack a captured_at predicate, so
--     chunk fan-out matters. 14 days gives ~2–3 chunks now and
--     ~12–13 at 6 months — acceptable steady state without coarse
--     compression granularity.
--   * PK change: (id) → (id, captured_at) as Timescale requires.
--   * Compression: NOT enabled here. Deferred to a follow-up
--     migration once the conversion has been observed clean and
--     we have verified the scheduler does not need to update rows
--     that would have aged into a compressed chunk.
--
-- Deadlock safety during migrate_data:
--   * The three outbound FKs reference job_queue,
--     pending_litalerts_refresh_queue, and stock_snapshots. While
--     `migrate_data` runs, concurrent deletes against those
--     parent tables would race against the FK validation done by
--     Timescale during the chunk creation, potentially deadlocking
--     the migration. We take SHARE ROW EXCLUSIVE on the three
--     referenced tables FIRST (in alphabetical order — picking a
--     deterministic acquisition order avoids cross-migration
--     deadlocks). SHARE ROW EXCLUSIVE blocks concurrent writers
--     to the parents but not concurrent readers; given the
--     migration is bounded by `statement_timeout = 10min` and the
--     target table is 501 MB total / 73k rows, the actual block
--     window is expected to be sub-10 seconds.
--   * lock_timeout = 10s ensures we fail fast rather than block
--     indefinitely if any of the locks is contended at apply time.

\set ON_ERROR_STOP on
\timing on

set lock_timeout      = '10s';
set statement_timeout = '10min';

begin;

-- Lock referenced tables FIRST so concurrent writers cannot wedge
-- migrate_data into a deadlock against an FK validation. Order is
-- alphabetical so any future migration on these tables uses the
-- same acquisition order.
lock table public.job_queue,
           public.pending_litalerts_refresh_queue,
           public.stock_snapshots
  in share row exclusive mode;

lock table public.litalerts_competitor_observations
  in access exclusive mode;

alter table public.litalerts_competitor_observations
  drop constraint if exists litalerts_competitor_observations_pkey;

alter table public.litalerts_competitor_observations
  add constraint litalerts_competitor_observations_pkey
  primary key (id, captured_at);

select create_hypertable(
  'public.litalerts_competitor_observations'::regclass,
  by_range('captured_at', interval '14 days'),
  migrate_data => true,
  if_not_exists => true
);

commit;

analyze public.litalerts_competitor_observations;
