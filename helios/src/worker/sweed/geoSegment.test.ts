import { describe, expect, it } from 'vitest'

import {
  approxMeters,
  astMatches,
  chunk,
  computeAgeYears,
  feetToMeters,
  maxFirstScanDays,
  mergeCandidates,
  metersToFeet,
  normalizeGender,
  normalizeUsState,
  normalizeZip5,
  predicateMatches,
  type PurchaseTriggerCandidate,
  type ScanFacts,
} from './geoSegment.js'
import type { GeoPredicate, GeoPredicateAst } from '../../shared/contracts/index.js'

// Bronx store centre + the live rule's facts, reused across predicate tests.
const BX_LAT = 40.855074
const BX_LNG = -73.888066

const baseFacts: ScanFacts = {
  addressLat: BX_LAT,
  addressLng: BX_LNG,
  zip5: '10453',
  stateCode: 'NY',
  eventTime: new Date('2026-06-01T12:00:00-04:00'),
  personKey: 'p-1',
  latestPriorScanAt: null,
  birthDate: new Date('1980-06-01T00:00:00Z'),
  gender: 'F',
}

const facts = (over: Partial<ScanFacts>): ScanFacts => ({ ...baseFacts, ...over })

describe('predicateMatches — geofence', () => {
  const geo: GeoPredicate = { kind: 'geofence', centerLat: BX_LAT, centerLng: BX_LNG, radiusFeet: 3750 }

  it('matches at the centre and just inside', () => {
    expect(predicateMatches(geo, baseFacts)).toBe(true)
    expect(predicateMatches(geo, facts({ addressLat: 40.860074 }))).toBe(true)
  })
  it('rejects well outside the radius', () => {
    expect(predicateMatches(geo, facts({ addressLat: 40.875074 }))).toBe(false)
  })
  it('fails closed without coordinates', () => {
    expect(predicateMatches(geo, facts({ addressLat: null, addressLng: null }))).toBe(false)
  })
  it('matches at the boundary and rejects just beyond', () => {
    const radiusM = feetToMeters(3750)
    let insideLat = BX_LAT
    while (approxMeters(BX_LAT, BX_LNG, insideLat, BX_LNG) < radiusM - 10) insideLat += 0.00001
    expect(predicateMatches(geo, facts({ addressLat: insideLat }))).toBe(true)
    let outsideLat = insideLat
    while (approxMeters(BX_LAT, BX_LNG, outsideLat, BX_LNG) <= radiusM + 10) outsideLat += 0.00001
    expect(predicateMatches(geo, facts({ addressLat: outsideLat }))).toBe(false)
  })
})

describe('predicateMatches — zip5_in / us_state_in', () => {
  it('matches a ZIP in the set and rejects otherwise / when missing', () => {
    const p: GeoPredicate = { kind: 'zip5_in', zip5: ['10453', '10458'] }
    expect(predicateMatches(p, baseFacts)).toBe(true)
    expect(predicateMatches(p, facts({ zip5: '11375' }))).toBe(false)
    expect(predicateMatches(p, facts({ zip5: null }))).toBe(false)
  })
  it('matches a state in the set and fails closed when missing', () => {
    const p: GeoPredicate = { kind: 'us_state_in', states: ['NY', 'NJ'] }
    expect(predicateMatches(p, baseFacts)).toBe(true)
    expect(predicateMatches(p, facts({ stateCode: 'CT' }))).toBe(false)
    expect(predicateMatches(p, facts({ stateCode: null }))).toBe(false)
  })
})

describe('predicateMatches — scan_time_window', () => {
  it('honours inclusive since and exclusive until', () => {
    const since: GeoPredicate = { kind: 'scan_time_window', since: '2026-05-21T04:00:00Z' }
    expect(predicateMatches(since, facts({ eventTime: new Date('2026-05-21T04:00:00Z') }))).toBe(true)
    expect(predicateMatches(since, facts({ eventTime: new Date('2026-05-21T03:59:59Z') }))).toBe(false)
    const until: GeoPredicate = { kind: 'scan_time_window', until: '2026-07-01T00:00:00Z' }
    expect(predicateMatches(until, facts({ eventTime: new Date('2026-07-01T00:00:00Z') }))).toBe(false)
    expect(predicateMatches(until, facts({ eventTime: new Date('2026-06-30T23:59:59Z') }))).toBe(true)
  })
})

describe('predicateMatches — first_scan_in_days', () => {
  const p: GeoPredicate = { kind: 'first_scan_in_days', days: 365 }
  it('qualifies with no prior scan', () => {
    expect(predicateMatches(p, facts({ latestPriorScanAt: null }))).toBe(true)
  })
  it('disqualifies when a prior scan is within the window', () => {
    const recent = new Date(baseFacts.eventTime.getTime() - 100 * 86_400_000)
    expect(predicateMatches(p, facts({ latestPriorScanAt: recent }))).toBe(false)
  })
  it('qualifies at exactly N days (gap >= N)', () => {
    const exactly = new Date(baseFacts.eventTime.getTime() - 365 * 86_400_000)
    expect(predicateMatches(p, facts({ latestPriorScanAt: exactly }))).toBe(true)
  })
  it('fails closed without a person_key', () => {
    expect(predicateMatches(p, facts({ personKey: null }))).toBe(false)
  })
})

