-- Migration 102: pending-purchase refinement lineage + REPL contracts
--
-- FreshlyBakedNYC/automation#70. This is the schema-only leaf for the
-- accepted pending-purchase packet REPL design:
--   docs/helios/pending-purchase-repl-design.md
--
-- WHAT this builds
-- ───────────────────────────────────────────────────────────────────────
-- - packet roots with a current-revision pointer and monotonic root version;
-- - packet revision metadata (current/candidate/superseded/failed + applyable);
-- - refinement turns/history with target revision, row snapshot hash, job/model
--   provenance, and candidate packet linkage;
-- - stable row lineage columns so copied candidate rows can be diffed and
--   patched by lineage rather than transient row ids.
--
-- WHAT this deliberately does NOT enable
-- ───────────────────────────────────────────────────────────────────────
-- No route, worker, UI, LLM refinement, candidate acceptance, rollback, or live
-- Sweed write behavior is enabled here. The existing apply path continues to
-- use the legacy packet/row columns until later leaves add persistence logic
-- and server-side apply gating.
--
-- Compatibility / deploy ordering
-- ───────────────────────────────
-- The live schema differs from the original 007 schema include; this migration
-- was authored against the deployed shape (pending_purchase_packets.id,
-- pending_purchase_rows.raw_row_json/version/last_apply_status/etc.). It is an
-- ADDITIVE / EXPAND change: old code may continue creating unrooted legacy
-- packets/rows after this lands because root/lineage columns are nullable until
-- the later writer leaf populates them. Existing packets are backfilled into
-- one root per packet so history screens can start from a coherent baseline.
--
-- DB-cost note (canon §3)
-- ───────────────────────
-- Current production size at design time was tiny (~70 packets, ~945 rows), so
-- the guarded backfills are sub-second. Future steady-state writes are
-- operator/job-triggered refinement turns only (not scheduled/background). The
-- indexes below cover root history, current revision lookup, one active turn per
-- root, and lineage diffs; no unbounded JSON scan or recurring workload is
-- introduced.
--
-- Idempotent: guarded CREATE/ALTER/INSERT/UPDATE statements; safe to re-run.
-- Does NOT auto-apply on deploy. Production application still requires Oracle
-- migration blessing + explicit operator approval for migration 102.

\set ON_ERROR_STOP on
\timing on

\echo 'Running migration 102: pending-purchase refinement lineage...'

begin;
set local lock_timeout = '5s';

-- ── Packet roots: one lineage tree of packet revisions ─────────────────
create table if not exists pending_purchase_packet_roots (
  id                         bigserial primary key,
  root_key                   text not null unique,
  source_packet_id           bigint not null unique,
  current_packet_id          bigint,
  current_revision_number    integer,
  root_status                text not null default 'active',
  version                    integer not null default 1,
  created_by_user_id         bigint,
  current_updated_by_user_id bigint,
  current_updated_at         timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint pending_purchase_packet_roots_root_key_check
    check (root_key ~ '^pprroot_[0-9]+$'),
  constraint pending_purchase_packet_roots_status_check
    check (root_status in ('active', 'superseded', 'archived')),
  constraint pending_purchase_packet_roots_version_positive_check
    check (version > 0),
  constraint pending_purchase_packet_roots_current_pair_check
    check (
      (current_packet_id is null and current_revision_number is null)
      or (current_packet_id is not null and current_revision_number is not null)
    ),
  constraint pending_purchase_packet_roots_active_has_current_check
    check (root_status <> 'active' or current_packet_id is not null),
  constraint pending_purchase_packet_roots_current_revision_positive_check
    check (current_revision_number is null or current_revision_number > 0),
  constraint pending_purchase_packet_roots_source_packet_id_fkey
    foreign key (source_packet_id) references pending_purchase_packets (id),
  constraint pending_purchase_packet_roots_current_packet_id_fkey
    foreign key (current_packet_id) references pending_purchase_packets (id),
  constraint pending_purchase_packet_roots_created_by_user_id_fkey
    foreign key (created_by_user_id) references users (id),
  constraint pending_purchase_packet_roots_current_updated_by_user_id_fkey
    foreign key (current_updated_by_user_id) references users (id)
);

-- ── Packet revision columns ───────────────────────────────────────────
alter table pending_purchase_packets
  add column if not exists packet_root_id bigint,
  add column if not exists revision_number integer,
  add column if not exists revision_status text not null default 'current',
  add column if not exists is_applyable boolean not null default true,
  add column if not exists parent_packet_id bigint,
  add column if not exists source_refinement_turn_id bigint,
  add column if not exists revision_created_reason text,
  add column if not exists accepted_at timestamptz,
  add column if not exists accepted_by_user_id bigint;

alter table pending_purchase_packets
  drop constraint if exists pending_purchase_packets_revision_status_check,
  add constraint pending_purchase_packets_revision_status_check
    check (revision_status in ('current', 'candidate', 'superseded', 'failed'));

