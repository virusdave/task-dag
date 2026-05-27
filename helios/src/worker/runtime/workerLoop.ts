import { getWorkerEnv } from '../config/env.js'
import { JOB_PRIORITY_URGENT } from '../../server/jobs/enqueueJob.js'
import { recordAuthEvent, withJobAuthContext } from '../sweed/authLog.js'
import { tickConfigWorkersScheduler } from './configWorkersScheduler.js'
import { ensureDependenciesReadyForJob, warmDependencyHealth } from './dependencyHealth.js'
import { isDependencyUnavailableWorkerError, isRetryableWorkerError } from './errors.js'
import {
  getJobTypesForPoolSelector,
  shouldRunConfigWorkersSchedulerTickForPoolSelector,
} from './jobPools.js'
import { markJobDeadLetter, markJobDeferred, markJobFailed, markJobForRetry, markJobSucceeded, renewJobLease, runJob } from './jobRegistry.js'
import { leaseJobs } from './leaseJobs.js'
import type { JobType } from '../../shared/contracts/domain/jobs.js'

interface LeaseLoopOptions {
  label: string
  allowedJobTypes: JobType[]
  maxConcurrentJobs: number
  pollIntervalMs: number
  runScheduler: boolean
  minPriority?: number
  retryBaseDelayMs: number
  maxAttempts: number
}

/**
 * Runs both the main lease loop and a dedicated high-priority
 * fast-lane loop in parallel inside the same worker process.
 *
 * - **main loop** polls `pollIntervalMs` (default 3 s), leases up
 *   to `workerMaxConcurrentJobs` rows at any priority, and is the
 *   only loop that runs the config-workers scheduler tick.
 * - **fast-lane loop** polls `fastlanePollIntervalMs` (default
 *   10 s) and only leases jobs with `priority >= JOB_PRIORITY_URGENT`,
 *   capped at `fastlaneMaxConcurrentJobs` (default 2). This
 *   guarantees that operator-flagged urgent work never has to wait
 *   behind a fully-occupied main loop — even if the main loop is
 *   fully saturated processing best-effort backlog (e.g. the
 *   thousands of queued `litalerts_refresh.variant` jobs), the
 *   fast lane has its own independent concurrency slot.
 *
 * Both loops share the same database queue, so urgent work also
 * benefits from main-loop slack when the fast lane is busy: the
 * SQL `leaseJobs` selector orders by `priority desc` so a free
 * main-loop slot will still pick up urgent work before any
 * best-effort row.
 */
export async function runWorkerLoop(): Promise<never> {
  const env = getWorkerEnv()
  const allowedJobTypes = getJobTypesForPoolSelector(env.workerPool)
  const runScheduler = shouldRunConfigWorkersSchedulerTickForPoolSelector(env.workerPool)
  console.log(
    `[worker] pool=${env.workerPool} jobTypes=${allowedJobTypes.length} schedulerTick=${runScheduler} ` +
      `mainPollMs=${env.pollIntervalMs} mainMaxConcurrent=${env.workerMaxConcurrentJobs} ` +
      `fastlanePollMs=${env.fastlanePollIntervalMs} fastlaneMaxConcurrent=${env.fastlaneMaxConcurrentJobs} ` +
      `urgentMinPriority=${JOB_PRIORITY_URGENT}`,
  )
  await warmDependencyHealth()

  // Launch both loops; each is an infinite for(;;). Promise.all
  // never resolves (return type is `never`), but if either loop
  // throws to top-level the whole worker process exits and systemd
  // restarts it (`Restart=on-failure`) — same crash semantics as
  // before this refactor.
  await Promise.all([
    runLeaseLoop({
      label: 'main',
      allowedJobTypes,
      maxConcurrentJobs: env.workerMaxConcurrentJobs,
      pollIntervalMs: env.pollIntervalMs,
      runScheduler,
      retryBaseDelayMs: env.workerRetryBaseDelayMs,
      maxAttempts: env.workerMaxAttempts,
    }),
    runLeaseLoop({
      label: 'fastlane',
      allowedJobTypes,
      maxConcurrentJobs: env.fastlaneMaxConcurrentJobs,
      pollIntervalMs: env.fastlanePollIntervalMs,
      runScheduler: false,
      minPriority: JOB_PRIORITY_URGENT,
      retryBaseDelayMs: env.workerRetryBaseDelayMs,
      maxAttempts: env.workerMaxAttempts,
    }),
  ])

  // Unreachable, but the function signature is `Promise<never>` —
  // throwing here keeps the type-checker honest.
  throw new Error('runWorkerLoop unexpectedly resolved')
}

