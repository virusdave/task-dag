-- F4 (virusdave/top-level#11, phase F4): index supporting the
-- fuzzy_skus 30-day retention drain.
--
-- fuzzy_skus is ~1.67 GB / 913k rows on prod and carries no index on
-- created_at. The retention worker
-- (config.workers.fuzzy_skus_retention) repeatedly asks for "the oldest
-- rows past the cutoff" — without this index that is a multi-second
-- full seq scan of the whole 1.67 GB table on every (daily) tick, and
-- the steady-state no-op would be just as expensive. A plain btree on
-- created_at turns both the candidate scan AND the eventual no-op into
-- an O(matching-rows) index range scan.
--
-- fuzzy_skus is bulk-rebuilt periodically rather than written at high
-- frequency, so the per-insert maintenance cost of one extra btree is
-- negligible.

\set ON_ERROR_STOP on
\timing on

-- Built CONCURRENTLY (must run outside a transaction block) so it never
-- takes a blocking lock on the table while it scans 913k rows.
create index concurrently if not exists fuzzy_skus_created_at_idx
  on fuzzy_skus (created_at);
