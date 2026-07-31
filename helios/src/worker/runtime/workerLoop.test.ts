import { afterEach, describe, expect, it, vi } from 'vitest'

import { DependencyUnavailableWorkerError, SafeTerminalWorkerError } from './errors.js'
import type { LeasedJob } from './leaseJobs.js'
import { classifyWorkerFailure, runLeaseCoordinator } from './workerLoop.js'

afterEach(() => vi.restoreAllMocks())

describe('classifyWorkerFailure', () => {
  it.each([
    'catalog.inventory.stage_trade_samples',
    'catalog.inventory.zero_trade_samples',
  ] as const)('terminalizes destructive %s dependency failures with a fixed safe message', (jobType) => {
    const failure = classifyWorkerFailure(jobType, new DependencyUnavailableWorkerError('raw Sweed auth response'))
    expect(failure.dependencyUnavailable).toBe(true)
    expect(failure.destructiveTradeSample).toBe(true)
    expect(failure.message).toBe('Destructive trade-sample operation stopped safely; inspect Sweed. It will not retry automatically.')
    expect(failure.message).not.toContain('auth response')
  })

  it('surfaces an explicitly safe destructive-job failure message', () => {
    const failure = classifyWorkerFailure(
      'catalog.inventory.stage_trade_samples',
      new SafeTerminalWorkerError('Staging stopped during post-transfer verification for package 44: destination was not visible after 10 reads.'),
    )

    expect(failure.message).toBe(
      'Staging stopped during post-transfer verification for package 44: destination was not visible after 10 reads. It will not retry automatically.',
    )
  })
})

describe('worker lease coordinator', () => {
  it('starts later live work while an earlier background job remains open', async () => {
    const controller = new AbortController()
    const background = leasedJob(1)
    const live = leasedJob(2)
    let leaseCall = 0
    let wake: (() => void) | undefined
    let finishEmptyLease: (() => void) | undefined
    let backgroundSettled = false
    const started: number[] = []
    const pipelineError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const coordinator = runLeaseCoordinator(
      {
        allowedJobTypes: ['llm.debug.rerun'],
        pollIntervalMs: 1,
        runScheduler: false,
        retryBaseDelayMs: 1,
        maxAttempts: 1,
      },
      {
        delay: () => new Promise(() => undefined),
        executeJob: (job) => {
          started.push(job.id)
          if (job.id === background.id) {
            return new Promise<void>(() => undefined).finally(() => {
              backgroundSettled = true
            })
          }
          controller.abort()
          return Promise.reject(new Error('live pipeline test failure'))
        },
        lease: async () => {
          leaseCall += 1
          if (leaseCall === 1) return [background]
          if (leaseCall === 2) {
            await new Promise<void>((resolve) => {
              finishEmptyLease = resolve
            })
            return []
          }
          return [live]
        },
        signal: controller.signal,
        waitForWakeup: (signal) => new Promise<void>((resolve) => {
          const finish = (): void => {
            signal?.removeEventListener('abort', finish)
            resolve()
          }
          wake = finish
          signal?.addEventListener('abort', finish, { once: true })
        }),
      },
    )

    await vi.waitFor(() => expect(finishEmptyLease).toBeTypeOf('function'))
    // Emit while the empty lease query is still pending. The pre-armed
    // listener must retain this edge and skip the idle delay.
    wake!()
    finishEmptyLease!()
    await coordinator

    expect(started).toEqual([background.id, live.id])
    expect(backgroundSettled).toBe(false)
    expect(leaseCall).toBe(3)
    expect(pipelineError).toHaveBeenCalledWith(
      `[worker] job #${live.id} pipeline failed:`,
      expect.objectContaining({ message: 'live pipeline test failure' }),
    )
  })

  it('keeps an in-flight job running when a later lease/config read fails', async () => {
    const controller = new AbortController()
    let leaseCall = 0
    let backgroundSettled = false
    const leaseError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const coordinator = runLeaseCoordinator(
      {
        allowedJobTypes: ['llm.debug.rerun'], pollIntervalMs: 1,
        runScheduler: false, retryBaseDelayMs: 1, maxAttempts: 1,
      },
      {
        delay: () => new Promise(() => undefined),
        executeJob: () => new Promise<void>(() => undefined).finally(() => {
          backgroundSettled = true
        }),
        lease: async () => {
          leaseCall += 1
          if (leaseCall === 1) return [leasedJob(1)]
          throw new Error('capacity row unavailable')
        },
        signal: controller.signal,
        waitForWakeup: (signal) => new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true })
        }),
      },
    )

    await vi.waitFor(() => expect(leaseCall).toBe(2))
    controller.abort()
    await coordinator

    expect(backgroundSettled).toBe(false)
    expect(leaseError).toHaveBeenCalledWith(
      '[worker] lease/config failed; in-flight jobs continue:',
      expect.objectContaining({ message: 'capacity row unavailable' }),
    )
  })
})

function leasedJob(id: number): LeasedJob {
  return {
    attemptCount: 1,
    id,
    jobType: 'llm.debug.rerun',
    leaseToken: `lease-${id}`,
    module: 'config',
    payload: {},
    scope: null,
  }
}
