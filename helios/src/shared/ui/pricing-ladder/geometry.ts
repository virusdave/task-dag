/**
 * Pure layout math for the canonical pricing-ladder.
 *
 * Inputs: a SKU's anchor prices (live, proposed, market avg/median) plus
 * an array of competitor listings.
 *
 * Outputs: a fully-positioned LadderGeometry that the renderer turns into
 * HTML. No DOM access, no rendering — this module is unit-testable in
 * isolation and shared by the static-HTML renderer and any future React
 * wrapper.
 */
import {
  DISTANCE_BANDS,
  type DistanceBand,
  type DistanceBandKey,
  bandForDistance,
  colorForListing,
  topPxForListing,
  withinBandProximity,
} from './bands.js'

export interface CompetitorListingInput {
  /** Stable identity (used for keys + dedupe). */
  listingId: string | number
  /** Post-tax price in USD. */
  postTaxPrice: number
  /** Distance from the storefront in miles; null = unknown. */
  distanceMiles: number | null
  dispensaryName: string | null
  dispensaryAddress?: string | null
  listingName?: string | null
  url?: string | null
  /** When false, the dot renders dimmer and is excluded from comp stats. */
  eligibleForPricing?: boolean
  /**
   * LitAlerts comp-matcher verdict for this listing:
   *  - `'exact'`     same brand × category × size × packCount lane.
   *  - `'fallback'`  brand-family match (same brand × category lane only,
   *                  size or pack differ).
   *  - `'weak'`      same brand only; size lane mismatched.
   * Listings with `'weak'` are filtered out of the ladder. Listings with
   * `'fallback'` render at 50% opacity to visually de-emphasise the
   * weaker comp tier without losing the price signal entirely.
   * Defaults to `'exact'` when omitted (back-compat for callers that
   * have not yet plumbed matchTier through).
   */
  matchTier?: 'exact' | 'fallback' | 'weak'
}

/**
 * Alias kept for callers that import `CompetitorListing` rather than
 * `CompetitorListingInput`. The two are the same shape.
 */
export type CompetitorListing = CompetitorListingInput

export interface PricingLadderInput {
  /** Sweed product id (rendered as data-product-id; used by slider script). */
  productId: string | number
  livePrice: number | null
  proposedPrice: number | null
  marketAveragePostTax: number | null
  marketMedianPostTax: number | null
  competitorListings: CompetitorListingInput[]
  /** Optional explicit domain override; otherwise computed from anchors. */
  domainMin?: number
  domainMax?: number
  /**
   * Maximum number of competitor dots to plot. When the (visible, finite)
   * listing count exceeds this, only the closest-by-distance subset is
   * rendered; stats/markers/domain still use the full set. Omit (or pass
   * undefined) to plot every dot. See buildLadderGeometry for rationale.
   */
  competitorDotCap?: number
}

export interface LadderMarkerGeometry {
  kind: 'live' | 'proposed' | 'market-average' | 'market-median'
  postTaxPrice: number
  leftPercent: number
}

export interface LadderCompetitorGeometry {
  listingId: string | number
  postTaxPrice: number
  /** Horizontal position on the ladder (0..100). */
  leftPercent: number
  /** Vertical pixel position (band-driven, with within-band micro-adjust). */
  topPx: number
  /** Color string for the dot (band hue shaded by within-band proximity). */
  color: string
  /** Distance band key (also rendered as a CSS class for theming). */
  bandKey: DistanceBandKey
  /** Within-band proximity in [0, 1]. */
  proximity: number
  distanceMiles: number | null
  dispensaryName: string | null
  dispensaryAddress: string | null
  listingName: string | null
  url: string | null
  eligibleForPricing: boolean
  /**
   * Verdict from the LitAlerts comp matcher. `'weak'` listings are
   * dropped before geometry is built, so this is always `'exact'` or
   * `'fallback'` here. Drives 50% opacity on the rendered dot for
   * `'fallback'` so reviewers can see at a glance which dots are
   * brand-family matches versus exact-match comps.
   */
  matchTier: 'exact' | 'fallback'
}

