-- Migration 076: seo_ga_gsc_imports
--
-- Helios-driven SEO widgets — GA4 + GSC feedback loop, first slice
-- (parent epic virusdave/top-level#15, child epic
-- FreshlyBakedNYC/automation#44, phase P5).
--
-- P5 closes the loop: pull Search Console / GA4 performance data into the
-- control plane so the (future) recommendation engine can spot query gaps,
-- low-CTR pages, refresh candidates, etc. Per the epic's operator decision
-- §0.4 we start by importing OPERATOR-SUPPLIED BATCH DATA DUMPS (the CSV
-- "Performance"/report exports Google already gives us — no new API
-- credentials), not a high-frequency API poller. The import is therefore
-- intermittent (a few operator-triggered runs/week), not always-on.
--
-- This first slice lands ONLY the durable data model + idempotent batch
-- import + bounded aggregation queries. The SEO dashboard UI and the
-- recommendation engine + approval workflow are deliberately deferred to
-- follow-on P5 slices (canon §1: any recommendation must terminate in the
-- existing human review/approve gate before anything ships).
--
-- Tables:
--   seo_metric_import_batches  — one row per import run (provenance + counts)
--   seo_gsc_daily              — Search Console (query,page,date,…) daily facts
--   seo_ga4_daily              — GA4 (page,date,…) daily facts
--
-- Idempotency / write-on-change (canon §3): GSC/GA4 daily exports are
-- ALREADY aggregated, so a re-imported overlapping date range must REPLACE
-- the daily fact, never sum into it. Each fact row carries a deterministic
-- `row_key` = sha256 over its identifying dimensions (NOT including the
-- batch id or file hash, so overlapping re-imports collapse). The upsert is
-- `on conflict (row_key) do update … where <metric> is distinct from
-- excluded.<metric>` so an unchanged re-import writes ZERO rows (no WAL, no
-- dead tuples). GSC restates the freshest ~3 days, so those legitimately
-- update; the query layer excludes the freshest days from gap/comparison
-- logic.
--
-- DB-cost budget (canon §3) — recorded with the commit / on issue #44:
--   * Volume: operator imports a few times/week, low-thousands of rows each;
--     ~1–3M new fact rows/year across both sources; ~1–3 GB/year storage
--     (cap 5 GB). WAL ~5–30 MB per import of new rows; near-zero churn for
--     unchanged overlap rows (IS DISTINCT FROM guard).
--   * Write amplification: 1 heap + 3 index writes per NEW fact row;
--     restated rows are HOT updates (no secondary-index churn — indexed
--     columns don't change). Importer chunks upserts at ≤500 rows/statement
--     to stay under the 125ms per-interaction budget and de-dupes row_keys
--     within a file before SQL (ON CONFLICT can't touch a row twice).
--   * Aggregation: every query is bounded by site + a date window + LIMIT;
--     served by the (site, bucket_date_ny) / (site, page_url, bucket_date_ny)
--     indexes. No `query`-column index yet (text-index footprint) — add only
--     if EXPLAIN ANALYZE shows >125ms.
--   Reviewed by the Oracle (GPT-5.5) per canon §3 high-risk-DB gate: PASS
--   with the chunking / IS-DISTINCT-FROM / bounded-aggregation guardrails
--   above (all implemented in the query + importer layers).
--
-- Idempotent: every `create` is `if not exists`. Safe to re-run.

\echo 'Running migration 076: seo_ga_gsc_imports...'

-- ── import provenance ────────────────────────────────────────────────
create table if not exists seo_metric_import_batches (
  import_batch_id      text        primary key,
  source               text        not null,   -- gsc | ga4
  property             text        not null,    -- GSC property / GA4 property id
  site                 text        not null,    -- helios scope (site id or 'all')
  source_timezone      text        not null,    -- e.g. America/Los_Angeles (GSC)
  source_file_name     text        not null,
  source_file_sha256   text        not null,
  export_start_date    date,
  export_end_date      date,

  status               text        not null default 'running',
  rows_seen            integer     not null default 0,
  rows_inserted        integer     not null default 0,
  rows_updated         integer     not null default 0,
  rows_unchanged       integer     not null default 0,
  rows_rejected        integer     not null default 0,

  imported_by          text,
  created_at           timestamptz not null default now(),
  completed_at         timestamptz,
  error                text,

  constraint seo_metric_import_batches_source_check
    check (source in ('gsc', 'ga4')),
  constraint seo_metric_import_batches_status_check
    check (status in ('running', 'completed', 'failed')),
  constraint seo_metric_import_batches_sha_check
    check (source_file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint seo_metric_import_batches_counts_check
    check (rows_seen >= 0 and rows_inserted >= 0 and rows_updated >= 0
           and rows_unchanged >= 0 and rows_rejected >= 0)
);

-- "most recent imports for source X / property Y" for the (future) dashboard.
create index if not exists seo_metric_import_batches_source_property_created_idx
  on seo_metric_import_batches (source, property, created_at desc);

-- ── Search Console daily facts ───────────────────────────────────────
create table if not exists seo_gsc_daily (
  -- sha256 over (source/property/source_date/search_type/device/country/
  -- query/page_url) — stable across re-imports of overlapping ranges.
  row_key               text        primary key,
  first_import_batch_id text        references seo_metric_import_batches (import_batch_id),
  last_import_batch_id  text        references seo_metric_import_batches (import_batch_id),

  property              text        not null,
  site                  text        not null,

  -- Google reporting date (GSC daily exports are Google/PT-shaped).
  source_date           date        not null,
  source_timezone       text        not null default 'America/Los_Angeles',
  -- Helios reporting bucket; for daily GSC exports this equals source_date
  -- (a daily reporting bucket, NOT an exact NY-midnight event bucket).
  bucket_date_ny        date        not null,

  search_type           text        not null default 'web',
  device                text        not null default 'all',
  country               text        not null default 'all',

  query                 text        not null,
  page_url              text        not null,

  clicks                integer     not null,
  impressions           integer     not null,
  -- Aggregate CTR with sum(clicks)/sum(impressions); this stored column is
  -- the per-row convenience value only.
  ctr                   numeric(12,8)
    generated always as (
      case when impressions = 0 then 0
           else clicks::numeric / impressions end
    ) stored,
  position              numeric(10,4) not null,

  first_imported_at     timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint seo_gsc_daily_row_key_check
    check (row_key ~ '^[0-9a-f]{64}$'),
  constraint seo_gsc_daily_counts_check
    check (clicks >= 0 and impressions >= 0 and clicks <= impressions),
  constraint seo_gsc_daily_position_check
    check (position >= 0),
  constraint seo_gsc_daily_nonempty_page_check
    check (length(page_url) > 0)
);

create index if not exists seo_gsc_daily_site_date_idx
  on seo_gsc_daily (site, bucket_date_ny desc);
create index if not exists seo_gsc_daily_site_page_date_idx
  on seo_gsc_daily (site, page_url, bucket_date_ny desc);

-- ── GA4 daily facts ──────────────────────────────────────────────────
create table if not exists seo_ga4_daily (
  -- sha256 over (source/property/source_date/traffic_scope/page_url).
  row_key               text        primary key,
  first_import_batch_id text        references seo_metric_import_batches (import_batch_id),
  last_import_batch_id  text        references seo_metric_import_batches (import_batch_id),

  property              text        not null,
  site                  text        not null,
  source_date           date        not null,
  source_timezone       text        not null default 'America/New_York',
  bucket_date_ny        date        not null,

  page_url              text        not null,
  -- Keep traffic scope explicit so organic-search exports are never silently
  -- mixed with all-traffic exports.
  traffic_scope         text        not null default 'organic_search',

  sessions              integer     not null default 0,
  active_users          integer     not null default 0,
  screen_page_views     integer     not null default 0,
  engaged_sessions      integer     not null default 0,
  key_events            numeric(14,4) not null default 0,
  engagement_rate       numeric(12,8)
    generated always as (
      case when sessions = 0 then 0
           else engaged_sessions::numeric / sessions end
    ) stored,

  first_imported_at     timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint seo_ga4_daily_row_key_check
    check (row_key ~ '^[0-9a-f]{64}$'),
  constraint seo_ga4_daily_counts_check
    check (sessions >= 0 and active_users >= 0 and screen_page_views >= 0
           and engaged_sessions >= 0 and engaged_sessions <= sessions
           and key_events >= 0),
  constraint seo_ga4_daily_nonempty_page_check
    check (length(page_url) > 0)
);

create index if not exists seo_ga4_daily_site_date_idx
  on seo_ga4_daily (site, bucket_date_ny desc);
create index if not exists seo_ga4_daily_site_page_date_idx
  on seo_ga4_daily (site, page_url, bucket_date_ny desc);
