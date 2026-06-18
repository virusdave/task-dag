import { describe, expect, it } from 'vitest'

import type { MetricGrantKey, SessionUser } from '../contracts/domain/auth.js'
import { userHasAnyMetricGrant } from './metricGrants.js'
import {
  GADS_RESERVED_SUBPAGES,
  GADS_SCOPES,
  gadsScopeLabel,
  isGadsScope,
  mapGeoToGadsSite,
  requiredGadsGrants,
  type GadsScope,
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

// ---------------------------------------------------------------------------
// Access-enforcement matrix (P1 closure criteria).
//
// The server route gate composes EXACTLY these two pieces:
//
//   requireMetricsGrant(req, reply, ...requiredGadsGrants(site))
//     └─ internally: userHasAnyMetricGrant(user, requiredGadsGrants(site))
//
// so asserting `userHasAnyMetricGrant(user, requiredGadsGrants(scope))`
// here is a faithful regression test of the real per-scope access
// decision (the client tab-visibility filter uses the same pair, so a
// pass here also pins nav↔API parity). These cases enforce the epic's
// confidentiality invariants: per-site grants are strictly per-site,
// and `gads-all` is the ONLY grant that opens the cross-site view —
// it is never synthesised from holding every per-site grant.
// ---------------------------------------------------------------------------

/** Minimal non-admin viewer carrying exactly the given grants. */
function viewerWith(grants: ReadonlyArray<MetricGrantKey>): Pick<SessionUser, 'role' | 'metricGrants'> {
  return { role: 'viewer', metricGrants: [...grants] }
}

/** True iff `user` may read the GAds surface for `scope` (route-equivalent). */
function canRead(
  user: Pick<SessionUser, 'role' | 'metricGrants'>,
  scope: GadsScope,
): boolean {
  return userHasAnyMetricGrant(user, requiredGadsGrants(scope))
}

describe('GAds per-scope access enforcement', () => {
  it('Bronx-only user can read Bronx but NOT Midtown or the cross-site view', () => {
    const user = viewerWith(['gads-bronx'])
    expect(canRead(user, 'bronx')).toBe(true)
    expect(canRead(user, 'midtown')).toBe(false)
    expect(canRead(user, 'all')).toBe(false)
  })

  it('Midtown-only user can read Midtown but NOT Bronx or the cross-site view', () => {
    const user = viewerWith(['gads-midtown'])
    expect(canRead(user, 'midtown')).toBe(true)
    expect(canRead(user, 'bronx')).toBe(false)
    expect(canRead(user, 'all')).toBe(false)
  })

  it('holding BOTH per-site grants does NOT grant the cross-site view', () => {
    // gads-all is its own grant, never synthesised from the union of
    // the per-site grants (binding epic constraint).
    const user = viewerWith(['gads-bronx', 'gads-midtown'])
    expect(canRead(user, 'bronx')).toBe(true)
    expect(canRead(user, 'midtown')).toBe(true)
    expect(canRead(user, 'all')).toBe(false)
  })

  it('gads-all is a superset: it opens every per-site view AND the cross-site view', () => {
    const user = viewerWith(['gads-all'])
    expect(canRead(user, 'bronx')).toBe(true)
    expect(canRead(user, 'midtown')).toBe(true)
    expect(canRead(user, 'all')).toBe(true)
  })

  it('an unrelated metric grant grants no GAds scope at all', () => {
    const user = viewerWith(['explore'])
    for (const scope of GADS_SCOPES) expect(canRead(user, scope)).toBe(false)
  })

  it('a user with no grants is denied every GAds scope', () => {
    const user = viewerWith([])
    for (const scope of GADS_SCOPES) expect(canRead(user, scope)).toBe(false)
  })

  it('admins implicitly hold every scope (role shortcut)', () => {
    const admin: Pick<SessionUser, 'role' | 'metricGrants'> = { role: 'admin', metricGrants: [] }
    for (const scope of GADS_SCOPES) expect(canRead(admin, scope)).toBe(true)
  })

  it('the cross-site grant list leaks no per-site grant (denial reveals no other-site scope)', () => {
    // The route surfaces requiredGadsGrants(scope) in its 403 copy, so
    // the cross-site denial message must never enumerate a per-site
    // grant (which would hint at the confidential per-site surfaces).
    const allGrants = requiredGadsGrants('all')
    expect(allGrants).toEqual(['gads-all'])
    expect(allGrants).not.toContain('gads-bronx')
    expect(allGrants).not.toContain('gads-midtown')
  })
})

describe('mapGeoToGadsSite (automation#51 P2 site-scope derivation)', () => {
  it('maps the two real GADS_SITES geos through unchanged', () => {
    expect(mapGeoToGadsSite('bronx')).toBe('bronx')
    expect(mapGeoToGadsSite('midtown')).toBe('midtown')
  })

  it('collapses every non-GADS_SITES geo to null (unknown-scope)', () => {
    // pickGeoTarget can still return these, but they are not grant
    // scoped sites, so they must NOT attribute to a per-site page.
    expect(mapGeoToGadsSite('brooklyn')).toBeNull()
    expect(mapGeoToGadsSite('queens')).toBeNull()
    expect(mapGeoToGadsSite('manhattan')).toBeNull()
  })

  it('treats no-match / empty / null geo as unknown-scope', () => {
    expect(mapGeoToGadsSite(null)).toBeNull()
    expect(mapGeoToGadsSite(undefined)).toBeNull()
    expect(mapGeoToGadsSite('')).toBeNull()
    expect(mapGeoToGadsSite('whatever')).toBeNull()
  })

  it('never returns a value that is not a real per-site key', () => {
    // The mapper output is the stored gads_ad_attempts.site value;
    // anything other than a real site key must be null so per-site
    // predicates (site = $key) can never leak unknown-scope rows.
    for (const geo of ['bronx', 'midtown', 'brooklyn', 'queens', 'manhattan', 'x', '', null]) {
      const site = mapGeoToGadsSite(geo)
      expect(site === null || site === 'bronx' || site === 'midtown').toBe(true)
    }
  })
})
