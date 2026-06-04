-- Enable Timescale compression on litalerts_competitor_observations.
--
-- Helios DB-cost epic phase C2 (virusdave/top-level#11), table 2 of 2.
-- Pairs with the C1 hypertable conversion in 055.
--
-- Why this table is more sensitive than sweed_auth_events:
--   * The configWorkers rolling scheduler UPDATEs
--     `next_refresh_at` on the *latest succeeded* observation per
--     product (see configWorkersScheduler.ts ~line 460). The shape
--     used (after migration 054) is
--       UPDATE litalerts_competitor_observations
--          SET next_refresh_at = $3
--        WHERE id = $1 AND captured_at = $2
--     which prunes to a single chunk by the partition key.
--     Updates against a *compressed* chunk are supported by
--     Timescale 2.11+ but trigger transparent decompression —
--     extremely expensive at scale, and the very pattern we are
--     trying to avoid.
--   * Therefore `compress_after` MUST be larger than the maximum
--     age of any row the scheduler might touch.
--
-- Pre-checks performed live before writing this file:
--   * 055 is applied: hypertable on captured_at with 14-day chunks
--     (4 chunks at apply time).
--   * Pre-077 chunk total: 595 MB (40 MB heap + 26 MB indexes +
--     528 MB TOAST — TOAST dominates and is what compression will
--     actually shrink).
--   * Compression currently disabled.
--   * Distribution of "latest succeeded observation age" across
--     3,395 products:
--       p50 = 0.3 days, p95 = 0.9 days, p99 = 2.2 days,
--       oldest_latest_age = 29 days 17 hours.
--     i.e. every row the scheduler can update is currently <= 30
--     days old.
--   * Outbound FKs (job_id, queue_row_id, source_snapshot_id)
--     of rows older than 90 days were all NULL — no SET NULL /
--     CASCADE traffic into compressed chunks is possible from the
--     parent tables for old rows even in adversarial scenarios.
--   * Cardinality of `status` is small (succeeded/failed/...),
--     well within recommended segmentby cardinality.
--
-- Compression configuration (oracle-reviewed):
--   * segmentby  = `status`. Most read traffic filters on
--     `status='succeeded'` (pricing-evidence freshness view,
--     reviewFamilyQueueQueries, refresh-job last-observation
--     lookup). Keeping succeeded vs other statuses in separate
--     segments preserves index-like access from inside compressed
--     chunks.
--   * orderby    = `product_id, captured_at DESC, id DESC`. Matches
--     the pricing-evidence freshness view's
--       ORDER BY product_id, captured_at DESC, id DESC
--     access shape, and the refresh-job last-observation lookup
--     `WHERE product_id = $3 ORDER BY captured_at DESC LIMIT 1`.
--   * compress_after = 60 days. Doubles the observed worst-case
--     "latest succeeded age" of ~30 days, giving a comfortable
--     30-day safety margin against the scheduler ever touching a
--     compressed row. With 14-day chunks the policy will leave
--     ~5 chunks (~70 days) hot.
--
-- A note on the partial covering index from migration 054:
--   * `litalerts_competitor_observations_latest_succeeded_idx`
--     is a partial index `WHERE status='succeeded'`. Per oracle
--     guidance and Timescale's compression model, partial indexes
--     are NOT preserved into compressed chunks — they remain on
--     the uncompressed heap of hot chunks only. That is acceptable
--     here because the scheduler only ever queries recent
--     (uncompressed) data; cold-chunk reads on this column go
--     through the segmentby min/max metadata and the per-segment
--     compressed-row scan, which is fast enough for the rare
--     cold-read use cases.
--
-- Application impact during apply:
--   * `ALTER TABLE … SET (timescaledb.compress, …)` takes a brief
--     ACCESS EXCLUSIVE on the parent table only (no chunk scans).
--   * `add_compression_policy(...)` only registers a bgw job.
--   * No live customer scan/checkin code path touches this table.

\set ON_ERROR_STOP on
\timing on

set lock_timeout      = '10s';
set statement_timeout = '5min';

begin;

alter table public.litalerts_competitor_observations
  set (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'status',
    timescaledb.compress_orderby   = 'product_id, captured_at DESC, id DESC'
  );

select add_compression_policy(
  'public.litalerts_competitor_observations'::regclass,
  compress_after => interval '60 days',
  if_not_exists  => true
);

commit;
