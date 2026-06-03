-- Convert sweed_auth_events to a Timescale hypertable.
--
-- Helios DB-cost epic, phase C1 (virusdave/top-level#11), table 2 of
-- 2 in this session. This is the first real-volume conversion
-- (~167k rows / 81 MB / 17 days of history at apply time). The
-- table is an append-only audit stream behind the Sweed-auth code
-- path; no live customer scan/checkin path reads or writes it, so a
-- brief ACCESS EXCLUSIVE lock during migrate_data is acceptable.
--
-- Pre-checks performed live before writing this file:
--   * pg_extension confirms timescaledb 2.26.4 (outbound FKs from
--     hypertables to regular tables are supported since 2.11).
--   * No incoming FK references this table.
--   * No triggers.
--   * The only uniqueness constraint is the PK on id; modifying it
--     to (id, created_at) does not affect any other table.
--   * Outbound FK: sweed_auth_events.job_id → job_queue.id
--     (ON DELETE SET NULL). Timescale 2.11+ retains this FK on
--     conversion; verified post-apply by re-reading pg_constraint.
--   * select count(*) where created_at is null = 0.
--
-- Decisions:
--   * Time column: created_at.
--   * Chunk interval: 7 days. Current ingest ~10k rows/day
--     ⇒ ~70k rows / ~35 MB per chunk, well under the 25%-of-RAM
--     rule of thumb and large enough to keep chunk count bounded.
--   * PK change: (id) → (id, created_at). Required by Timescale;
--     no callers rely on (id)-only uniqueness because no other table
--     FK-references sweed_auth_events.id.
--   * Compression: NOT enabled in this migration. Compression is
--     intentionally deferred to its own follow-up migration once
--     we've validated the conversion in production for at least one
--     ingest cycle. Keeping the two changes separate means a
--     rollback never has to undo a compression policy first.
--
-- Application impact during apply:
--   * ACCESS EXCLUSIVE LOCK held for the duration of
--     migrate_data ≈ heap_size + index rebuild. At 53 MB heap +
--     28 MB indexes this is a low-single-digit-seconds window.
--   * No live customer scan/checkin code path reads or writes
--     sweed_auth_events; only the Sweed-auth worker pipeline does.
--     Worker writers will retry on transient lock contention via
--     the existing job-queue retry semantics.

\set ON_ERROR_STOP on
\timing on

set lock_timeout    = '10s';
set statement_timeout = '10min';

begin;

lock table public.sweed_auth_events in access exclusive mode;

alter table public.sweed_auth_events
  drop constraint if exists sweed_auth_events_pkey;

alter table public.sweed_auth_events
  add constraint sweed_auth_events_pkey
  primary key (id, created_at);

select create_hypertable(
  'public.sweed_auth_events'::regclass,
  by_range('created_at', interval '7 days'),
  migrate_data => true,
  if_not_exists => true
);

commit;

analyze public.sweed_auth_events;
