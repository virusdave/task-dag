-- Migration 100: migration_flow_smoketest (automation#62 leaf 9)
--
-- Throwaway smoke-test table that exists ONLY to exercise the admin
-- "Apply Now" worker-driven production-migration flow end-to-end for the first
-- time: the `psql -f` apply engine, the live sentinel before/after
-- verification, and the `migration_apply_attempts` / `audit_events` lifecycle.
-- It is dropped again immediately by the consecutive migration
-- `101_migration_flow_smoketest_drop`, so applying the pair leaves NO schema
-- behind (net-zero effect) while still running psql twice (a create + a drop).
--
-- Cost/plan: a single tiny table, created empty, never read or written by ANY
-- production code path (nothing selects or joins it; there is no sentinel-backed
-- feature behind it). Zero ongoing query / storage / churn cost.
--
-- Forward-only, additive, idempotent (`create table if not exists`), and wrapped
-- in an explicit transaction — safe to re-run.

\set ON_ERROR_STOP on

\echo 'Running migration 100: migration_flow_smoketest...'

begin;

create table if not exists migration_flow_smoketest (
  id         bigint generated always as identity primary key,
  note       text not null default 'automation#62 leaf 9 first-apply smoke test',
  created_at timestamptz not null default now()
);

commit;

\echo 'Migration 100 complete.'
