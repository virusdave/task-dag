// Shared site-chip selection logic for every /metrics page.
//
// Convention: an EMPTY set means "All sites". Individual site chips
// (Bronx / Midtown / …) are toggled against that set. We enforce two
// invariants so the chip strip can't reach a nonsensical state:
//
//   1. You can never light up every individual site at once — selecting
//      the last remaining site collapses to "All" (empty). The only way
//      to get an all-sites view is the dedicated "All" chip.
//   2. You can never deselect down to zero sites — turning off the last
//      lit site falls back to "All" rather than a no-sites view.
//
// For the current two sites this makes All / Bronx / Midtown behave as
// mutually-exclusive states. Genuine multi-select naturally returns once
// there are 3+ sites: selecting a STRICT subset (e.g. 2 of 3) stays
// explicit, and only the full set collapses to "All".
export function toggleSiteSelection(
  prev: ReadonlySet<string>,
  id: string,
  totalSiteCount: number,
): Set<string> {
  const next = new Set(prev)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  // Empty (deselected the last) or all-selected both canonicalise to the
  // "All" representation (empty set).
  if (next.size === 0 || next.size >= totalSiteCount) return new Set()
  return next
}

// Normalise an arbitrary site set (e.g. hydrated from a deep-link URL or
// persisted defaults) to the same canonical form: an all-or-nothing set
// becomes "All" (empty). Keeps deep links / saved state from rendering an
// invalid "every chip lit" or "every chip off but not All" state.
export function normaliseSiteSelection(
  sites: ReadonlySet<string>,
  totalSiteCount: number,
): Set<string> {
  if (sites.size === 0 || sites.size >= totalSiteCount) return new Set()
  return new Set(sites)
}

// The site every /metrics page defaults to when nothing else is
// specified (no deep-link param, no saved state). Our sites live in
// wildly different demographics with wildly different stock levels, so
// an all-sites blend is almost never the view you actually want; we
// default to a single, concrete store instead.
export const DEFAULT_SITE_ID = 'midtown'

// Default site selection used to seed page state. Falls back to the
// all-sites view (empty set) only if the default site somehow isn't a
// known site.
export function defaultSiteSelection(
  knownSiteIds: ReadonlyArray<string> = [DEFAULT_SITE_ID],
): Set<string> {
  return knownSiteIds.includes(DEFAULT_SITE_ID) ? new Set([DEFAULT_SITE_ID]) : new Set()
}
