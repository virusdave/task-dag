// GAds (Google Ads) analytics surface — site ↔ grant ↔ IA model.
//
// Single source of truth shared by client and server for the new
// `/metrics/gads-<site>/<subpage>` surface (parent epic
// virusdave/top-level#18). The first surface is the per-site
// "Landing pages" analytics sub-page built directly over `lp_events`
// (the unified-landing-engine conversion-feedback sink, migration
// 070). These dashboards expose confidential evolution-engine
// internals, so access is gated by dedicated per-site metric grants:
//
//   * gads-bronx    → /metrics/gads-bronx/...    (Bronx only)
//   * gads-midtown  → /metrics/gads-midtown/...  (Midtown only)
//   * gads-all      → /metrics/gads-all/...       (every site, superset)
//
// `gads-all` is a SUPERSET grant: it covers the cross-site view AND
// every individual site view (current and future). Per-site grants
// (gads-bronx, gads-midtown) only cover their own site. The
// requiredGadsGrants() helper below is the canonical gate used by
// both the server endpoint and the client tab/sidebar visibility, so
// the two never drift.

import type { MetricGrantKey } from '../contracts/domain/auth.js'

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/** Per-site keys. Mirror `site` values in `lp_events` and the
 *  pendingPurchases site dealers (bronx / midtown). */
export type GadsSiteKey = 'bronx' | 'midtown'

export interface GadsSite {
  /** Matches `lp_events.site` and the per-site grant suffix. */
  readonly key: GadsSiteKey
  /** Human-readable label for tabs / KPI copy. */
  readonly label: string
  /** Per-site grant required to view this site's surface. */
  readonly grant: MetricGrantKey
}

export const GADS_SITES: ReadonlyArray<GadsSite> = [
  { key: 'bronx', label: 'Bronx', grant: 'gads-bronx' },
  { key: 'midtown', label: 'Midtown', grant: 'gads-midtown' },
] as const

/** The superset grant: every current and future GAds site. */
export const GADS_ALL_GRANT: MetricGrantKey = 'gads-all'

/**
 * Map a raw geo target (as produced by the ads pipeline's
 * `pickGeoTarget()` — 'bronx' | 'midtown' | 'brooklyn' | 'queens' |
 * 'manhattan' | null) onto a grant-scoped GAds site key, or `null` for
 * unknown / cross-site scope.
 *
 * Only the two real `GADS_SITES` (bronx, midtown) map through; any other
 * geo (brooklyn/queens/manhattan) or no match collapses to `null`
 * ("unknown-scope"). This is the single canonical mapper used by the
 * `gads_ad_attempts.site` / `landingpage_ad_outcomes.site` write path
 * (automation#51 P2) — do NOT duplicate the substring list elsewhere;
 * derive the geo with the existing `pickGeoTarget()` and pass it here.
 *
 * `null` is meaningful: per-site reads filter `site = $key` (server
 * derived), which excludes `null`, so unknown-scope rows never leak into
 * a per-site page and appear only under the `gads-all` grant (badged).
 */
export function mapGeoToGadsSite(geo: string | null | undefined): GadsSiteKey | null {
  if (!geo) return null
  return GADS_SITES.some((s) => s.key === geo) ? (geo as GadsSiteKey) : null
}

// ---------------------------------------------------------------------------
// Scope (a site key, or the cross-site "all" view)
// ---------------------------------------------------------------------------

/** A request/tab scope: a single site, or the cross-site "all" view. */
export type GadsScope = GadsSiteKey | 'all'

/** All scopes in IA order (per-site first, then the cross-site view). */
export const GADS_SCOPES: ReadonlyArray<GadsScope> = [
  ...GADS_SITES.map((s) => s.key),
  'all',
]

export function isGadsScope(value: string): value is GadsScope {
  return value === 'all' || GADS_SITES.some((s) => s.key === value)
}

/** Display label for a scope (e.g. "Bronx", "Midtown", "All sites"). */
export function gadsScopeLabel(scope: GadsScope): string {
  if (scope === 'all') return 'All sites'
  return GADS_SITES.find((s) => s.key === scope)?.label ?? scope
}

/**
 * Grants that grant access to a scope (ANY-of semantics).
 *
 *   * scope 'all'      → only gads-all
 *   * scope '<site>'   → that site's grant OR gads-all (superset)
 *
 * Used by BOTH the server endpoint gate (requireMetricsGrant(...anyOf))
 * and the client tab/sidebar visibility filter, so they never drift.
 */
export function requiredGadsGrants(scope: GadsScope): ReadonlyArray<MetricGrantKey> {
  if (scope === 'all') return [GADS_ALL_GRANT]
  const site = GADS_SITES.find((s) => s.key === scope)
  // Unknown site keys must NOT collapse to an empty list (that would
  // 403 everyone) nor to gads-all (that would leak). Callers validate
  // the scope first via isGadsScope; this is a defensive fallback.
  if (!site) return [GADS_ALL_GRANT]
  return [site.grant, GADS_ALL_GRANT]
}

// ---------------------------------------------------------------------------
// Sub-pages (IA). V1 ships only "landing-pages"; the rest are reserved
// so the route validator and nav can grow without churn.
// ---------------------------------------------------------------------------

export type GadsSubPage =
  | 'landing-pages'
  | 'campaigns'
  | 'creative'
  | 'keywords'
  | 'policy-health'
  | 'experiments'
  | 'evolution'
  | 'iteration'

/** The only sub-page implemented in V1. */
export const GADS_DEFAULT_SUBPAGE: GadsSubPage = 'landing-pages'

/** Sub-pages that actually render in V1 (others are reserved IA). */
export const GADS_IMPLEMENTED_SUBPAGES: ReadonlyArray<GadsSubPage> = ['landing-pages']

/** All reserved sub-page slugs (implemented + future), for the route
 *  validator so an unknown slug 404s instead of silently defaulting
 *  to a different confidential page. */
export const GADS_RESERVED_SUBPAGES: ReadonlyArray<GadsSubPage> = [
  'landing-pages',
  'campaigns',
  'creative',
  'keywords',
  'policy-health',
  'experiments',
  'evolution',
  'iteration',
]
