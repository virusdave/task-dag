import { getWorkerEnv } from '../config/env.js'
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

        try {
          await ensureDependenciesReadyForJob(job.jobType, job.payload)
          await runJob({ id: job.id, jobType: job.jobType, module: job.module, payload: job.payload, scope: job.scope })
          await markJobSucceeded(job.id, job.leaseToken)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown worker error.'
          if (isDependencyUnavailableWorkerError(error)) {
            const delayMs = error.delayMs ?? getRetryDelayMs(0, env.workerRetryBaseDelayMs)
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
