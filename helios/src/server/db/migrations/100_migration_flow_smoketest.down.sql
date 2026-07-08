-- Inverse of 100: drop the throwaway smoke-test table.
--
-- Safe and non-destructive of anything real — `migration_flow_smoketest` holds
-- no production data and nothing joins it. Idempotent (`drop table if exists`),
-- wrapped in an explicit transaction.

\set ON_ERROR_STOP on

begin;

drop table if exists migration_flow_smoketest;

commit;
