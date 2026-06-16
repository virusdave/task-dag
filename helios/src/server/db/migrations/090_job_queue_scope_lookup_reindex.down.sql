-- Down for 090: restore the original mis-keyed index and drop the
-- re-keyed replacement. This faithfully recreates
-- job_queue_scope_status_run_at_idx exactly as it existed on prod before
-- the migration (same columns, order, and partial predicate), so a
-- rollback returns job_queue to its prior index set.

\set ON_ERROR_STOP on
\timing on

-- CONCURRENTLY statements must run outside a transaction block. Recreate
-- the original FIRST so the scope query stays served, then drop the
-- replacement.
create index concurrently if not exists job_queue_scope_status_run_at_idx
  on job_queue (module_code, scope_entity_type, scope_entity_id, status, run_at, id)
  where scope_entity_type is not null and scope_entity_id is not null;

drop index concurrently if exists job_queue_scope_created_at_idx;

\echo '090 down restored job_queue_scope_status_run_at_idx and dropped job_queue_scope_created_at_idx.'
