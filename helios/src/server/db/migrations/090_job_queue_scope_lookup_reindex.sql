-- Re-key the job_queue scope-lookup index (DB-cost work, Helios DB-cost
-- epic follow-up).
--
-- The pre-existing ad-hoc index
--   job_queue_scope_status_run_at_idx
--     btree (module_code, scope_entity_type, scope_entity_id,
--            status, run_at, id)
--     WHERE scope_entity_type IS NOT NULL AND scope_entity_id IS NOT NULL
-- was mis-keyed for the job_queue scope-filtered reads. The primary
-- direct consumer is the scheduling-run debug view in
-- schedulingQueries.ts:
--
--   SELECT ... FROM job_queue jq
--   WHERE jq.scope_entity_type = 'scheduling_run'
--     AND jq.scope_entity_id   = $1
--   ORDER BY jq.created_at DESC, jq.id DESC
--   LIMIT 10
--
-- (The operator jobs list /api/jobs in jobQueries.ts can also filter by
-- scope_entity_type/scope_entity_id; its common deep-link path supplies
-- BOTH, so the new index seeks on the (type, id) prefix. That page
-- orders by run_at/priority rather than created_at, but per-(type,id)
-- cardinality is tiny and it is paginated + low-frequency, so any
-- residual sort is negligible. The old index did not satisfy that
-- ordering either.)
--
-- Two problems with the old index:
--   1. It LEADS with module_code, which that query does not constrain,
--      so PostgreSQL can only reach it via a skip-scan, and it cannot
--      satisfy the ORDER BY (its tail is run_at/id, not created_at/id),
--      forcing an extra Sort node.
--   2. It includes the MUTABLE columns status and run_at. Every
--      re-enqueue (ON CONFLICT DO UPDATE bumps run_at) and every status
--      transition (queued -> running -> succeeded) rewrites this index
--      entry -- pure write-amplification on the hottest (catalog) job
--      path, where job_queue takes ~25k writes/day.
--
-- The replacement is keyed exactly to the query and to IMMUTABLE columns
-- only (scope_entity_type, scope_entity_id, created_at, id). It serves
-- the filter as a direct seek and the ORDER BY with no sort. Because none
-- of its key/predicate columns ever change for a given row, a job's
-- lifecycle (run_at bumps, status transitions) no longer MAINTAINS this
-- scope index -- removing its share of the write-amplification. (Note:
-- this removes this index as a HOT-update blocker, but does not by itself
-- guarantee HOT updates: other indexes such as job_queue_priority_ready_idx
-- include run_at / a status predicate and can still block HOT on queued
-- lifecycle updates.) It stays partial (scope_entity_type/scope_entity_id
-- NOT NULL) so it only covers the ~31% of rows that carry a scope.
--
-- Cost: the scope-filtered job_queue reads are low-frequency operator
-- debug/list views returning small pages; with this index the debug
-- query is a sub-millisecond seek instead of a 35 ms parallel seq scan,
-- at strictly LOWER steady-state write cost than the index it replaces
-- (narrower, and no maintenance on status/run_at changes).

\set ON_ERROR_STOP on
\timing on

-- Both statements use CONCURRENTLY and therefore must run OUTSIDE a
-- transaction block (PostgreSQL forbids CREATE/DROP INDEX CONCURRENTLY
-- inside BEGIN). Both use IF [NOT] EXISTS so a clean rerun is safe.
-- Caveat: if the CREATE is interrupted it can leave an INVALID
-- same-name index; a plain rerun would then skip it via IF NOT EXISTS.
-- In that case drop the invalid leftover first
--   (drop index concurrently if exists public.job_queue_scope_created_at_idx;)
-- and rerun. The 090 sentinel uses validIndexExists, so an invalid
-- leftover is correctly reported as NOT applied.

-- Create the correctly-keyed replacement FIRST so the scope query is
-- always served by an index (no window where neither exists).
create index concurrently if not exists job_queue_scope_created_at_idx
  on job_queue (scope_entity_type, scope_entity_id, created_at desc, id desc)
  where scope_entity_type is not null and scope_entity_id is not null;

-- Then drop the mis-keyed, write-amplifying original.
drop index concurrently if exists job_queue_scope_status_run_at_idx;

\echo '090 re-keyed job_queue scope-lookup index (created job_queue_scope_created_at_idx, dropped job_queue_scope_status_run_at_idx).'
