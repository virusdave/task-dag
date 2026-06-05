-- F5 prerequisite (virusdave/top-level#11, phase F5): backfill
-- sweed_orders.cashier_user_id from raw_json so the budtender
-- analytics page can stop reading sweed_orders.raw_json->>'creatorId'
-- as a fallback. That fallback is the LAST server callsite that reads
-- sweed_orders.raw_json; once it is gone, the F5 drain worker can null
-- raw_json for >30d rows without regressing historical cashier
-- attribution.
--
-- The orders ingest job already writes cashier_user_id from the
-- canonical Sweed `creatorId` field (when creatorType = 1 / User; see
-- configWorkersSweedOrdersIngestJob.ts), so new rows are correct. This
-- backfills the historical rows ingested before that fix. Verified on
-- prod 2026-06-05:
--   * 40662 total orders, all carry raw_json with creatorType = '1'
--   * 39380 rows had a NULL cashier_user_id
--   * ALL 39380 are recoverable (clean integer creatorId, 0 non-integer,
--     0 unrecoverable)
--
-- Idempotent: only touches rows still NULL with a recoverable integer
-- creatorId, so it is safe to re-run.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
update sweed_orders
   set cashier_user_id = (raw_json->>'creatorId')::bigint
 where cashier_user_id is null
   and (raw_json->>'creatorType') = '1'
   and nullif(raw_json->>'creatorId', '') ~ '^\d+$';
commit;

analyze sweed_orders;
