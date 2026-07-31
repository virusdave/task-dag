import { describe, expect, it } from 'vitest'

import { DependencyUnavailableWorkerError, SafeTerminalWorkerError } from './errors.js'
import { classifyWorkerFailure } from './workerLoop.js'

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
