-- Enable Timescale compression on sweed_auth_events.
--
-- Helios DB-cost epic phase C2 (virusdave/top-level#11), table 1 of 2.
-- Pairs with the C1 conversion in 051. Compression is shipped as a
-- separate migration on purpose: rolling back compression on a
-- hypertable is materially more involved than rolling back the
-- hypertable itself, so keeping the two changes atomically separate
-- gives us a small, well-defined unwind path if a regression shows
-- up days after apply.
--
-- Pre-checks performed live before writing this file:
--   * 051 is applied: sweed_auth_events is a hypertable on
--     created_at with 7-day chunks (3 chunks at apply time).
--   * Compression is currently disabled (compression_enabled = false
--     in timescaledb_information.hypertables).
--   * No compression policy job currently exists.
--   * Outbound FK: sweed_auth_events.job_id → job_queue.id
--     (ON DELETE SET NULL). job_queue retention is observably
--     ~30 days in production (130k rows total, 54 rows > 30d). At
--     `compress_after = 30 days` the overwhelming majority of
--     sweed_auth_events rows that get compressed will have
--     job_queue parents that have already been pruned, so an
--     ON DELETE SET NULL cascade against a compressed chunk is a
--     rare-edge event. Timescale 2.11+ handles it transparently
--     by transparent-decompressing the affected row — costly per
--     event but acceptable at the expected frequency (~0 events
--     per typical day given the live FK distribution at apply
--     time: 0 rows older than 30 days had a still-live job parent).
--   * Cardinality of `outcome` is 3 ('ok','error','retryable'),
--     well within the recommended segmentby range (<= dozens).
--
-- Compression configuration:
--   * segmentby  = `outcome`. Matches the existing partial
--     `sweed_auth_events_outcome_idx` filter (outcome <> 'ok') and
--     the `outcomeFilter='errors'` read path in
--     `listSweedAuthEvents`. Keeps `ok` rows in their own segments
--     so the much rarer `error`/`retryable` rows compress densely
--     and seek cheaply.
--   * orderby    = `created_at DESC, id DESC`. Matches every
--     read query shape (`listSweedAuthEventsForJob` orders ASC by
--     created_at,id but uses an explicit job_id equality filter
--     that segmentby/min-max metadata still helps with; the
--     listing query orders DESC).
--   * compress_after = 30 days. Chosen specifically to align with
--     the observed job_queue retention horizon documented above.
--     With 7-day chunks this leaves ~4–5 chunks uncompressed and
--     hot — covering the typical scheduler/UI read window.
--
-- Application impact during apply:
--   * `ALTER TABLE … SET (timescaledb.compress, …)` takes a brief
--     ACCESS EXCLUSIVE lock on the parent table only (no chunk
--     scans). Sub-100ms in practice.
--   * `add_compression_policy(...)` just registers a background
--     job; no chunk work happens synchronously.
--   * No live customer scan/checkin code path reads or writes
--     sweed_auth_events.

\set ON_ERROR_STOP on
\timing on

set lock_timeout      = '10s';
set statement_timeout = '5min';

begin;

alter table public.sweed_auth_events
  set (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'outcome',
    timescaledb.compress_orderby   = 'created_at DESC, id DESC'
  );

select add_compression_policy(
  'public.sweed_auth_events'::regclass,
  compress_after => interval '30 days',
  if_not_exists  => true
);

commit;
