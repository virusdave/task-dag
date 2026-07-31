import { describe, expect, it } from 'vitest'

import { DEFAULT_WORKER_CAPACITY_CONFIG, WorkerCapacityConfigSchema } from './workerCapacity.js'

describe('WorkerCapacityConfig', () => {
  it('defaults to G/L/U 1/2/1', () => {
    expect(DEFAULT_WORKER_CAPACITY_CONFIG).toEqual({ version: 1, generalSlots: 1, liveRequestedReservedSlots: 2, urgentReservedSlots: 1 })
  })

  it('requires nonnegative integer slots and a total from 1 through 32', () => {
    expect(() => WorkerCapacityConfigSchema.parse({ version: 1, generalSlots: 0, liveRequestedReservedSlots: 0, urgentReservedSlots: 0 })).toThrow()
    expect(() => WorkerCapacityConfigSchema.parse({ version: 1, generalSlots: 33, liveRequestedReservedSlots: 0, urgentReservedSlots: 0 })).toThrow()
    expect(() => WorkerCapacityConfigSchema.parse({ version: 1, generalSlots: 1.5, liveRequestedReservedSlots: 0, urgentReservedSlots: 0 })).toThrow()
  })
})
