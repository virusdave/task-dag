import { getWorkerEnv } from '../config/env.js'
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

export async function runWorkerLoop(): Promise<never> {
  const env = getWorkerEnv()
  const allowedJobTypes = getJobTypesForPoolSelector(env.workerPool)
  const runScheduler = shouldRunConfigWorkersSchedulerTickForPoolSelector(env.workerPool)
  console.log(
    `[worker] pool=${env.workerPool} jobTypes=${allowedJobTypes.length} schedulerTick=${runScheduler}`,
  )
  await warmDependencyHealth()

  for (;;) {
    if (runScheduler) {
      try {
        await tickConfigWorkersScheduler()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown scheduler error.'
        console.error(`[config-workers-scheduler] tick failed: ${message}`)
      }
    }

    const leasedJobs = await leaseJobs(env.workerMaxConcurrentJobs, { jobTypes: allowedJobTypes })

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
                const delayMs = error.delayMs ?? getRetryDelayMs(0, env.workerRetryBaseDelayMs)
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
                if (job.attemptCount >= env.workerMaxAttempts) {
                  await markJobDeadLetter(job.id, job.leaseToken, message)
                  return
                }

                const delayMs = error.delayMs ?? getRetryDelayMs(job.attemptCount, env.workerRetryBaseDelayMs)
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
      await delay(env.pollIntervalMs)
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function getRetryDelayMs(attemptCount: number, baseDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** Math.max(attemptCount - 1, 0), 5 * 60 * 1000)
}
