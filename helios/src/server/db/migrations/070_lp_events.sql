-- Migration 070: lp_events
--
-- Unified-landing-engine conversion-feedback sink (parent epic
-- virusdave/top-level#13, child epic FreshlyBakedNYC/automation#42,
-- phase P1).
--
-- Append-only event log written by the mostly-static-sites landing
-- runtime's durable spool + 15-minute batch flusher. The runtime
-- POSTs batches of impression / redirect / assignment / conversion
-- events to Helios at:
--
--   POST /v1/lp-events/batch   (helios/src/server/routes/lpEvents.ts)
--
-- authenticated with a long-lived bearer token
-- (LP_EVENTS_INGEST_TOKEN), validated against the frozen
-- `freshlybaked.lp.events-batch.v1` contract
-- (config/landing-pages/schemas/lp-events-batch.schema.json, mirrored
-- in helios/src/server/lp/contracts.ts).
--
-- Every event carries the `assignment_id` / `bundle_id` / `policy_id`
-- provenance the migration plan (parent §9, §11) requires so the
-- shadow-compare parity dashboard and the conversion loop can join
-- selections to outcomes.
--
-- Idempotency: the runtime assigns a stable `event_id` per event and
-- may re-send a batch if a flush is interrupted mid-ack. The unique
-- index on `event_id` + `insert ... on conflict do nothing` collapses
-- a re-delivered event to one row (mirrors the visitor_scans
-- (provider, hash_id) idempotency pattern).
--
-- The full incoming event object is preserved verbatim in `raw_event`
-- so a later mapping change can be re-derived without re-ingesting.
--
-- This is created as a plain table; a later migration may convert it
-- to a TimescaleDB hypertable + compression policy once volume
-- warrants it (mirrors the sweed_auth_events 011 → 051 → 056 path).
--
-- Idempotent: every `create` is `if not exists`. Safe to re-run.

\echo 'Running migration 070: lp_events...'

create table if not exists lp_events (
  -- ingestion-metadata
  id              bigserial   primary key,
  ingested_at     timestamptz not null default now(),

  -- event identity + idempotency
  event_id        text        not null,
  event_type      text        not null,   -- lp_impression|lp_redirect|lp_assignment|lp_conversion
  event_ts        timestamptz not null,
  replica_id      text        not null,

  -- selection provenance (parent §9 / §11)
  bundle_id       text        not null,
  policy_id       text        not null,
  policy_rule_id  text,
  experiment_id   text,
  assignment_id   text,
  assignment_key_type text,                -- gclid|gbraid|wbraid|cookie|session|default
  branch_id       text,

  -- selection payload
  selected_variants        jsonb,
  counterfactual_variants  jsonb,
  candidate_weights        jsonb,
  served_probability_bps   integer,
  bucket_bps               integer,
  gclid_hash               text,

  -- placement
  site            text        not null,
  family          text,
  cluster_slug    text,
  traffic_flags   jsonb,

  -- verbatim event for re-derivation
  raw_event       jsonb       not null,

  constraint lp_events_event_type_check
    check (event_type in (
      'lp_impression',
      'lp_redirect',
      'lp_assignment',
      'lp_conversion'
    )),

  constraint lp_events_assignment_key_type_check
    check (assignment_key_type is null or assignment_key_type in (
      'gclid', 'gbraid', 'wbraid', 'cookie', 'session', 'default'
    )),

  constraint lp_events_served_probability_bps_check
    check (served_probability_bps is null
           or (served_probability_bps >= 0 and served_probability_bps <= 10000)),

  constraint lp_events_bucket_bps_check
    check (bucket_bps is null or (bucket_bps >= 0 and bucket_bps <= 9999))
);

-- Idempotency key: one row per runtime-assigned event_id.
create unique index if not exists lp_events_event_id_idx
  on lp_events (event_id);

-- Time-ordered scans per event_type for the parity dashboard +
-- conversion loop ("latest N conversions", "impressions in window").
create index if not exists lp_events_type_ts_idx
  on lp_events (event_type, event_ts desc);

-- Join selections to outcomes by assignment.
create index if not exists lp_events_assignment_idx
  on lp_events (assignment_id)
  where assignment_id is not null;

-- Per-bundle rollups ("how did bundle X perform").
create index if not exists lp_events_bundle_idx
  on lp_events (bundle_id, event_ts desc);

-- Per-placement slicing for the dashboard.
create index if not exists lp_events_site_family_idx
  on lp_events (site, family, event_ts desc);
