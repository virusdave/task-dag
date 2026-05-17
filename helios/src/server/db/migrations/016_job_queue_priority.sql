-- Add a priority axis to job_queue so operator-initiated jobs can
-- jump ahead of system-generated background work.
--
-- Higher value = more urgent. Default 0 ("normal background work").
-- Helios UI / API callers that mark a job "high priority" should
-- enqueue with priority >= 100; the actual numeric scale is
-- intentionally not enforced so we can layer more bands later.
--
-- The lease query (src/worker/runtime/leaseJobs.ts) orders by
-- priority desc first, then run_at asc, then id asc — so an
-- operator-triggered priority=100 job placed AFTER a 2,000-row
-- system backlog still leases on the next worker tick.
--
-- Existing rows backfill to 0, matching the previous strictly-FIFO
-- behaviour.

alter table job_queue
  add column if not exists priority integer not null default 0;

-- Helpful for the lease query: queued, ready-to-run rows scanned in
-- priority desc, run_at asc order.
create index if not exists job_queue_priority_ready_idx
  on job_queue (priority desc, run_at asc, id asc)
  where status = 'queued';

-- One-shot: release the global 'sweed-session' concurrency funnel
-- on any rows still in the queue. Every Sweed-touching job now
-- claims its own exclusive row from the sweed_session_tokens pool
-- (see worker/sweed/activeSessionToken.ts and the matching update
-- to server/jobs/concurrency.ts) so funneling them through a
-- single concurrency_key actively caps throughput. Leaving the
-- value in place would keep blocking the 2,000+ catalog.sync.*
-- jobs that were enqueued before this fix landed.
update job_queue
   set concurrency_key = null
 where concurrency_key = 'sweed-session'
   and status in ('queued', 'leased');
