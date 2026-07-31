import { getWorkerEnv } from '../config/env.js'
import { startJobQueueNotifyListener, waitForJobQueueWakeup } from '../../server/db/notify.js'
import { recordAuthEvent, withJobAuthContext } from '../sweed/authLog.js'
import { tickConfigWorkersScheduler } from './configWorkersScheduler.js'
import { ensureDependenciesReadyForJob, warmDependencyHealth } from './dependencyHealth.js'
import { isDependencyUnavailableWorkerError, isRetryableWorkerError, isSafeTerminalWorkerError } from './errors.js'
import {
  getJobTypesForPoolSelector,
  shouldRunConfigWorkersSchedulerTickForPoolSelector,
} from './jobPools.js'
import { markJobDeadLetter, markJobDeferred, markJobFailed, markJobForRetry, markJobSucceeded, renewJobLease, runJob } from './jobRegistry.js'
import { leaseJobs, type LeasedJob } from './leaseJobs.js'
import type { JobType } from '../../shared/contracts/domain/jobs.js'

export interface LeaseCoordinatorOptions {
  allowedJobTypes: JobType[]
  pollIntervalMs: number
  runScheduler: boolean
  retryBaseDelayMs: number
  maxAttempts: number
}

export interface LeaseCoordinatorDependencies {
  delay?: (milliseconds: number) => Promise<void>
  executeJob?: (job: LeasedJob, options: LeaseCoordinatorOptions) => Promise<void>
  lease?: typeof leaseJobs
  schedulerTick?: typeof tickConfigWorkersScheduler
  signal?: AbortSignal
  waitForWakeup?: typeof waitForJobQueueWakeup
}

export function classifyWorkerFailure(jobType: JobType, error: unknown): {
  dependencyUnavailable: boolean
  delayMs: number | undefined
  destructiveTradeSample: boolean
  message: string
} {
  // Classify the original error before applying the destructive-job terminal policy.
  const dependencyUnavailable = isDependencyUnavailableWorkerError(error)
  const destructiveTradeSample = jobType === 'catalog.inventory.stage_trade_samples'
    || jobType === 'catalog.inventory.zero_trade_samples'
  return {
    dependencyUnavailable,
    delayMs: dependencyUnavailable ? error.delayMs ?? undefined : undefined,
    destructiveTradeSample,
    message: destructiveTradeSample
      ? isSafeTerminalWorkerError(error)
        ? `${error.message} It will not retry automatically.`
        : 'Destructive trade-sample operation stopped safely; inspect Sweed. It will not retry automatically.'
      : error instanceof Error ? error.message : 'Unknown worker error.',
  }
}

/**
 * Runs one coordinator that launches jobs without waiting for the current
 * batch to settle. Global priority-reserved capacity is enforced atomically
 * by `leaseJobs`, so a newly queued live request can use a reserved slot while
 * a background job is still running.
 */
export async function runWorkerLoop(): Promise<never> {
  const env = getWorkerEnv()
  const allowedJobTypes = getJobTypesForPoolSelector(env.workerPool)
  const runScheduler = shouldRunConfigWorkersSchedulerTickForPoolSelector(env.workerPool)
  console.log(
    `[worker] pool=${env.workerPool} jobTypes=${allowedJobTypes.length} schedulerTick=${runScheduler} ` +
      `pollMs=${env.pollIntervalMs} capacity=database-configured`,
  )
  await warmDependencyHealth()
  // Phase B4 (virusdave/top-level#11): open the dedicated LISTEN
  // connection on the helios_job_queue channel so the lease loops
  // below can race their idle-cap delay against incoming NOTIFY
  // wakeups. Awaiting here means the listener is in place before
  // the first lease tick; if the connection drops at runtime the
  // helper reconnects on its own and the loops fall back to the
  // 60 s polling cap.
  await startJobQueueNotifyListener()

  await runLeaseCoordinator({
    allowedJobTypes,
    pollIntervalMs: env.pollIntervalMs,
    runScheduler,
    retryBaseDelayMs: env.workerRetryBaseDelayMs,
    maxAttempts: env.workerMaxAttempts,
  })

  // Unreachable, but the function signature is `Promise<never>` —
  // throwing here keeps the type-checker honest.
  throw new Error('runWorkerLoop unexpectedly resolved')
}