alter table pending_purchase_packets
  drop constraint if exists pending_purchase_packets_revision_number_positive_check,
  add constraint pending_purchase_packets_revision_number_positive_check
    check (revision_number is null or revision_number > 0);

alter table pending_purchase_packets
  drop constraint if exists pending_purchase_packets_root_revision_pair_check,
  add constraint pending_purchase_packets_root_revision_pair_check
    check (
      (packet_root_id is null and revision_number is null)
      or (packet_root_id is not null and revision_number is not null)
    );

alter table pending_purchase_packets
  drop constraint if exists pending_purchase_packets_applyable_revision_check,
  add constraint pending_purchase_packets_applyable_revision_check
    check (
      packet_root_id is null
      or (
        (revision_status = 'current' and is_applyable)
        or (revision_status <> 'current' and not is_applyable)
      )
    );

alter table pending_purchase_packets
  drop constraint if exists pending_purchase_packets_packet_root_id_fkey,
  add constraint pending_purchase_packets_packet_root_id_fkey
    foreign key (packet_root_id) references pending_purchase_packet_roots (id);

alter table pending_purchase_packets
  drop constraint if exists pending_purchase_packets_parent_packet_id_fkey,
  add constraint pending_purchase_packets_parent_packet_id_fkey
    foreign key (parent_packet_id) references pending_purchase_packets (id);

alter table pending_purchase_packets
  drop constraint if exists pending_purchase_packets_accepted_by_user_id_fkey,
  add constraint pending_purchase_packets_accepted_by_user_id_fkey
    foreign key (accepted_by_user_id) references users (id);

-- Backfill one root per existing packet. Old superseded packet archives remain
-- non-applyable roots with no current pointer; ready packets become current rev 1.
insert into pending_purchase_packet_roots (
  root_key,
  source_packet_id,
  current_packet_id,
  current_revision_number,
  root_status,
  created_by_user_id,
  current_updated_at,
  created_at,
  updated_at
)
select
  'pprroot_' || p.id::text,
  p.id,
  case when p.status = 'ready' then p.id else null end,
  case when p.status = 'ready' then 1 else null end,
  case when p.status = 'ready' then 'active' else 'superseded' end,
  p.created_by_user_id,
  case when p.status = 'ready' then coalesce(p.updated_at, p.created_at, now()) else null end,
  coalesce(p.created_at, now()),
  coalesce(p.updated_at, p.created_at, now())
from pending_purchase_packets p
where not exists (
  select 1
  from pending_purchase_packet_roots r
  where r.source_packet_id = p.id
);

update pending_purchase_packets p
set
  packet_root_id = r.id,
  revision_number = 1,
  revision_status = case when p.status = 'ready' then 'current' else 'superseded' end,
  is_applyable = (p.status = 'ready'),
  accepted_at = case when p.status = 'ready' then coalesce(p.generated_at, p.created_at, now()) else p.accepted_at end
from pending_purchase_packet_roots r
where r.source_packet_id = p.id
  and (p.packet_root_id is null or p.revision_number is null);

