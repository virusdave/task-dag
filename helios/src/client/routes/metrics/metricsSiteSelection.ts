// Shared site-chip selection logic for every /metrics page.
//
// Convention: an EMPTY set means "All sites". The chip strip behaves like
// a segmented control / radio group: "All", "Bronx", "Midtown" are
// mutually-exclusive states. Tapping a site chip switches focus to ONLY
// that site — it never adds to an implicit multi-select set, and never
// infers "All".
//
// The ONE and ONLY way to reach the all-sites view is the dedicated "All"
// chip (which sets the empty set directly, outside this helper). We almost
// never want the all-sites blend — our stores live in wildly different
// demographics with wildly different stock — so any behaviour that
// *infers* "All" from an ordinary chip tap (e.g. the old "selecting the
// last site collapses to All", or "deselecting the last site falls back to
// All") is a bug: it strands the operator on an unwanted, backend-expensive
// view that costs extra taps to escape.
//
// If genuine multi-site comparison is ever needed (3+ stores), add an
// explicit affordance (a "Compare sites" mode / checkboxes) rather than
// resurrecting hidden additive-toggle semantics here.
export function toggleSiteSelection(
  prev: ReadonlySet<string>,
  id: string,
  // Retained for call-site compatibility; radio semantics don't need it.
  _totalSiteCount: number,
): ReadonlySet<string> {
  // Already focused on exactly this site: keep it. Never toggle off to
  // "All" — that's the operator's most-hated accidental outcome, and the
  // explicit "All" chip is the only sanctioned path there.
  if (prev.size === 1 && prev.has(id)) return prev
  // Any other tap (from "All", from another site, or from a legacy
  // multi-site state) focuses exactly the tapped site.
  return new Set([id])
}

// Normalise an arbitrary site set (e.g. hydrated from a deep-link URL or
// persisted defaults) to the canonical radio form. An all-or-nothing set
// becomes "All" (empty); a strict multi-site set (a legacy/external state
// that the mutually-exclusive chip strip can't represent) collapses to a
// single, deterministic concrete site rather than lighting several chips.
export function normaliseSiteSelection(
  sites: ReadonlySet<string>,
  totalSiteCount: number,
): Set<string> {
  if (sites.size === 0 || sites.size >= totalSiteCount) return new Set()
  if (sites.size === 1) return new Set(sites)
  // size > 1 but a strict subset: pick the first concrete site so the
  // radio strip has exactly one lit chip (deterministic, no inferred All).
  const first = sites.values().next()
  return first.done ? new Set() : new Set([first.value])
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