export async function runLeaseCoordinator(
  opts: LeaseCoordinatorOptions,
  injected: LeaseCoordinatorDependencies = {},
): Promise<void> {
  // Idle-poll backoff (db-cost-reduction). When `leaseJobs` returns
  // an empty result on consecutive ticks, sleep for a polynomially
  // growing duration capped at IDLE_POLL_MAX_SLEEP_MS so the
  // worker stops hammering TigerData with one expired-lease-sweep
  // + lease-CTE transaction every `pollIntervalMs` while idle.
  //
  // The backoff is reset to zero on any non-empty lease — live work
  // always sees full-speed polling on the very next iteration.
  //
  // Phase B3 capped this at 15 s. Phase B4 raises the cap to 60 s
  // because the new helios_job_queue LISTEN/NOTIFY plumbing
  // (server/db/notify.ts) gives us sub-second wake-up latency on
  // any real enqueue: the idle delay below is now
  // `Promise.race([delay(sleepMs), waitForJobQueueWakeup()])`, so
  // even at the 60 s cap a fresh enqueueJob commit reaches the
  // lease loop almost immediately. The cap then only matters for
  // pathological "queue is empty for 60 s straight AND nothing
  // gets enqueued" windows, e.g. overnight when the only activity
  // is the scheduler's own ticks.
  //
  // Schedule (with opts.pollIntervalMs = 3s, cap 60s): empty=1 →
  // 3s, empty=2 → ~8.5s, empty=4 → ~24s, empty=7+ → 60s. Idle
  // worker settles to one poll-transaction every 60 s instead of
  // every 3 s — a 20× reduction in baseline write-transactions
  // during quiet hours, on top of the wakeup latency win on real
  // enqueues.
  //
  // Polynomial (n^1.5) rather than exponential, per the canon's
  // "all backoffs must be sub-exponential" rule. Matches the
  // shape of getRetryDelayMs below.
  const IDLE_POLL_MAX_SLEEP_MS = 60_000
  let consecutiveEmptyPolls = 0
  const inFlight = new Set<Promise<void>>()
  const lease = injected.lease ?? leaseJobs
  const executeJob = injected.executeJob ?? executeLeasedJob
  const schedulerTick = injected.schedulerTick ?? tickConfigWorkersScheduler
  const waitForWakeup = injected.waitForWakeup ?? waitForJobQueueWakeup
  const waitDelay = injected.delay ?? delay

  while (!injected.signal?.aborted) {
    // Arm the wakeup before checking the queue. A notification can arrive
    // while the scheduler or lease query is in progress; retaining this
    // promise prevents that edge from becoming a lost wakeup followed by a
    // full idle-backoff sleep.
    const wakeController = new AbortController()
    const stopWaiting = (): void => wakeController.abort()
    injected.signal?.addEventListener('abort', stopWaiting, { once: true })
    const wakeup = waitForWakeup(wakeController.signal)

    if (opts.runScheduler) {
      try {
        await schedulerTick()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown scheduler error.'
        console.error(`[config-workers-scheduler] tick failed: ${message}`)
      }
    }

    let leasedJobs: LeasedJob[] = []
    try {
      leasedJobs = await lease({ jobTypes: opts.allowedJobTypes })
    } catch (error) {
      console.error('[worker] lease/config failed; in-flight jobs continue:', error)
    }

    for (const job of leasedJobs) {
      let task!: Promise<void>
      task = executeJob(job, opts).catch((error) => {
        console.error(`[worker] job #${job.id} pipeline failed:`, error)
      }).finally(() => inFlight.delete(task))
      inFlight.add(task)
    }

    if (leasedJobs.length === 0) {
      consecutiveEmptyPolls += 1
      const sleepMs = computeIdlePollSleepMs(
        consecutiveEmptyPolls,
        opts.pollIntervalMs,
        IDLE_POLL_MAX_SLEEP_MS,
      )
      // Race the polynomial idle delay against a fresh job-queue
      // wakeup (Phase B4). On a real enqueue the worker wakes up
      // within milliseconds; on a fully idle window it waits the
      // full sleepMs. The AbortController cleans up the wakeup
      // listener when the delay wins, so listeners never leak.
      try {
        const waits: Promise<void>[] = [
          waitDelay(sleepMs).then(() => wakeController.abort()),
          wakeup,
        ]
        if (inFlight.size > 0) waits.push(Promise.race(inFlight))
        await Promise.race(waits)
      } finally {
        injected.signal?.removeEventListener('abort', stopWaiting)
        if (!wakeController.signal.aborted) {
          wakeController.abort()
        }
      }
    } else {
      consecutiveEmptyPolls = 0
      injected.signal?.removeEventListener('abort', stopWaiting)
      wakeController.abort()
      await Promise.resolve()
    }
  }
}

