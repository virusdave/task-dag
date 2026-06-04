-- Tighten the compression policy on litalerts_competitor_observations
-- from compress_after = 60 days down to 45 days.
--
-- Helios DB-cost epic phase C3 (virusdave/top-level#11).
--
-- Why this instead of the literal C3 "move evidence_json to a _raw
-- table with 30d retention" plan: a live production audit found that
-- plan to be near-useless and partly unsafe for this table —
--   * The table is only ~30 days deep (the feature is ~30 days old)
--     and has no retention job, so it GROWS ~17 MB/day. evidence_json
--     is 510 MB total but only ~6 MB of it is older than 30 days, so
--     a 30-day _raw split would reclaim ~6 MB today.
--   * evidence_json.matchedListings (the bulk of the bytes, avg ~262
--     elements/row) is read ACROSS ALL HISTORY by the competitor
--     summary page (listLitalertsCompetitors, no time filter) plus
--     the fuzzy-sku / review-queue paths, so it cannot be dropped or
--     short-retentioned without breaking serving reads.
-- The real lever is compression. Migration 057 enabled compression
-- but chose compress_after = 60 days to stay clear of the rolling
-- scheduler, which UPDATEs next_refresh_at on the latest succeeded
-- observation per product. At 60 days, given the table is only ~30
-- days deep, ZERO chunks ever compress. Lowering to 45 days starts
-- bounding the growing uncompressed JSONB window while keeping a
-- comfortable margin above the scheduler's mutable rows.
--
-- Safety (verified live immediately before writing this file):
--   * Latest-succeeded observation age across 3,406 products:
--     p95 = 0.91d, p99 = 2.70d, MAX = 30.24d.
--   * Rows that are the latest-succeeded for their product AND older
--     than 45 days: 0 (also 0 older than 35 days).
--   * So a 45-day threshold leaves ~15 days of headroom over the
--     worst-case mutable row; the scheduler will not UPDATE a row
--     that has aged into a compressed chunk.
--   * With 14-day chunks, compress_after = 45 days means the
--     effective hot/uncompressed window is ~45–59 days depending on
--     chunk boundaries — still well clear of the 30d mutable window.
--
-- This is reversible: 058_down restores compress_after = 60 days.
-- No app/code change and no synchronous chunk work; add/remove
-- compression policy only registers/clears a background job.

\set ON_ERROR_STOP on
\timing on

set lock_timeout      = '10s';
set statement_timeout = '2min';

begin;

select remove_compression_policy(
  'public.litalerts_competitor_observations'::regclass,
  if_exists => true
);

select add_compression_policy(
  'public.litalerts_competitor_observations'::regclass,
  compress_after => interval '45 days',
  if_not_exists  => true
);

commit;
