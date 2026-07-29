import { describe, expect, it } from 'vitest'

import { DependencyUnavailableWorkerError } from './errors.js'
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
})
