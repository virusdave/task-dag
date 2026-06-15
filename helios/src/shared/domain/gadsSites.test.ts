import { describe, expect, it } from 'vitest'

import {
  GADS_RESERVED_SUBPAGES,
  gadsScopeLabel,
  isGadsScope,
  requiredGadsGrants,
} from './gadsSites.js'

describe('isGadsScope', () => {
  it('accepts the per-site keys and the cross-site "all" scope', () => {
    expect(isGadsScope('bronx')).toBe(true)
    expect(isGadsScope('midtown')).toBe(true)
    expect(isGadsScope('all')).toBe(true)
  })

  it('rejects unknown scopes (so the route 400s instead of leaking)', () => {
    expect(isGadsScope('queens')).toBe(false)
    expect(isGadsScope('')).toBe(false)
    expect(isGadsScope('gads-all')).toBe(false)
  })
})

describe('requiredGadsGrants', () => {
  it('gates a single site on its own grant OR the gads-all superset', () => {
    expect(requiredGadsGrants('bronx')).toEqual(['gads-bronx', 'gads-all'])
    expect(requiredGadsGrants('midtown')).toEqual(['gads-midtown', 'gads-all'])
  })

  it('gates the cross-site view on gads-all ONLY (no per-site grant leaks in)', () => {
    expect(requiredGadsGrants('all')).toEqual(['gads-all'])
  })

  it('never returns an empty grant list (empty would 403 everyone, not leak)', () => {
    for (const scope of ['bronx', 'midtown', 'all'] as const) {
      expect(requiredGadsGrants(scope).length).toBeGreaterThan(0)
    }
  })
})

describe('gadsScopeLabel', () => {
  it('renders readable labels', () => {
    expect(gadsScopeLabel('bronx')).toBe('Bronx')
    expect(gadsScopeLabel('midtown')).toBe('Midtown')
    expect(gadsScopeLabel('all')).toBe('All sites')
  })
})

describe('GADS_RESERVED_SUBPAGES', () => {
  it('reserves the V1 page plus the future IA slugs', () => {
    expect(GADS_RESERVED_SUBPAGES).toContain('landing-pages')
    expect(GADS_RESERVED_SUBPAGES).toContain('campaigns')
    expect(GADS_RESERVED_SUBPAGES).toContain('evolution')
    expect(GADS_RESERVED_SUBPAGES).toContain('iteration')
  })
})
