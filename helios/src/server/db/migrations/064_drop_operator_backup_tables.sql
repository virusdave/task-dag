-- Drop operator backup / pre-migration snapshot tables.
--
-- Helios DB-cost epic, phase F2 (virusdave/top-level#11).
--
-- These four tables are one-off manual backups the operator took
-- before earlier payment-reconciliation migrations. They are pure
-- point-in-time snapshots: no application code references them
-- (verified by grep over helios/src), no foreign keys point at
-- them, and no views depend on them (verified against pg_constraint
-- / pg_depend at authoring time). Their live source tables
-- (`pos_payment_matches`, `payment_transactions`) have since grown
-- well past these snapshots (117,864 / 118,994 live rows vs the
-- ~100k frozen here), confirming the underlying migrations settled
-- and were never rolled back.
--
--   table                                                          rows    size
--   pos_payment_matches_backup_20260303                            99,092  14 MB
--   pos_payment_matches_snapshot_20260310_pre_remainder_backfill  100,595  14 MB
--   payment_transactions_snapshot_20260310_pre_remainder_backfill 101,998  12 MB
--   payment_transactions_snapshot_20260310_overpayment_fix        101,996  12 MB
--                                                                          ~52 MB
--
-- SAFETY — full pg_dump captured BEFORE this migration:
--   path : /home/amp-local/db-backups/f2_operator_backup_tables_20260606T135323Z.sql.gz
--   md5  : caf0cb34a42ae5e020e43a1a99f4589c
--   host : vps-nixos-3 (physically separate from the TigerData Cloud
--          DB host, so this copy is genuinely off the DB box)
--   The dump's per-table row counts were verified to match the live
--   tables exactly (99,092 / 100,595 / 101,998 / 101,996) before the
--   drop. The `.down.sql` is a documented restore runbook against
--   this dump, not an idempotent reverse migration.
--
-- Operator authorization: the operator directed F2 in the DB-cost
-- epic execution thread (T-019e8ac1-…) — "do: F2, F3, F4, then F6" —
-- after the F-line plan (which lists these exact four tables and the
-- backup-then-drop process) was presented.
--
-- Locking: DROP TABLE takes ACCESS EXCLUSIVE, but nothing reads or
-- writes these tables, so it can never block a production request.
-- lock_timeout keeps us from waiting on a stray ad-hoc psql session.

\set ON_ERROR_STOP on
\timing on

set lock_timeout      = '15s';
set statement_timeout = '1min';

begin;

select coalesce(sum(pg_total_relation_size(c.oid)), 0) as pre_drop_total_bytes,
       pg_size_pretty(coalesce(sum(pg_total_relation_size(c.oid)), 0)) as pre_drop_total_pretty
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in (
     'pos_payment_matches_backup_20260303',
     'pos_payment_matches_snapshot_20260310_pre_remainder_backfill',
     'payment_transactions_snapshot_20260310_pre_remainder_backfill',
     'payment_transactions_snapshot_20260310_overpayment_fix'
   );

drop table if exists public.pos_payment_matches_backup_20260303 cascade;
drop table if exists public.pos_payment_matches_snapshot_20260310_pre_remainder_backfill cascade;
drop table if exists public.payment_transactions_snapshot_20260310_pre_remainder_backfill cascade;
drop table if exists public.payment_transactions_snapshot_20260310_overpayment_fix cascade;

commit;