describe('predicateMatches — age_range / gender_in', () => {
  it('applies min/max age inclusively and fails closed without DOB', () => {
    const p: GeoPredicate = { kind: 'age_range', minAge: 65 }
    expect(predicateMatches(p, baseFacts)).toBe(false)
    expect(predicateMatches(p, facts({ birthDate: new Date('1955-01-01T00:00:00Z') }))).toBe(true)
    expect(predicateMatches(p, facts({ birthDate: null }))).toBe(false)
  })
  it('matches gender in the set, fails closed when null', () => {
    const p: GeoPredicate = { kind: 'gender_in', genders: ['F'] }
    expect(predicateMatches(p, baseFacts)).toBe(true)
    expect(predicateMatches(p, facts({ gender: 'M' }))).toBe(false)
    expect(predicateMatches(p, facts({ gender: null }))).toBe(false)
  })
})

describe('astMatches', () => {
  it('ANDs all predicates and fails closed on an empty AST', () => {
    const ast: GeoPredicateAst = {
      version: 1,
      op: 'and',
      predicates: [
        { kind: 'geofence', centerLat: BX_LAT, centerLng: BX_LNG, radiusFeet: 3750 },
        { kind: 'first_scan_in_days', days: 365 },
      ],
    }
    expect(astMatches(ast, baseFacts)).toBe(true)
    expect(astMatches(ast, facts({ addressLat: 40.9 }))).toBe(false)
    expect(astMatches({ version: 1, op: 'and', predicates: [] }, baseFacts)).toBe(false)
  })

  it('reproduces the Bronx rule (geofence + window + first-scan)', () => {
    const bronx: GeoPredicateAst = {
      version: 1,
      op: 'and',
      predicates: [
        { kind: 'geofence', centerLat: BX_LAT, centerLng: BX_LNG, radiusFeet: 3750 },
        { kind: 'first_scan_in_days', days: 365 },
        { kind: 'scan_time_window', since: '2026-05-21T04:00:00Z' },
      ],
    }
    expect(astMatches(bronx, baseFacts)).toBe(true)
    expect(astMatches(bronx, facts({ eventTime: new Date('2026-05-20T00:00:00Z') }))).toBe(false)
  })

  it('supports a zip-only rule with no geofence', () => {
    const zipRule: GeoPredicateAst = {
      version: 1,
      op: 'and',
      predicates: [{ kind: 'zip5_in', zip5: ['10453'] }],
    }
    expect(astMatches(zipRule, facts({ addressLat: null, addressLng: null }))).toBe(true)
  })
})

describe('maxFirstScanDays', () => {
  it('returns the largest window or null when none use it', () => {
    expect(
      maxFirstScanDays([
        { version: 1, op: 'and', predicates: [{ kind: 'first_scan_in_days', days: 90 }] },
        { version: 1, op: 'and', predicates: [{ kind: 'first_scan_in_days', days: 365 }] },
      ]),
    ).toBe(365)
    expect(maxFirstScanDays([{ version: 1, op: 'and', predicates: [{ kind: 'zip5_in', zip5: ['10453'] }] }])).toBe(null)
  })
})

describe('normalizers + computeAgeYears', () => {
  it('normalizeZip5 extracts 5 digits (incl. ZIP+4) else null', () => {
    expect(normalizeZip5('10453')).toBe('10453')
    expect(normalizeZip5('10453-1234')).toBe('10453')
    expect(normalizeZip5(' 10453 ')).toBe('10453')
    expect(normalizeZip5('abc')).toBe(null)
    expect(normalizeZip5(null)).toBe(null)
  })
  it('normalizeUsState upper-cases a 2-letter code else null', () => {
    expect(normalizeUsState('ny')).toBe('NY')
    expect(normalizeUsState('New York')).toBe(null)
    expect(normalizeUsState(null)).toBe(null)
  })
  it('normalizeGender maps to M/F/X else null', () => {
    expect(normalizeGender('MALE')).toBe('M')
    expect(normalizeGender('f')).toBe('F')
    expect(normalizeGender('X')).toBe('X')
    expect(normalizeGender('U')).toBe(null)
    expect(normalizeGender(null)).toBe(null)
  })
  it('computeAgeYears is calendar-correct around the birthday', () => {
    const dob = new Date('1980-06-15T00:00:00Z')
    expect(computeAgeYears(dob, new Date('2026-06-15T00:00:00Z'))).toBe(46)
    expect(computeAgeYears(dob, new Date('2026-06-14T00:00:00Z'))).toBe(45)
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