async function executeLeasedJob(job: LeasedJob, opts: LeaseCoordinatorOptions): Promise<void> {
  const leaseHeartbeat = setInterval(() => {
    void renewJobLease(job.id, job.leaseToken).catch((error) => {
      console.error(`[worker] heartbeat failed for job #${job.id}:`, error)
    })
  }, 60_000)

  // Wrap the whole per-job pipeline in the job auth context so dependency
  // probe failures and Sweed auth events remain attributable to this job.
  try {
    await withJobAuthContext({ jobId: job.id, jobType: job.jobType }, async () => {
      try {
        await ensureDependenciesReadyForJob(job.jobType, job.payload)
        await runJob({ id: job.id, jobType: job.jobType, leaseToken: job.leaseToken, module: job.module, payload: job.payload, scope: job.scope })
        await markJobSucceeded(job.id, job.leaseToken)
      } catch (error) {
        const failure = classifyWorkerFailure(job.jobType, error)
        if (failure.destructiveTradeSample) {
          await markJobFailed(job.id, job.leaseToken, failure.message)
          return
        }
        if (failure.dependencyUnavailable) {
          const delayMs = failure.delayMs ?? getRetryDelayMs(0, opts.retryBaseDelayMs)
          recordAuthEvent({
            rpcName: 'dependency.probe',
            eventKind: 'rpc_error',
            sessionOrigin: null,
            authToken: null,
            dealerId: null,
            outcome: 'retryable',
            httpStatus: null,
            errorMessage: failure.message,
            durationMs: 0,
            context: { deferredMs: delayMs, jobType: job.jobType },
          })
          await markJobDeferred(job.id, job.leaseToken, failure.message, new Date(Date.now() + delayMs))
          return
        }
        if (isRetryableWorkerError(error)) {
          if (job.attemptCount >= opts.maxAttempts) {
            await markJobDeadLetter(job.id, job.leaseToken, failure.message)
            return
          }
          const delayMs = error.delayMs ?? getRetryDelayMs(job.attemptCount, opts.retryBaseDelayMs)
          await markJobForRetry(job.id, job.leaseToken, failure.message, new Date(Date.now() + delayMs))
          return
        }
        await markJobFailed(job.id, job.leaseToken, failure.message)
      }
    })
  } finally {
    clearInterval(leaseHeartbeat)
  }
}

/**
 * Polynomial idle-poll sleep: base * empty^1.5, capped at `maxMs`.
 * `empty = 1` (first empty poll) returns exactly `baseMs` so we
 * don't slow down the very first idle iteration. Subsequent empty
 * polls scale up to the cap. See `runLeaseLoop` for the rationale.
 *
 * Exported for unit-test coverage of the schedule shape.
 */
export function computeIdlePollSleepMs(
  consecutiveEmptyPolls: number,
  baseMs: number,
  maxMs: number,
): number {
  const n = Math.max(consecutiveEmptyPolls, 1)
  const raw = baseMs * Math.pow(n, 1.5)
  return Math.min(Math.round(raw), maxMs)
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
