-- Migration 103: audited low-inventory physical counts
--
-- Adds an append-only capture table for operator-entered package counts and
-- the exact Sweed mirror snapshot used to classify each count. This migration
-- does not add a Sweed writer, inventory transfer, scheduled workload, or
-- notification path.
--
-- Cost: operator initiated only, one narrow INSERT per submitted count. Package
-- history and pending-review reads use the two bounded indexes in the schema.
-- At floor-audit volume this is tens of rows/day, negligible WAL/autovacuum
-- churn and storage. The new table starts empty, so creation takes only short
-- catalog locks and performs no rewrite or backfill.
--
-- Additive, transactional, and idempotent. Production application requires an
-- Oracle migration blessing and explicit operator approval for migration 103.

\set ON_ERROR_STOP on
\timing on

\echo 'Running migration 103: low-inventory physical counts...'

begin;
set local lock_timeout = '5s';
\ir ../schema/lowInventoryPhysicalCounts.sql
commit;

\echo 'Migration 103 complete.'
