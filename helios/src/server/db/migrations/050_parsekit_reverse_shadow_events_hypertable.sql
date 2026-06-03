-- Convert parsekit_reverse_shadow_events to a Timescale hypertable.
--
-- Helios DB-cost epic, phase C1 (virusdave/top-level#11), table 1 of 2 in
-- this session. This table is empty-ish in production (~3 rows / 80 KB)
-- and has neither incoming nor outgoing FK constraints. It serves as a
-- low-risk validator of the hypertable conversion pattern, the
-- pendingMigrations sentinel mechanism for hypertables, and the
-- table-copy rollback drill in 050_DOWN.
--
-- Decisions:
--   * Time column: created_at (only timestamptz on the table; matches
--     every existing index's leading-after-tag column).
--   * Chunk interval: 7 days (diagnostic / low-write table).
--   * PK change: (id) -> (id, created_at). Timescale requires every
--     UNIQUE/PRIMARY KEY index on a hypertable to include the
--     partition column. No other table FK-references this PK, so the
--     uniqueness semantics change (id alone is no longer
--     database-enforced unique) is invisible to the rest of the
--     schema. Sequence-generated ids remain practically unique.
--   * Compression: NOT enabled in this migration. Compression for
--     parsekit would be net-neutral at current volume; see
--     050_DOWN for a future re-enable pattern when meaningful.
--
-- Pre-checks performed live before writing this file:
--   * pg_extension confirms timescaledb 2.26.4 + toolkit 1.22.0.
--   * timescaledb_information.hypertables shows no existing
--     hypertable named parsekit_reverse_shadow_events.
--   * No incoming FK references this table (pg_constraint where
--     confrelid = ...::regclass returned 0 rows).
--   * select count(*) where created_at is null = 0 (verified by
--     `count(*) = 3` matching `min(created_at)` / `max(created_at)`).
--   * pg_dump --schema-only of this table captured to
--     /tmp/parsekit_reverse_shadow_events_pre_timescale_schema.sql
--     before applying.
--
-- Idempotent guard via `if_not_exists`/`if_exists` clauses; safe to
-- re-run.

\set ON_ERROR_STOP on
\timing on

set lock_timeout    = '5s';
set statement_timeout = '5min';

begin;

lock table public.parsekit_reverse_shadow_events in access exclusive mode;

-- Drop the existing single-column PK and re-add it with created_at
-- so the hypertable conversion below accepts the table. Existing
-- secondary indexes (created_at, (kind, created_at), (parser_id,
-- created_at)) all already include the time column and survive
-- conversion as-is.
alter table public.parsekit_reverse_shadow_events
  drop constraint if exists parsekit_reverse_shadow_events_pkey;

alter table public.parsekit_reverse_shadow_events
  add constraint parsekit_reverse_shadow_events_pkey
  primary key (id, created_at);

select create_hypertable(
  'public.parsekit_reverse_shadow_events'::regclass,
  by_range('created_at', interval '7 days'),
  migrate_data => true,
  if_not_exists => true
);

commit;

analyze public.parsekit_reverse_shadow_events;
