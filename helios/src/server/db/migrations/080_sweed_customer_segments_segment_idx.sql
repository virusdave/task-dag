-- Secondary index on sweed_customer_segments(segment_id, sweed_customer_id).
--
-- virusdave/top-level#12 (DB-efficiency review follow-up).
--
-- WHY: the bulk per-segment membership writer (snapshotSegmentMembers in
-- sweedCustomerSegmentsQueries.ts) deletes/diffs rows `WHERE segment_id = $1`.
-- The table PK is (sweed_customer_id, scope_dealer_id, segment_id), so
-- segment_id is the THIRD PK column and a `WHERE segment_id = …` predicate
-- cannot use the PK btree — it seq-scans the whole table. EXPLAIN (ANALYZE)
-- on prod confirmed a Seq Scan. That is fine at today's ~1.9k rows, but the
-- operator is about to bulk-populate every segment (NY segment 1532 alone has
-- 1412 members across 58 segments), so a full bulk run would be O(segments ×
-- table size) — millions of rows scanned once the table grows to tens of
-- thousands of rows.
--
-- A (segment_id, sweed_customer_id) composite serves the `WHERE segment_id`
-- delete/diff via its left prefix AND lets the per-segment anti-join diff
-- probe membership by customer within a segment. One secondary index is
-- enough; do not add more.

\echo 'Running migration 080: sweed_customer_segments segment_id index...'

create index if not exists sweed_customer_segments_segment_customer_idx
  on sweed_customer_segments (segment_id, sweed_customer_id);

\echo 'Migration 080 complete.'
