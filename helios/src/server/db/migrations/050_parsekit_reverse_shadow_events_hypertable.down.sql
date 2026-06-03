-- Reverse migration 050 (parsekit_reverse_shadow_events hypertable
-- conversion). This is an OPERATOR RUNBOOK, not an idempotent
-- migration: Timescale has no in-place "un-hypertable" operation, so
-- the only way back is to copy data into a fresh plain table and
-- swap. The script below is safe to run when the table is small
-- (current prod: 3 rows / 80 KB) and locks the table exclusively for
-- the duration of the swap.
--
-- DO NOT run this against a busy production table without first
-- pausing writers (no writer exists today for this table outside the
-- Parsekit shadow code path). If the table has grown large by the
-- time you need to roll back, you almost certainly want a different
-- recovery plan (e.g. pg_dump + restore into a fresh DB) instead of
-- this swap.
--
-- Steps:
--   1. Lock the hypertable.
--   2. Create a plain shadow table with the original schema.
--   3. Copy rows.
--   4. Drop the hypertable + its sequence's ownership link.
--   5. Rename the shadow into place and re-attach the sequence.
--   6. Recreate the original PK (id only) and secondary indexes.

\set ON_ERROR_STOP on
\timing on

set lock_timeout    = '5s';
set statement_timeout = '5min';

begin;

lock table public.parsekit_reverse_shadow_events in access exclusive mode;

create table public.parsekit_reverse_shadow_events__rollback (
  id                      bigint primary key,
  created_at              timestamptz not null default now(),
  kind                    text not null,
  input                   text not null,
  parser_id               text,
  rule_id                 text,
  snapshot_sha            text,
  diff_fields             jsonb,
  parsekit_output         jsonb,
  legacy_output           jsonb,
  parsekit_failure_reason text,
  legacy_error            text
);

insert into public.parsekit_reverse_shadow_events__rollback
select id, created_at, kind, input, parser_id, rule_id, snapshot_sha,
       diff_fields, parsekit_output, legacy_output,
       parsekit_failure_reason, legacy_error
from public.parsekit_reverse_shadow_events;

-- Drop the hypertable; this removes the chunk tables behind it.
alter sequence public.parsekit_reverse_shadow_events_id_seq
  owned by none;

drop table public.parsekit_reverse_shadow_events;

alter table public.parsekit_reverse_shadow_events__rollback
  rename to parsekit_reverse_shadow_events;

alter sequence public.parsekit_reverse_shadow_events_id_seq
  owned by public.parsekit_reverse_shadow_events.id;

alter table public.parsekit_reverse_shadow_events
  alter column id set default nextval('public.parsekit_reverse_shadow_events_id_seq');

-- Restore the original secondary indexes.
create index ix_parsekit_reverse_shadow_events_created_at
  on public.parsekit_reverse_shadow_events using btree (created_at desc);

create index ix_parsekit_reverse_shadow_events_kind_created_at
  on public.parsekit_reverse_shadow_events using btree (kind, created_at desc);

create index ix_parsekit_reverse_shadow_events_parser_id
  on public.parsekit_reverse_shadow_events using btree (parser_id, created_at desc);

-- Re-seat the sequence past the max id so future inserts don't
-- collide.
select setval(
  'public.parsekit_reverse_shadow_events_id_seq',
  coalesce((select max(id) from public.parsekit_reverse_shadow_events), 0),
  true
);

commit;

analyze public.parsekit_reverse_shadow_events;
