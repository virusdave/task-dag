-- Reverse migration 052: NO-OP.
--
-- The data this migration discarded was a 15 GB / 32M-row
-- write-only audit trail of the Sweed state catalog at past
-- timestamps. It is not derivable from any other table in Helios
-- and is not preserved by any external system. The only way to
-- "reconstruct" historical snapshots is to wait for fresh ones to
-- accumulate under the new 24 h retention window from the
-- F1 phase.
--
-- If you arrived here because you genuinely needed historical
-- snapshot rows: nothing you can do in SQL will restore them. The
-- right action is to:
--   1. Confirm what you actually need (most likely the parent
--      `catalog_taxonomy_snapshots` summary rows, which were NOT
--      touched by 052 and are intact in production).
--   2. Decide whether the next 24 h of fresh snapshots will
--      suffice.
--   3. If not, talk to the operator about whether to widen the
--      `CATALOG_SNAPSHOT_ROW_RETENTION_HOURS` env var going
--      forward so future investigations have more history to work
--      with.

\echo 'Migration 052 has no down step — the data it discarded was'
\echo 'write-only audit not derivable from anywhere else. See the'
\echo 'comment block in this file for context.'
