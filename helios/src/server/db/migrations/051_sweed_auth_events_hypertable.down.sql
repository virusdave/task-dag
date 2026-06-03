-- Reverse migration 051 (sweed_auth_events hypertable conversion).
-- OPERATOR RUNBOOK — see the same notes on
-- 050_parsekit_reverse_shadow_events_hypertable.down.sql.
--
-- This rollback IS practical at current volume (~167k rows / 81 MB)
-- but it holds ACCESS EXCLUSIVE for the duration of the copy and
-- index rebuild. Estimate ~10-30 seconds with the table cached.
--
-- Steps mirror 050.down: shadow table, copy, drop, rename, restore
-- indexes and FK, re-seat sequence.

\set ON_ERROR_STOP on
\timing on

set lock_timeout      = '15s';
set statement_timeout = '15min';

begin;

lock table public.sweed_auth_events in access exclusive mode;

create table public.sweed_auth_events__rollback (
  id                bigint primary key,
  created_at        timestamptz not null default now(),
  job_id            bigint,
  job_type          text,
  rpc_name          text not null,
  event_kind        text not null,
  session_origin    text,
  auth_token_prefix text,
  dealer_id         bigint,
  outcome           text not null,
  http_status       integer,
  error_message     text,
  duration_ms       integer not null,
  context_json      jsonb not null default '{}'::jsonb,
  constraint sweed_auth_events_outcome_check
    check (outcome = any (array['ok'::text, 'error'::text, 'retryable'::text]))
);

insert into public.sweed_auth_events__rollback
select id, created_at, job_id, job_type, rpc_name, event_kind,
       session_origin, auth_token_prefix, dealer_id, outcome,
       http_status, error_message, duration_ms, context_json
from public.sweed_auth_events;

alter sequence public.sweed_auth_events_id_seq owned by none;

drop table public.sweed_auth_events;

alter table public.sweed_auth_events__rollback
  rename to sweed_auth_events;

alter sequence public.sweed_auth_events_id_seq
  owned by public.sweed_auth_events.id;

alter table public.sweed_auth_events
  alter column id set default nextval('public.sweed_auth_events_id_seq');

-- Restore the original FK to job_queue.
alter table public.sweed_auth_events
  add constraint sweed_auth_events_job_id_fkey
  foreign key (job_id) references public.job_queue(id) on delete set null;

-- Restore the original secondary indexes.
create index sweed_auth_events_created_at_desc_idx
  on public.sweed_auth_events using btree (created_at desc);

create index sweed_auth_events_job_id_idx
  on public.sweed_auth_events using btree (job_id, created_at desc)
  where job_id is not null;

create index sweed_auth_events_outcome_idx
  on public.sweed_auth_events using btree (outcome, created_at desc)
  where outcome <> 'ok';

create index sweed_auth_events_token_prefix_idx
  on public.sweed_auth_events using btree (auth_token_prefix, created_at desc)
  where auth_token_prefix is not null;

-- Re-seat the sequence past max(id).
select setval(
  'public.sweed_auth_events_id_seq',
  coalesce((select max(id) from public.sweed_auth_events), 0),
  true
);

commit;

analyze public.sweed_auth_events;
