// Server-derived site predicate for the GAds evolver introspection read
// path (Evolution + Iteration endpoints, automation#51 P3).
//
// The site predicate is ALWAYS derived from the validated route scope,
// never from a client-supplied widening param. A per-site scope filters
// `site = $key` (which excludes unknown-scope `site is null` rows, so they
// can never leak into a per-site page); the cross-site `all` scope (gated
// behind the gads-all grant only) applies no site filter and therefore
// includes the NULL-scope rows, which the UI badges "site unknown". This
// is the single shared helper so every P3 query enforces the SAME rule.

import { GADS_SITES, type GadsScope, type GadsSiteKey } from '../../../shared/domain/gadsSites.js'

/** The concrete gads_ad_attempts.site values a scope covers. */
export function sitesForScope(scope: GadsScope): GadsSiteKey[] {
  if (scope === 'all') return GADS_SITES.map((s) => s.key)
  return [scope]
}

/**
 * Append the server-derived site predicate for `scope` to `params` and
 * return the SQL fragment (begins with a leading space + `and`, or '' for
 * the cross-site `all` scope). The caller binds the predicate with the
 * next positional parameter.
 */
export function appendGadsSitePredicate(params: unknown[], scope: GadsScope): string {
  if (scope === 'all') return ''
  // scope is a validated GadsSiteKey here (route revalidates isGadsScope).
  params.push(scope)
  return `and site = $${params.length}`
}
