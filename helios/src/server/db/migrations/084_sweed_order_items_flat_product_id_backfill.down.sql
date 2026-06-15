-- Down for 084: there is nothing to undo. The backfill only populated an
-- existing column (added by migration 060) from data already present in
-- raw_item; it created no schema object. Null-ing product_id back out
-- would be destructive and pointless (ingest would re-populate it), so
-- this down migration is intentionally a no-op.

\set ON_ERROR_STOP on
\echo '084 down: no-op (backfill only; column owned by migration 060).'