export interface LadderStats {
  /** Q1, median, Q3 across pricing-eligible listings. */
  q1PostTax: number | null
  medianPostTax: number | null
  q3PostTax: number | null
  /** Min/max across pricing-eligible listings. */
  minPostTax: number | null
  maxPostTax: number | null
  /** Count of pricing-eligible competitor listings. */
  pricingCompCount: number
  /** Total competitor listings (eligible + display-only). */
  totalCompCount: number
  /**
   * Number of dots actually plotted. Equals the plottable count unless a
   * `competitorDotCap` trimmed the chart, in which case it is the cap.
   */
  renderedCompCount: number
  /** Per-band counts. */
  bandCounts: Record<DistanceBandKey, number>
}

export interface LadderGeometry {
  productId: string | number
  domainMin: number
  domainMax: number
  /** IQR band rectangle (left%, width%); null when no listings. */
  iqr: { leftPercent: number; widthPercent: number } | null
  markers: LadderMarkerGeometry[]
  competitors: LadderCompetitorGeometry[]
  stats: LadderStats
  /** Distance bands present in this ladder, in render order. */
  bandsPresent: DistanceBand[]
}

export function buildLadderGeometry(input: PricingLadderInput): LadderGeometry {
  // Drop `weak` comps before doing anything else: they are same-brand
  // listings whose size lane doesn't match the SKU we're pricing, so
  // their price signal is misleading on the ladder. Reviewer sees only
  // exact-match and brand-family (fallback) comps.
  const visibleListings = input.competitorListings.filter(
    (l) => (l.matchTier ?? 'exact') !== 'weak',
  )
  const eligibleListings = visibleListings.filter((l) => l.eligibleForPricing !== false)
  const eligiblePostTaxSorted = eligibleListings
    .map((l) => l.postTaxPrice)
    .filter((value): value is number => Number.isFinite(value))
    .sort((a, b) => a - b)

  const q1 = quantile(eligiblePostTaxSorted, 0.25)
  const median = quantile(eligiblePostTaxSorted, 0.5)
  const q3 = quantile(eligiblePostTaxSorted, 0.75)
  const min = eligiblePostTaxSorted.length > 0 ? eligiblePostTaxSorted[0] : null
  const max = eligiblePostTaxSorted.length > 0 ? eligiblePostTaxSorted[eligiblePostTaxSorted.length - 1] : null

  // Domain: include every anchor and every (visible) listing so nothing clips.
  const domainAnchors = [
    input.livePrice,
    input.proposedPrice,
    input.marketAveragePostTax,
    input.marketMedianPostTax,
    q1,
    q3,
    ...visibleListings.map((l) => l.postTaxPrice),
  ].filter((value): value is number => value !== null && Number.isFinite(value))

  let domainMin: number
  let domainMax: number
  if (domainAnchors.length === 0) {
    // No anchors: still draw a ladder centered on $0..$1 so the shell is
    // not malformed; the renderer will show an "no data" caption.
    domainMin = 0
    domainMax = 1
  } else {
    const rawMin = Math.min(...domainAnchors)
    const rawMax = Math.max(...domainAnchors)
    const padding = Math.max((rawMax - rawMin) * 0.08, 1)
    domainMin = input.domainMin ?? Math.max(0, rawMin - padding)
    domainMax = input.domainMax ?? rawMax + padding
    if (domainMax <= domainMin) {
      domainMax = domainMin + 1
    }
  }

  const positionPercent = (price: number): number => {
    if (domainMax <= domainMin) return 50
    const ratio = (price - domainMin) / (domainMax - domainMin)
    return Math.max(0, Math.min(100, ratio * 100))
  }

  const markers: LadderMarkerGeometry[] = []
  if (input.marketAveragePostTax !== null && Number.isFinite(input.marketAveragePostTax)) {
    markers.push({ kind: 'market-average', postTaxPrice: input.marketAveragePostTax, leftPercent: positionPercent(input.marketAveragePostTax) })
  }
  if (median !== null) {
    markers.push({ kind: 'market-median', postTaxPrice: median, leftPercent: positionPercent(median) })
  }
  if (input.livePrice !== null && Number.isFinite(input.livePrice)) {
    markers.push({ kind: 'live', postTaxPrice: input.livePrice, leftPercent: positionPercent(input.livePrice) })
  }
  if (input.proposedPrice !== null && Number.isFinite(input.proposedPrice)) {
    markers.push({ kind: 'proposed', postTaxPrice: input.proposedPrice, leftPercent: positionPercent(input.proposedPrice) })
  }

  const allCompetitors: LadderCompetitorGeometry[] = visibleListings
    .filter((l) => Number.isFinite(l.postTaxPrice))
    .map((l) => {
      const band = bandForDistance(l.distanceMiles)
      const proximity = withinBandProximity(band, l.distanceMiles)
      const matchTier = (l.matchTier ?? 'exact') as 'exact' | 'fallback'
      return {
        listingId: l.listingId,
        postTaxPrice: l.postTaxPrice,
        leftPercent: positionPercent(l.postTaxPrice),
        topPx: topPxForListing(l.distanceMiles),
        color: colorForListing(l.distanceMiles),
        bandKey: band.key,
        proximity,
        distanceMiles: l.distanceMiles,
        dispensaryName: l.dispensaryName,
        dispensaryAddress: l.dispensaryAddress ?? null,
        listingName: l.listingName ?? null,
        url: l.url ?? null,
        eligibleForPricing: l.eligibleForPricing !== false,
        matchTier,
      }
    })

  // Cap the number of rendered dots. A single popular brand/size can match
  // thousands of statewide listings, and the run-review page paints one dot
  // per listing per product — tens of thousands of DOM nodes that make the
  // page crawl. The dots are a visual distribution aid, not the source of
  // any statistic (q1/median/q3/min/max/counts above are all computed from
  // the FULL `eligibleListings`/`visibleListings` sets), so we can drop some
  // dots from the chart without changing any number the reviewer relies on.
  //
  // When a cap is requested and exceeded we keep the CLOSEST listings (by
  // distance), because the nearby competitors are the ones a reviewer cares
  // about first. The caller (CanonicalPricingLadder) can lift the cap on
  // demand so the full dot cloud loads when the operator expands a ladder.
  const cap = input.competitorDotCap
  const competitors =
    cap !== undefined && cap > 0 && allCompetitors.length > cap
      ? [...allCompetitors]
          .sort(byDistanceAscThenPrice)
          .slice(0, cap)
      : allCompetitors

  const iqr =
    q1 !== null && q3 !== null
      ? {
          leftPercent: positionPercent(q1),
          widthPercent: Math.max(positionPercent(q3) - positionPercent(q1), 0.6),
        }
      : null

  const bandCounts: Record<DistanceBandKey, number> = {
    'very-near': 0,
    near: 0,
    mid: 0,
    far: 0,
    statewide: 0,
  }
  // Band counts/legend describe the full market, not just the plotted subset,
  // so the legend stays complete even when a cap trims distant dots.
  for (const c of allCompetitors) bandCounts[c.bandKey] += 1

  const presentKeys = new Set<DistanceBandKey>(allCompetitors.map((c) => c.bandKey))
  const bandsPresent: DistanceBand[] = DISTANCE_BANDS.filter((band) => presentKeys.has(band.key))

  return {
    productId: input.productId,
    domainMin,
    domainMax,
    iqr,
    markers,
    competitors,
    stats: {
      q1PostTax: q1,
      medianPostTax: median,
      q3PostTax: q3,
      minPostTax: min,
      maxPostTax: max,
      pricingCompCount: eligibleListings.length,
      totalCompCount: visibleListings.length,
      renderedCompCount: competitors.length,
      bandCounts,
    },
    bandsPresent,
  }
}

/**
 * Order competitor dots so the closest dispensaries come first. Listings
 * with an unknown distance sort last; ties break on price for determinism.
 * Used to pick the "keep" subset when a competitorDotCap trims the chart.
 */
function byDistanceAscThenPrice(
  a: LadderCompetitorGeometry,
  b: LadderCompetitorGeometry,
): number {
  const da = a.distanceMiles ?? Number.POSITIVE_INFINITY
  const db = b.distanceMiles ?? Number.POSITIVE_INFINITY
  if (da !== db) return da - db
  return a.postTaxPrice - b.postTaxPrice
}

function quantile(sortedValues: number[], q: number): number | null {
  if (sortedValues.length === 0) return null
  if (sortedValues.length === 1) return sortedValues[0]
  const position = (sortedValues.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sortedValues[lower]
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower)
}
