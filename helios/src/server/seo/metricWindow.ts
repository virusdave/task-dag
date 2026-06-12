// Shared date-window guardrails for the SEO metrics + recommendation APIs
// (P5 — the GA4/GSC feedback loop). Both `/api/seo/metrics/overview` and
// `/api/seo/recommendations/generate` accept an operator-supplied
// [startDate, endDate) window that fans out into bounded aggregation
// queries. The per-query LIMIT caps result size, but an unbounded window
// still forces a wide index range scan; we cap the window server-side so a
// single request can't sweep the entire fact table (canon §3 DB budget).
//
// child FreshlyBakedNYC/automation#44 (P5) · Satisfies: virusdave/top-level#15

/** Largest [startDate, endDate) window any SEO metric API will serve, in days. */
export const MAX_SEO_WINDOW_DAYS = 180

/**
 * Whole-day span between two `YYYY-MM-DD` dates (endDate exclusive). Both
 * inputs must already be validated as ISO calendar dates. Computed in UTC so
 * DST has no effect on the day count.
 */
export function isoWindowDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = Date.parse(`${endDate}T00:00:00Z`)
  return Math.round((end - start) / 86_400_000)
}

/** True iff the [startDate, endDate) window is within the served cap. */
export function isWindowWithinCap(startDate: string, endDate: string): boolean {
  return isoWindowDays(startDate, endDate) <= MAX_SEO_WINDOW_DAYS
}
