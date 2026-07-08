-- Inverse of 099: drop the migration_apply_attempts lifecycle table.
--
-- Safe to run only after the "Apply Now" apply engine / admin APIs that
-- read/write this table have been reverted. It is a standalone audit table that
-- nothing in the production read path joins, so dropping it cannot affect any
-- live feature.
--
-- Destructive: this DROPs the table and every recorded apply-attempt audit row.
-- The immutable event log for those attempts also lives in `audit_events`, but
-- the structured per-attempt record (redacted command, txn mode, sentinel
-- before/after, exit/signal, etc.) is lost. Only run when intentionally
-- discarding that record (or in a dev/rollback context).

\set ON_ERROR_STOP on

begin;

drop table if exists migration_apply_attempts;

commit;
