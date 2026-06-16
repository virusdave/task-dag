-- Down for 089: drop the Helios-local segment-retirement table.
-- Only run this as part of a CODE ROLLBACK that no longer references the
-- table: the new read paths anti-join it, so dropping it while that code
-- is live makes every segment-listing query error on the missing
-- relation. Once the old code is restored, dropping is safe; it discards
-- the operator's manual retirements and retired segments reappear
-- (subject only to their Sweed enabled flag).

\set ON_ERROR_STOP on

\echo 'Reverting migration 089: sweed_marketing_segment_retirement...'

drop table if exists sweed_marketing_segment_retirement;

\echo 'Migration 089 reverted.'
