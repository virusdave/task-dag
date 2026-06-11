import { describe, expect, it } from 'vitest'

import { evaluateRevenueGuardrail } from './revenueGuardrail.js'

describe('P6 evaluateRevenueGuardrail', () => {
  const healthy = { baseline: { impressions: 2000, conversions: 200 }, canary: { impressions: 2000, conversions: 190 }, dataAgeSeconds: 60 }

  it('holds when the canary is within tolerance', () => {
    const d = evaluateRevenueGuardrail(healthy)
    expect(d.action).toBe('hold')
    expect(d.baselineRateBps).toBe(1000)
    expect(d.canaryRateBps).toBe(950)
    expect(d.relativeDropBps).toBe(500) // 5% relative drop
  })

  it('flags would-revert on a >15% relative drop with auto-revert disabled (default)', () => {
    const d = evaluateRevenueGuardrail({
      baseline: { impressions: 2000, conversions: 200 }, // 10%
      canary: { impressions: 2000, conversions: 160 }, // 8% → 20% relative drop
      dataAgeSeconds: 60,
    })
    expect(d.relativeDropBps).toBe(2000)
    expect(d.action).toBe('would-revert')
  })

  it('returns revert only when auto-revert is explicitly enabled', () => {
    const d = evaluateRevenueGuardrail({
      baseline: { impressions: 2000, conversions: 200 },
      canary: { impressions: 2000, conversions: 160 },
      dataAgeSeconds: 60,
      config: { autoRevertEnabled: true },
    })
    expect(d.action).toBe('revert')
  })

  it('never acts on stale telemetry', () => {
    const d = evaluateRevenueGuardrail({
      baseline: { impressions: 2000, conversions: 200 },
      canary: { impressions: 2000, conversions: 0 }, // catastrophic, but...
      dataAgeSeconds: 60 * 60, // ...1h old
    })
    expect(d.action).toBe('stale-data')
  })

  it('requires a minimum sample before deciding', () => {
    const d = evaluateRevenueGuardrail({
      baseline: { impressions: 2000, conversions: 200 },
      canary: { impressions: 50, conversions: 0 }, // tiny sample
      dataAgeSeconds: 60,
    })
    expect(d.action).toBe('insufficient-data')
  })

  it('treats a zero baseline conversion rate as insufficient data', () => {
    const d = evaluateRevenueGuardrail({
      baseline: { impressions: 2000, conversions: 0 },
      canary: { impressions: 2000, conversions: 10 },
      dataAgeSeconds: 60,
    })
    expect(d.action).toBe('insufficient-data')
  })
})
