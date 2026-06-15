import { describe, expect, it } from 'vitest'

import {
  GeoPredicateAstSchema,
  GeoSegmentRuleCreateBodySchema,
} from './geoSegmentRules.js'

describe('GeoPredicateAstSchema', () => {
  it('accepts a valid composable AST', () => {
    const ast = {
      version: 1,
      op: 'and',
      predicates: [
        { kind: 'geofence', centerLat: 40.85, centerLng: -73.88, radiusFeet: 3750 },
        { kind: 'zip5_in', zip5: ['10453', '10458'] },
        { kind: 'us_state_in', states: ['NY'] },
        { kind: 'scan_time_window', since: '2026-05-21T04:00:00Z' },
        { kind: 'first_scan_in_days', days: 365 },
        { kind: 'age_range', minAge: 65 },
        { kind: 'gender_in', genders: ['F', 'X'] },
      ],
    }
    expect(GeoPredicateAstSchema.safeParse(ast).success).toBe(true)
  })

  it('rejects an unknown predicate kind', () => {
    const r = GeoPredicateAstSchema.safeParse({ version: 1, op: 'and', predicates: [{ kind: 'nope' }] })
    expect(r.success).toBe(false)
  })

  it('rejects duplicate predicate kinds', () => {
    const r = GeoPredicateAstSchema.safeParse({
      version: 1,
      op: 'and',
      predicates: [
        { kind: 'zip5_in', zip5: ['10453'] },
        { kind: 'zip5_in', zip5: ['10458'] },
      ],
    })
    expect(r.success).toBe(false)
  })

  it('rejects an empty scan_time_window and a reversed window', () => {
    expect(GeoPredicateAstSchema.safeParse({ version: 1, op: 'and', predicates: [{ kind: 'scan_time_window' }] }).success).toBe(false)
    expect(
      GeoPredicateAstSchema.safeParse({
        version: 1,
        op: 'and',
        predicates: [{ kind: 'scan_time_window', since: '2026-07-01T00:00:00Z', until: '2026-05-01T00:00:00Z' }],
      }).success,
    ).toBe(false)
  })

  it('rejects an age_range with min > max and an empty age_range', () => {
    expect(GeoPredicateAstSchema.safeParse({ version: 1, op: 'and', predicates: [{ kind: 'age_range', minAge: 70, maxAge: 30 }] }).success).toBe(false)
    expect(GeoPredicateAstSchema.safeParse({ version: 1, op: 'and', predicates: [{ kind: 'age_range' }] }).success).toBe(false)
  })

  it('rejects a non-5-digit ZIP and a non-2-letter state', () => {
    expect(GeoPredicateAstSchema.safeParse({ version: 1, op: 'and', predicates: [{ kind: 'zip5_in', zip5: ['1045'] }] }).success).toBe(false)
    expect(GeoPredicateAstSchema.safeParse({ version: 1, op: 'and', predicates: [{ kind: 'us_state_in', states: ['New York'] }] }).success).toBe(false)
  })
})

describe('GeoSegmentRuleCreateBodySchema', () => {
  const base = {
    siteSlug: 'bx',
    dealerId: 210249,
    segmentId: 10282,
    trigger: 'first_scan',
  }

  it('accepts an enabled rule with at least one condition', () => {
    const r = GeoSegmentRuleCreateBodySchema.safeParse({
      ...base,
      predicateJson: { version: 1, op: 'and', predicates: [{ kind: 'zip5_in', zip5: ['10453'] }] },
    })
    expect(r.success).toBe(true)
  })

  it('rejects an enabled rule with no conditions', () => {
    const r = GeoSegmentRuleCreateBodySchema.safeParse({
      ...base,
      enabled: true,
      predicateJson: { version: 1, op: 'and', predicates: [] },
    })
    expect(r.success).toBe(false)
  })

  it('allows a disabled draft with no conditions', () => {
    const r = GeoSegmentRuleCreateBodySchema.safeParse({
      ...base,
      enabled: false,
      predicateJson: { version: 1, op: 'and', predicates: [] },
    })
    expect(r.success).toBe(true)
  })
})
