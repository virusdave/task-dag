import { describe, expect, it } from 'vitest'

import { buildGhostResponse, resolveGhostConfig } from './ghostRiders.js'
import type { MetricRow } from './types.js'

// Business days roll over at 08:00 ET (= 13:00Z in winter / EST). All the
// dates below are inside winter so the business-day start is 13:00Z. See
// timeBuckets.test.ts for the full rationale.

describe('resolveGhostConfig — weekday period', () => {
  it('steps the ghosts back one week at a time (same weekday)', () => {
    // Anchor mid-day on Wed 2025-01-15 (business day Jan 15).
    const cfg = resolveGhostConfig({
      period: 'weekday',
      lookback: 3,
      to: null,
      now: new Date('2025-01-15T18:00:00Z'),
    })
    // Period 0 = Jan 15; each older ghost is the SAME weekday a week
    // earlier: Jan 8, Jan 1, Dec 25.
    expect(cfg.periods.map((p) => p.start.toISOString())).toEqual([
      '2025-01-15T13:00:00.000Z',
      '2025-01-08T13:00:00.000Z',
      '2025-01-01T13:00:00.000Z',
      '2024-12-25T13:00:00.000Z',
    ])
    // Each period spans exactly one business day.
    for (const p of cfg.periods) {
      expect(p.end.getTime() - p.start.getTime()).toBe(24 * 60 * 60 * 1000)
    }
    // Fine buckets are hourly (24 per period).
    expect(cfg.bucketAgg).toBe('hour')
    expect(cfg.periods[0]!.bucketStarts.length).toBe(24)
    // Fetch window spans the oldest ghost start through the anchor.
    expect(cfg.fetchFrom.toISOString()).toBe('2024-12-25T13:00:00.000Z')
  })

  it('differs from the day period, which steps consecutive days', () => {
    const day = resolveGhostConfig({
      period: 'day',
      lookback: 2,
      to: null,
      now: new Date('2025-01-15T18:00:00Z'),
    })
    expect(day.periods.map((p) => p.start.toISOString())).toEqual([
      '2025-01-15T13:00:00.000Z',
      '2025-01-14T13:00:00.000Z',
      '2025-01-13T13:00:00.000Z',
    ])
  })
})

describe('buildGhostResponse — weekday period', () => {
  it('produces hour-of-day phases and weekly cumulative ghosts', () => {
    const cfg = resolveGhostConfig({
      period: 'weekday',
      lookback: 1,
      to: null,
      now: new Date('2025-01-15T18:00:00Z'),
    })
    // One unit of "orders" in the 14:00Z hour (09:00 ET) of each period.
    const rawRows: MetricRow[] = [
      { t: '2025-01-15T14:00:00.000Z', orders: 2 },
      { t: '2025-01-08T14:00:00.000Z', orders: 5 },
    ] as unknown as MetricRow[]
    const { ghost, data } = buildGhostResponse({
      seriesIds: ['orders'],
      config: cfg,
      rawRows,
    })
    expect(ghost.period).toBe('weekday')
    expect(ghost.phaseUnit).toBe('hour')
    expect(ghost.phaseCount).toBe(24)
    // Phase 1 = the 14:00Z hour (business hour index 1, since hour 0 is
    // the 13:00Z open). Current period (age 0) cumulative = 2; the
    // 1-week-ago ghost (age 1) cumulative = 5.
    const phase1 = data[1]!
    expect(phase1.orders__ghost_0).toBe(2)
    expect(phase1.orders__ghost_1).toBe(5)
    // Ghost labels are week-relative.
    expect(ghost.periods.find((p) => p.age === 0)!.label).toBe('Today')
    expect(ghost.periods.find((p) => p.age === 1)!.label).toContain('1 week ago')
  })
})
