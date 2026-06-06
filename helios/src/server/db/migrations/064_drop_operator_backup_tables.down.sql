-- Reverse migration 064: documented restore RUNBOOK (manual,
-- not idempotent).
--
-- Helios DB-cost epic, phase F2 (virusdave/top-level#11). Migration
-- 064 dropped four operator backup / pre-migration snapshot tables.
-- They are not derivable from any other table, so the only way to
-- restore them is from the pg_dump captured before the drop.
--
-- To restore (all four tables, with data and indexes):
--
--   gzip -dc /home/amp-local/db-backups/f2_operator_backup_tables_20260606T135323Z.sql.gz \
--     | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
--
-- Verify the dump integrity first if in doubt:
--
--   md5sum /home/amp-local/db-backups/f2_operator_backup_tables_20260606T135323Z.sql.gz
--   # expected: caf0cb34a42ae5e020e43a1a99f4589c
--
-- Expected restored row counts:
--   pos_payment_matches_backup_20260303                            99,092
--   pos_payment_matches_snapshot_20260310_pre_remainder_backfill  100,595
--   payment_transactions_snapshot_20260310_pre_remainder_backfill 101,998
--   payment_transactions_snapshot_20260310_overpayment_fix        101,996
--
-- If the dump file is gone (e.g. the box was reprovisioned), these
-- snapshots are unrecoverable — they were one-off manual backups,
-- never replicated or part of any scheduled backup set.

\echo 'Migration 064 has no automatic down step. To restore the dropped'
\echo 'backup tables, run the pg_dump restore documented in this file.'
