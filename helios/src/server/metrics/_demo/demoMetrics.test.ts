import { describe, expect, it } from 'vitest'

import { metric as flatLine } from './flat_line.js'
import { metric as randomWalk } from './random_walk.js'

const window = {
  sites: [],
  from: new Date('2025-01-01T00:00:00Z'),
  to: new Date('2025-01-08T00:00:00Z'),
} as const

describe('_demo.flat_line', () => {
  it('returns a row per daily bucket with the constant 42 value', async () => {
    const data = await flatLine.query({ ...window, agg: 'date' })
    expect(data).toHaveLength(7)
    for (const row of data) {
      expect(row.value).toBe(42)
      expect(typeof row.t).toBe('string')
    }
  })
})

describe('_demo.random_walk', () => {
  it('returns two-series rows with values in [0, 100]', async () => {
    const data = await randomWalk.query({ ...window, agg: 'date' })
    expect(data.length).toBeGreaterThan(0)
    for (const row of data) {
      const a = row['series_a']
      const b = row['series_b']
      expect(typeof a).toBe('number')
      expect(typeof b).toBe('number')
      expect(a as number).toBeGreaterThanOrEqual(0)
      expect(a as number).toBeLessThanOrEqual(100)
      expect(b as number).toBeGreaterThanOrEqual(0)
      expect(b as number).toBeLessThanOrEqual(100)
    }
  })

  it('is deterministic for the same window+aggregation', async () => {
    const a = await randomWalk.query({ ...window, agg: 'date' })
    const b = await randomWalk.query({ ...window, agg: 'date' })
    expect(a).toEqual(b)
  })
})
