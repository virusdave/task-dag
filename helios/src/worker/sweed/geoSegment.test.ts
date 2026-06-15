import { describe, expect, it } from 'vitest'

import {
  approxMeters,
  chunk,
  feetToMeters,
  mergeCandidates,
  metersToFeet,
  ruleGeoMatches,
  ruleSinceSatisfied,
  type GeoSegmentRule,
  type PurchaseTriggerCandidate,
} from './geoSegment.js'

const BRONX_RULE: GeoSegmentRule = {
  id: 1,
  siteSlug: 'bx',
  dealerId: 210249,
  segmentId: 10282,
  centerLat: 40.855074,
  centerLng: -73.888066,
  radiusFeet: 3750,
  trigger: 'first_scan',
  reactivationDays: 365,
  since: new Date('2026-05-21T00:00:00-04:00'),
  enabled: true,
}

describe('ruleGeoMatches', () => {
  it('matches a point at the store center', () => {
    expect(ruleGeoMatches(BRONX_RULE, BRONX_RULE.centerLat, BRONX_RULE.centerLng)).toBe(true)
  })

  it('matches a point just inside the radius', () => {
    // 3750 ft ≈ 1143 m. ~0.005 deg lat ≈ 556 m north — well inside.
    expect(ruleGeoMatches(BRONX_RULE, 40.860074, -73.888066)).toBe(true)
  })

  it('rejects a point well outside the radius', () => {
    // ~0.02 deg lat ≈ 2.2 km north — outside 1143 m.
    expect(ruleGeoMatches(BRONX_RULE, 40.875074, -73.888066)).toBe(false)
  })

  it('is consistent with approxMeters at the boundary', () => {
    const radiusM = feetToMeters(BRONX_RULE.radiusFeet)
    // A point whose distance is ~10 m under the radius must match; one
    // ~10 m over must not. Walk north in small steps to bracket it.
    let insideLat = BRONX_RULE.centerLat
    while (approxMeters(BRONX_RULE.centerLat, BRONX_RULE.centerLng, insideLat, BRONX_RULE.centerLng) < radiusM - 10) {
      insideLat += 0.00001
    }
    expect(ruleGeoMatches(BRONX_RULE, insideLat, BRONX_RULE.centerLng)).toBe(true)
    let outsideLat = insideLat
    while (approxMeters(BRONX_RULE.centerLat, BRONX_RULE.centerLng, outsideLat, BRONX_RULE.centerLng) <= radiusM + 10) {
      outsideLat += 0.00001
    }
    expect(ruleGeoMatches(BRONX_RULE, outsideLat, BRONX_RULE.centerLng)).toBe(false)
  })
})

describe('ruleSinceSatisfied', () => {
  it('accepts events on/after the cutoff', () => {
    expect(ruleSinceSatisfied(BRONX_RULE, new Date('2026-05-21T00:00:00-04:00'))).toBe(true)
    expect(ruleSinceSatisfied(BRONX_RULE, new Date('2026-06-01T12:00:00-04:00'))).toBe(true)
  })

  it('rejects events before the cutoff', () => {
    expect(ruleSinceSatisfied(BRONX_RULE, new Date('2026-05-20T23:59:59-04:00'))).toBe(false)
  })

  it('accepts any event when there is no cutoff', () => {
    const noSince: GeoSegmentRule = { ...BRONX_RULE, since: null }
    expect(ruleSinceSatisfied(noSince, new Date('2000-01-01T00:00:00Z'))).toBe(true)
  })
})

describe('feet <-> meters', () => {
  it('round-trips 3750 ft', () => {
    expect(feetToMeters(3750)).toBeCloseTo(1143, 0)
    expect(metersToFeet(feetToMeters(3750))).toBeCloseTo(3750, 6)
  })
})

describe('approxMeters', () => {
  it('is ~0 for identical points', () => {
    expect(approxMeters(40.855074, -73.888066, 40.855074, -73.888066)).toBeCloseTo(0, 6)
  })

  it('matches a known short distance within tolerance', () => {
    // ~0.001 deg latitude ≈ 111.1 m at NYC latitudes.
    const d = approxMeters(40.855074, -73.888066, 40.856074, -73.888066)
    expect(d).toBeGreaterThan(105)
    expect(d).toBeLessThan(116)
  })

  it('is symmetric', () => {
    const a = approxMeters(40.85, -73.88, 40.86, -73.89)
    const b = approxMeters(40.86, -73.89, 40.85, -73.88)
    expect(a).toBeCloseTo(b, 6)
  })
})

describe('chunk', () => {
  it('splits into fixed-size groups', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
  it('returns empty for empty input', () => {
    expect(chunk([], 10)).toEqual([])
  })
  it('throws on non-positive size', () => {
    expect(() => chunk([1], 0)).toThrow()
  })
})

describe('mergeCandidates', () => {
  const purchase = (id: number, dist: number): PurchaseTriggerCandidate => ({
    sweedCustomerId: id,
    distanceMeters: dist,
    firstName: 'P',
    lastName: String(id),
  })

  it('dedupes a customer that qualifies under both triggers and keeps both labels', () => {
    const merged = mergeCandidates(
      [{ sweedCustomerId: 100, distanceMeters: 800, firstName: 'A', lastName: 'B' }],
      [purchase(100, 500)],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].sweedCustomerId).toBe(100)
    expect(merged[0].triggers).toEqual(['first_purchase', 'first_scan'])
    // keeps the minimum distance across qualifying events
    expect(merged[0].distanceMeters).toBe(500)
  })

  it('keeps separate customers and sorts by distance ascending', () => {
    const merged = mergeCandidates(
      [
        { sweedCustomerId: 1, distanceMeters: 900, firstName: 'X', lastName: 'Y' },
        { sweedCustomerId: 2, distanceMeters: 100, firstName: 'M', lastName: 'N' },
      ],
      [purchase(3, 400)],
    )
    expect(merged.map((m) => m.sweedCustomerId)).toEqual([2, 3, 1])
    expect(merged[0].triggers).toEqual(['first_scan'])
    expect(merged[1].triggers).toEqual(['first_purchase'])
  })

  it('builds a trimmed name and tolerates null name parts', () => {
    const merged = mergeCandidates(
      [{ sweedCustomerId: 7, distanceMeters: 10, firstName: 'Jane', lastName: null }],
      [],
    )
    expect(merged[0].name).toBe('Jane')
  })
})
