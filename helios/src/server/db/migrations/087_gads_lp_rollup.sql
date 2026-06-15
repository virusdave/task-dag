-- Migration 087: gads_lp_rollup + gads_lp_rollup_refresh_state
--
-- GAds → Landing-pages analytics V1, phase P2 (parent epic
-- virusdave/top-level#18, child FreshlyBakedNYC/automation#47).
-- Authoritative design: docs/epics/gads-landing-analytics/EPIC_PLAN.md
-- (top-level) §3; locked semantics: docs/helios/gads-landing-analytics/
-- P0_AUDIT.md.
--
-- WHY (operator decree / epic #11 DB-cost steer): V1 deliberately does
-- NOT build the heavy pipeline (no per-assignment fact table, no
-- hourly+daily rollup pair, no always-on derivation worker, no CAGGs /
-- hypertable / compression / HLL). Instead `lp_events` (migration 070)
-- stays the append-only source of truth and ONE small day-grain rollup
-- table is recomputed out-of-band by a scheduled worker job
-- (config.workers.gads_lp_rollup_refresh, 60-min cadence). The serving
-- endpoint (P3) reads ONLY this rollup + the refresh-state row, never
-- raw lp_events.
--
-- Grain (parent §3): one row per
--   (assignment_day, site, family, cluster_slug, experiment_id,
--    policy_id, policy_rule_id, branch_id)
-- where assignment_day is the lp_assignment event's date in
-- America/New_York (the Ads business zone, P0 §3). All funnel measures
-- are assignment-level-unique (count(distinct assignment_id)); the
-- refresh dedupes duplicate event posts via that distinct/bool_or
-- aggregation (P0 §5).
--
-- Cost: V1 has NO in-DB GAds cost snapshot (cost lives only as JSONL in
-- ads/google/snapshots/, not loaded into helios). So allocated_cost_micros
-- stays NULL and cost_attribution_status = 'unavailable' — no fake
-- numbers (P0 §2.3 / §5.5). Wiring the offline cost snapshot is a
-- documented V1-remainder follow-up; the columns ship now so no further
-- migration is needed when it lands. Revenue / ROAS are omitted entirely
-- (deferred to V2, no source).
--
-- Idempotent: every create is `if not exists`. Creating the (empty)
-- tables is cheap and reversible (087_gads_lp_rollup.down.sql drops
-- them; the rollup is fully reconstructable from lp_events). lp_events
-- is currently EMPTY in prod, so there is no backfill cost here.

\set ON_ERROR_STOP on
\echo 'Running migration 087: gads_lp_rollup...'

create table if not exists gads_lp_rollup (
  -- Grain (NY-local assignment day + placement/provenance). The
  -- nullable columns mean we cannot use a natural PRIMARY KEY (PK
  -- columns must be NOT NULL); a NULLS NOT DISTINCT unique index below
  -- enforces one row per grain instead (PG15+; prod is PG18).
  assignment_day  date        not null,
  site            text        not null,
  family          text,
  cluster_slug    text,
  experiment_id   text,
  policy_id       text        not null,
  policy_rule_id  text,
  branch_id       text,

  -- Funnel measures (assignment-level unique). conversions_Nd counts an
  -- assignment iff it has an lp_conversion within [assignment_ts,
  -- assignment_ts + N days) — assignment-time attribution, P0 §5.2.
  assignments      integer not null default 0,
  impressions      integer not null default 0,
  redirects        integer not null default 0,
  conversions_7d   integer not null default 0,
  conversions_30d  integer not null default 0,
  conversions_90d  integer not null default 0,

  -- Diagnostic: average served propensity = sum/count (P0 §5).
  sum_served_prob_bps   bigint  not null default 0,
  assignments_with_prob integer not null default 0,

  -- Best-effort allocated GAds cost (badged "allocated"), nullable.
  -- NULL + 'unavailable' in V1 (no in-DB cost snapshot yet).
  allocated_cost_micros   bigint,
  cost_attribution_status text not null default 'unavailable',

  refreshed_at timestamptz not null default now(),

  constraint gads_lp_rollup_cost_attribution_status_check
    check (cost_attribution_status in ('unavailable', 'allocated'))
);

-- One row per grain. NULLS NOT DISTINCT so two rows that differ only by
-- a NULL grain column (e.g. both family IS NULL) collide as intended.
-- The refresh recomputes the horizon with a delete+insert (not ON
-- CONFLICT), so this index is a correctness guardrail, not the upsert
-- target; it also serves the serving-path day/site lookups.
create unique index if not exists gads_lp_rollup_grain_idx
  on gads_lp_rollup (
    assignment_day, site, family, cluster_slug,
    experiment_id, policy_id, policy_rule_id, branch_id
  )
  nulls not distinct;

-- Serving path filters by site then date range; the grain index above
-- is assignment_day-leading, so add a site-leading helper for the
-- per-site / per-scope endpoint (P3).
create index if not exists gads_lp_rollup_site_day_idx
  on gads_lp_rollup (site, assignment_day);

-- Tiny singleton freshness/observability row. The serving endpoint
-- returns freshness from here; the refresh job writes it each run.
create table if not exists gads_lp_rollup_refresh_state (
  -- Single-row guard: always 'singleton'.
  id                text        not null primary key default 'singleton',
  last_started_at   timestamptz,
  last_completed_at timestamptz,
  -- min/max event_ts of the source lp_events rows considered this run.
  source_min_at     timestamptz,
  source_max_at     timestamptz,
  status            text        not null default 'idle',
  error_message     text,
  rows_written      integer     not null default 0,
  updated_at        timestamptz not null default now(),

  constraint gads_lp_rollup_refresh_state_singleton_check
    check (id = 'singleton'),
  constraint gads_lp_rollup_refresh_state_status_check
    check (status in ('idle', 'running', 'ok', 'error'))
);

-- Seed the singleton so the endpoint always has a row to read.
insert into gads_lp_rollup_refresh_state (id, status)
  values ('singleton', 'idle')
  on conflict (id) do nothing;

\echo 'Migration 087 complete.'