async function runLeaseLoop(opts: LeaseLoopOptions): Promise<never> {
  for (;;) {
    if (opts.runScheduler) {
      try {
        await tickConfigWorkersScheduler()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown scheduler error.'
        console.error(`[config-workers-scheduler] tick failed: ${message}`)
      }
    }

    const leasedJobs = await leaseJobs(opts.maxConcurrentJobs, {
      jobTypes: opts.allowedJobTypes,
      minPriority: opts.minPriority,
    })

    if (leasedJobs.length > 0 && opts.label !== 'main') {
      console.log(
        `[worker:${opts.label}] leased ${leasedJobs.length} job(s): ${leasedJobs
          .map((j) => `#${j.id}/${j.jobType}`)
          .join(', ')}`,
      )
    }

    await Promise.all(
      leasedJobs.map(async (job) => {
        const leaseHeartbeat = setInterval(() => {
          void renewJobLease(job.id, job.leaseToken)
        }, 60_000)

        // Wrap the WHOLE per-job pipeline (dependency probe + handler)
        // in withJobAuthContext so any sweed_auth_events row emitted
        // while preparing this job — most importantly the
        // verifySweedSession() probe that explodes with "Auth
        // expired" on a stale legacy token — gets tagged with the
        // job_id. Without this, probe failures appear in the audit
        // table with job_id = NULL and the operator-facing job
        // detail page (/jobs/:id) shows nothing useful even though
        // the worker is shouting in stderr.
        try {
          await withJobAuthContext({ jobId: job.id, jobType: job.jobType }, async () => {
            try {
              await ensureDependenciesReadyForJob(job.jobType, job.payload)
              await runJob({ id: job.id, jobType: job.jobType, module: job.module, payload: job.payload, scope: job.scope })
              await markJobSucceeded(job.id, job.leaseToken)
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unknown worker error.'
              if (isDependencyUnavailableWorkerError(error)) {
                const delayMs = error.delayMs ?? getRetryDelayMs(0, opts.retryBaseDelayMs)
                // Synthesize a sweed_auth_events row so the job detail
                // page can show *why* a job is stuck "queued" forever.
                // The probe itself already logs its own row when it
                // hits Sweed; this second row makes the connection
                // between "probe failure" and "this specific job is
                // deferred for delayMs" explicit in one place.
                recordAuthEvent({
                  rpcName: 'dependency.probe',
                  eventKind: 'rpc_error',
                  sessionOrigin: null,
                  authToken: null,
                  dealerId: null,
                  outcome: 'retryable',
                  httpStatus: null,
                  errorMessage: message,
                  durationMs: 0,
                  context: { deferredMs: delayMs, jobType: job.jobType },
                })
                await markJobDeferred(job.id, job.leaseToken, message, new Date(Date.now() + delayMs))
                return
              }

              if (isRetryableWorkerError(error)) {
                if (job.attemptCount >= opts.maxAttempts) {
                  await markJobDeadLetter(job.id, job.leaseToken, message)
                  return
                }

                const delayMs = error.delayMs ?? getRetryDelayMs(job.attemptCount, opts.retryBaseDelayMs)
                await markJobForRetry(job.id, job.leaseToken, message, new Date(Date.now() + delayMs))
                return
              }

              await markJobFailed(job.id, job.leaseToken, message)
            }
          })
        } finally {
          clearInterval(leaseHeartbeat)
        }
      }),
    )

    if (leasedJobs.length === 0) {
      await delay(opts.pollIntervalMs)
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

/**
 * Sub-exponential power-law backoff: base * attempt^1.5.
 *
 * Standing rule across the repo: all retry backoffs MUST be
 * sub-exponential (polynomial growth, e.g. n^1.5) rather than
 * exponential (a^n for any a > 1). Exponential schedules push the
 * later retries into multi-hour territory after only a handful of
 * attempts, which is exactly the "we'll get to it eventually" /
 * "timed out, gave up" behaviour we've ruled out for live work.
 * A polynomial schedule still gives the upstream room to breathe
 * while keeping the worst-case delay bounded and predictable.
 *
 * Sample (`baseDelayMs=1000`): 1s, 2.83s, 5.20s, 8s, 11.18s, 14.7s,
 * …, attempt 30 ≈ 164s — well under the 5-min cap.
 */
function getRetryDelayMs(attemptCount: number, baseDelayMs: number): number {
  const attempt = Math.max(attemptCount, 1)
  return Math.min(Math.round(baseDelayMs * Math.pow(attempt, 1.5)), 5 * 60 * 1000)
}
