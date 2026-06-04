-- Pre-conversion prep for the C1 hypertable conversion of
-- `litalerts_competitor_observations` (next migration: 055).
--
-- DB-cost epic phase C1 (virusdave/top-level#11). Per the oracle
-- review of this conversion, two query-shape risks need to land
-- BEFORE the hypertable conversion itself:
--
--   1. `vw_pricing_evidence_freshness` did not expose
--      `next_refresh_at`, forcing the rolling scheduler to join
--      back to `litalerts_competitor_observations` by `id` alone
--      on every tick. After conversion, that `id`-only join would
--      fan out across every chunk. This migration re-runs the
--      schema definition of the view to add `next_refresh_at` to
--      its output (appended to the end of the select list so
--      CREATE OR REPLACE VIEW is preserved); the scheduler change
--      that consumes it ships in this same commit.
--
--   2. The current btree indexes only support recency lookups
--      via `(product_id, captured_at DESC)` over the full table.
--      Both the freshness view's DISTINCT ON and the per-product
--      "prior observation" lookup in
--      `configWorkersLitalertsRefreshJob` filter on
--      `status = 'succeeded'` with no time-range predicate; on
--      the future hypertable both queries will fan out across
--      every chunk. This migration adds a partial index that
--      gives both queries a chunk-aware lookup path with the
--      hot columns covered (so the planner can skip heap fetches).
--
-- Both changes are safe pre-conversion and improve plans
-- immediately even before the hypertable conversion lands. They
-- are intentionally split out from 055 so the conversion itself
-- runs against a database whose query plans have already been
-- validated against the new view + index shape.

\set ON_ERROR_STOP on
\timing on

\echo 'Running migration 054: litalerts_competitor_observations C1 prep...'

-- Refresh the freshness view via the canonical schema file. The
-- schema file uses CREATE OR REPLACE VIEW with `next_refresh_at`
-- appended to the end of the select list, so existing dependent
-- queries (column-name-based) keep working.
\i ../schema/pricingEvidenceFreshness.sql

-- Partial covering index for the "latest succeeded observation
-- per product" pattern. CONCURRENTLY so we don't block writers
-- to the table.
--
-- Justification per column:
--   * leading (product_id, captured_at DESC, id DESC): the exact
--     sort the view's DISTINCT ON and the refresh job's prior-
--     observation lookup need, so the planner can satisfy both
--     with a Skip Scan / Index Only Scan.
--   * partial WHERE status = 'succeeded': both consumer queries
--     hard-filter to succeeded rows. Skipping failed rows shrinks
--     the index materially (and we never query for "latest of any
--     status").
--   * INCLUDE (expires_at, next_refresh_at, listing_count,
--     pricing_eligible_listing_count): the columns the freshness
--     view's latest_obs CTE projects. With these in the index,
--     the planner gets an Index Only Scan (no heap, no TOAST
--     fetch for the heavy JSON columns).
--
-- This index will be auto-recreated on every chunk when the
-- table is converted to a hypertable in migration 055.

create index concurrently if not exists
  litalerts_competitor_observations_latest_succeeded_idx
  on public.litalerts_competitor_observations
    (product_id, captured_at desc, id desc)
  include (expires_at, next_refresh_at, listing_count, pricing_eligible_listing_count)
  where status = 'succeeded';

analyze public.litalerts_competitor_observations;

\echo 'Migration 054 complete.'
