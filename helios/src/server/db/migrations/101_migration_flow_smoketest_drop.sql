-- Migration 101: drop migration_flow_smoketest (automation#62 leaf 9)
--
-- Second half of the throwaway smoke-test pair. Drops the table created by
-- `100_migration_flow_smoketest` so the "first real apply" exercise of the
-- admin "Apply Now" flow leaves NO schema behind. Applying 100 then 101 via the
-- button exercises the psql apply engine twice (a create and a drop) with a
-- net-zero schema effect.
--
-- Cost/plan: a single `DROP TABLE` on a tiny, empty, unreferenced table. No
-- production code path reads it, so the drop cannot affect any live feature.
--
-- Idempotent (`drop table if exists`), wrapped in an explicit transaction —
-- safe to re-run.

\set ON_ERROR_STOP on

\echo 'Running migration 101: drop migration_flow_smoketest...'

begin;

drop table if exists migration_flow_smoketest;

commit;

\echo 'Migration 101 complete.'
