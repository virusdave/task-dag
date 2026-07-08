-- Inverse of 101: re-create the throwaway smoke-test table (undoes the drop).
--
-- Mirrors `100_migration_flow_smoketest.sql` exactly so that down-migrating 101
-- restores the pre-101 state. Non-destructive; the table holds no production
-- data. Idempotent (`create table if not exists`), wrapped in a transaction.

\set ON_ERROR_STOP on

begin;

create table if not exists migration_flow_smoketest (
  id         bigint generated always as identity primary key,
  note       text not null default 'automation#62 leaf 9 first-apply smoke test',
  created_at timestamptz not null default now()
);

commit;
