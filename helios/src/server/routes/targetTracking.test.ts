import { describe, expect, it } from 'vitest'

import type { TargetTrackingPerSiteConfig } from '../../shared/contracts/index.js'
import { mergeConfigsForResponse } from './targetTracking.js'

function perSite(
  siteKey: string,
  siteLabel: string,
  config: TargetTrackingPerSiteConfig['config'],
): TargetTrackingPerSiteConfig {
  return { siteKey, siteLabel, config, updatedBy: config ? 'a@b.c' : null, updatedAt: config ? '2026-01-01T00:00:00.000Z' : null }
}

describe('mergeConfigsForResponse', () => {
  it('returns null when no site is configured', () => {
    expect(
      mergeConfigsForResponse([perSite('bronx', 'Bronx', null), perSite('midtown', 'Midtown', null)]),
    ).toBeNull()
  })

  it('returns the single configured site verbatim', () => {
    const cfg = {
      version: 1 as const,
      fixedCosts: [{ label: 'Rent', monthlyDollars: 5000 }],
      laborRateDollarsPerHour: 25,
      weeklyStaffedHours: 100,
    }
    const merged = mergeConfigsForResponse([
      perSite('bronx', 'Bronx', cfg),
      perSite('midtown', 'Midtown', null),
    ])
    expect(merged).toEqual(cfg)
  })

  it('preserves fixed + labour totals across multiple sites (weighted blended rate)', () => {
    const bronx = {
      version: 1 as const,
      fixedCosts: [
        { label: 'Rent', monthlyDollars: 4000 },
        { label: 'Power', monthlyDollars: 1000 },
      ],
      laborRateDollarsPerHour: 20,
      weeklyStaffedHours: 100,
    }
    const midtown = {
      version: 1 as const,
      fixedCosts: [{ label: 'Rent', monthlyDollars: 8000 }],
      laborRateDollarsPerHour: 30,
      weeklyStaffedHours: 50,
    }
    const merged = mergeConfigsForResponse([
      perSite('bronx', 'Bronx', bronx),
      perSite('midtown', 'Midtown', midtown),
    ])!

    // Fixed subtotals, one line per site.
    expect(merged.fixedCosts).toEqual([
      { label: 'Bronx fixed costs', monthlyDollars: 5000 },
      { label: 'Midtown fixed costs', monthlyDollars: 8000 },
    ])
    // Total monthly fixed preserved.
    const totalFixed = merged.fixedCosts.reduce((s, c) => s + c.monthlyDollars, 0)
    expect(totalFixed).toBe(13000)

    // Weighted blended rate: (20*100 + 30*50) / (100+50) = 3500/150.
    expect(merged.weeklyStaffedHours).toBe(150)
    expect(merged.laborRateDollarsPerHour).toBeCloseTo(3500 / 150, 9)
    // The product (= total weekly labour $) is preserved exactly: 3500.
    expect(merged.laborRateDollarsPerHour * merged.weeklyStaffedHours).toBeCloseTo(3500, 6)
  })

  it('handles a configured site with zero staffed hours without dividing by zero', () => {
    const a = {
      version: 1 as const,
      fixedCosts: [],
      laborRateDollarsPerHour: 0,
      weeklyStaffedHours: 0,
    }
    const b = {
      version: 1 as const,
      fixedCosts: [{ label: 'Rent', monthlyDollars: 1000 }],
      laborRateDollarsPerHour: 0,
      weeklyStaffedHours: 0,
    }
    const merged = mergeConfigsForResponse([
      perSite('bronx', 'Bronx', a),
      perSite('midtown', 'Midtown', b),
    ])!
    expect(merged.weeklyStaffedHours).toBe(0)
    expect(merged.laborRateDollarsPerHour).toBe(0)
  })
})