-- ── Refinement turns / history ────────────────────────────────────────
create table if not exists pending_purchase_refinement_turns (
  id                         bigserial primary key,
  packet_root_id             bigint not null,
  target_packet_id           bigint not null,
  target_revision_number     integer not null,
  target_root_version        integer not null,
  status                     text not null default 'queued',
  job_id                     bigint,
  requested_by_user_id       bigint,
  feedback_text              text not null,
  feedback_sha256            text,
  row_snapshot_sha256        text not null,
  row_snapshot_json          jsonb not null default '{}'::jsonb,
  prompt_context_json        jsonb not null default '{}'::jsonb,
  model                      text,
  prompt_version             text,
  candidate_packet_id        bigint,
  error_message              text,
  created_at                 timestamptz not null default now(),
  started_at                 timestamptz,
  finished_at                timestamptz,
  updated_at                 timestamptz not null default now(),

  constraint pending_purchase_refinement_turns_status_check
    check (status in ('queued', 'running', 'candidate_created', 'failed', 'cancelled')),
  constraint pp_refinement_turns_target_revision_positive_check
    check (target_revision_number > 0),
  constraint pp_refinement_turns_target_root_version_positive_check
    check (target_root_version > 0),
  constraint pending_purchase_refinement_turns_feedback_nonempty_check
    check (btrim(feedback_text) <> ''),
  constraint pending_purchase_refinement_turns_feedback_size_check
    check (octet_length(feedback_text) <= 20000),
  constraint pending_purchase_refinement_turns_feedback_sha256_check
    check (feedback_sha256 is null or feedback_sha256 ~ '^[0-9a-f]{64}$'),
  constraint pending_purchase_refinement_turns_row_snapshot_sha256_check
    check (row_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  constraint pending_purchase_refinement_turns_row_snapshot_size_check
    check (octet_length(row_snapshot_json::text) <= 1048576),
  constraint pending_purchase_refinement_turns_prompt_context_size_check
    check (octet_length(prompt_context_json::text) <= 1048576),
  constraint pending_purchase_refinement_turns_packet_root_id_fkey
    foreign key (packet_root_id) references pending_purchase_packet_roots (id),
  constraint pending_purchase_refinement_turns_target_packet_id_fkey
    foreign key (target_packet_id) references pending_purchase_packets (id),
  constraint pending_purchase_refinement_turns_candidate_packet_id_fkey
    foreign key (candidate_packet_id) references pending_purchase_packets (id),
  constraint pending_purchase_refinement_turns_job_id_fkey
    foreign key (job_id) references job_queue (id),
  constraint pending_purchase_refinement_turns_requested_by_user_id_fkey
    foreign key (requested_by_user_id) references users (id)
);

alter table pending_purchase_packets
  drop constraint if exists pending_purchase_packets_source_refinement_turn_id_fkey,
  add constraint pending_purchase_packets_source_refinement_turn_id_fkey
    foreign key (source_refinement_turn_id) references pending_purchase_refinement_turns (id);

-- ── Row lineage / snapshot fields ─────────────────────────────────────
alter table pending_purchase_rows
  add column if not exists row_lineage_id text,
  add column if not exists parent_row_id bigint,
  add column if not exists parent_packet_id bigint,
  add column if not exists source_refinement_turn_id bigint,
  add column if not exists lineage_revision_number integer not null default 1,
  add column if not exists row_snapshot_sha256 text,
  add column if not exists refinement_provenance_json jsonb not null default '{}'::jsonb;

update pending_purchase_rows
set row_lineage_id = 'pprline_' || id::text
where row_lineage_id is null;

alter table pending_purchase_rows
  drop constraint if exists pending_purchase_rows_row_lineage_id_check,
  add constraint pending_purchase_rows_row_lineage_id_check
    check (row_lineage_id is null or btrim(row_lineage_id) <> '');

alter table pending_purchase_rows
  drop constraint if exists pending_purchase_rows_lineage_revision_positive_check,
  add constraint pending_purchase_rows_lineage_revision_positive_check
    check (lineage_revision_number > 0);

alter table pending_purchase_rows
  drop constraint if exists pending_purchase_rows_row_snapshot_sha256_check,
  add constraint pending_purchase_rows_row_snapshot_sha256_check
    check (row_snapshot_sha256 is null or row_snapshot_sha256 ~ '^[0-9a-f]{64}$');

alter table pending_purchase_rows
  drop constraint if exists pending_purchase_rows_refinement_provenance_size_check,
  add constraint pending_purchase_rows_refinement_provenance_size_check
    check (octet_length(refinement_provenance_json::text) <= 262144);

alter table pending_purchase_rows
  drop constraint if exists pending_purchase_rows_parent_row_id_fkey,
  add constraint pending_purchase_rows_parent_row_id_fkey
    foreign key (parent_row_id) references pending_purchase_rows (id);

alter table pending_purchase_rows
  drop constraint if exists pending_purchase_rows_parent_packet_id_fkey,
  add constraint pending_purchase_rows_parent_packet_id_fkey
    foreign key (parent_packet_id) references pending_purchase_packets (id);

alter table pending_purchase_rows
  drop constraint if exists pending_purchase_rows_source_refinement_turn_id_fkey,
  add constraint pending_purchase_rows_source_refinement_turn_id_fkey
    foreign key (source_refinement_turn_id) references pending_purchase_refinement_turns (id);

-- ── Lookup / invariant indexes ────────────────────────────────────────
create unique index if not exists pending_purchase_packets_root_revision_unique
  on pending_purchase_packets (packet_root_id, revision_number)
  where packet_root_id is not null;

create unique index if not exists pending_purchase_packets_one_current_per_root_idx
  on pending_purchase_packets (packet_root_id)
  where packet_root_id is not null and revision_status = 'current';

create index if not exists pending_purchase_packets_root_created_idx
  on pending_purchase_packets (packet_root_id, created_at desc, id desc)
  where packet_root_id is not null;

create index if not exists pending_purchase_packet_roots_current_packet_idx
  on pending_purchase_packet_roots (current_packet_id)
  where current_packet_id is not null;

create index if not exists pending_purchase_refinement_turns_root_created_idx
  on pending_purchase_refinement_turns (packet_root_id, created_at desc, id desc);

create unique index if not exists pending_purchase_refinement_turns_one_active_idx
  on pending_purchase_refinement_turns (packet_root_id)
  where status in ('queued', 'running');

create index if not exists pending_purchase_rows_lineage_packet_idx
  on pending_purchase_rows (row_lineage_id, packet_id, id)
  where row_lineage_id is not null;

create index if not exists pending_purchase_rows_parent_row_idx
  on pending_purchase_rows (parent_row_id)
  where parent_row_id is not null;

commit;

\echo 'Migration 102 complete.'
