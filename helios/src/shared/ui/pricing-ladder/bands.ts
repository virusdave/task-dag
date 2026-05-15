/**
 * Distance-band schema for the canonical pricing-ladder UI control.
 *
 * Bands are the *primary* visual axis on the ladder:
 *   - dot color is by band
 *   - dot vertical position is by band
 *
 * Within a band, a continuous proximity factor (0..1) is computed (1 = at
 * the closest mile, 0 = at the band's outer edge). The renderer uses this
 * to:
 *   - shade the dot inside its band hue (closer = more saturated)
 *   - micro-adjust vertical position upward (closer = higher within band)
 *
 * Schema is the 5-tier scheme proven in
 *   catalog/purchases/2026-05-07/regenerate_review.py
 * extended with within-band proximity (new for the canonical control).
 */

export type DistanceBandKey = 'very-near' | 'near' | 'mid' | 'far' | 'statewide'

export interface DistanceBand {
  key: DistanceBandKey
  label: string
  /** Inclusive lower mile bound for the band (used to compute proximity). */
  lowerMiles: number
  /** Inclusive upper mile bound; null = unbounded (statewide). */
  upperMiles: number | null
  /** Base dot color for the band. */
  color: string
  /** Center vertical pixel position for the band on a 140px ladder. */
  trackTop: number
  /**
   * How many pixels of within-band vertical micro-adjustment are available.
   * The closest dot in the band is rendered at trackTop - microAdjustPx;
   * the farthest stays at trackTop. Keeps the band visually distinct while
   * giving sub-position information.
   */
  microAdjustPx: number
}

export const DISTANCE_BANDS: readonly DistanceBand[] = Object.freeze([
  { key: 'very-near', label: '\u22642 mi',  lowerMiles: 0,  upperMiles: 2,    color: '#1d7a4f', trackTop: 18, microAdjustPx: 8 },
  { key: 'near',      label: '2\u20135 mi',  lowerMiles: 2,  upperMiles: 5,    color: '#3aa269', trackTop: 36, microAdjustPx: 8 },
  { key: 'mid',       label: '5\u201315 mi', lowerMiles: 5,  upperMiles: 15,   color: '#caa53a', trackTop: 56, microAdjustPx: 8 },
  { key: 'far',       label: '15\u201350 mi', lowerMiles: 15, upperMiles: 50,  color: '#c87132', trackTop: 76, microAdjustPx: 8 },
  { key: 'statewide', label: '>50 mi / unknown', lowerMiles: 50, upperMiles: null, color: '#7d7569', trackTop: 96, microAdjustPx: 4 },
])

/** O(1) lookup: pick the band whose upperMiles bracket the given distance. */
export function bandForDistance(miles: number | null): DistanceBand {
  if (miles === null || !Number.isFinite(miles)) {
    return DISTANCE_BANDS[DISTANCE_BANDS.length - 1]
  }
  for (const band of DISTANCE_BANDS) {
    if (band.upperMiles === null || miles <= band.upperMiles) return band
  }
  return DISTANCE_BANDS[DISTANCE_BANDS.length - 1]
}

/**
 * Within-band proximity in [0, 1]. 1 = at the band's lower (closer) edge,
 * 0 = at the band's upper (farther) edge.
 *
 * Statewide / unknown distances always return 0 — they are treated as the
 * least-relevant evidence within their band slot.
 */
export function withinBandProximity(band: DistanceBand, miles: number | null): number {
  if (miles === null || !Number.isFinite(miles)) return 0
  if (band.upperMiles === null) {
    // Unbounded statewide band: there is no meaningful "closer" within it.
    return 0
  }
  const span = band.upperMiles - band.lowerMiles
  if (span <= 0) return 1
  const clamped = Math.min(band.upperMiles, Math.max(band.lowerMiles, miles))
  return (band.upperMiles - clamped) / span
}

/**
 * Compute the dot's final vertical pixel position within the ladder.
 * Closer dots inside a band sit higher, by up to `band.microAdjustPx`.
 */
export function topPxForListing(miles: number | null): number {
  const band = bandForDistance(miles)
  const proximity = withinBandProximity(band, miles)
  return band.trackTop - proximity * band.microAdjustPx
}

/**
 * Compute the dot's CSS background color, shaded toward the band's base
 * color by within-band proximity. Closer = more saturated. Uses
 * color-mix() (supported in all modern browsers); the renderer falls back
 * to the raw band color in older clients via CSS class.
 */
export function colorForListing(miles: number | null): string {
  const band = bandForDistance(miles)
  const proximity = withinBandProximity(band, miles)
  // Mix: closer dots are pure band color; farthest in band fade up to 35%
  // toward white. Statewide effectively stays at base since proximity = 0.
  const fadePercent = Math.round((1 - proximity) * 35)
  return `color-mix(in srgb, ${band.color}, white ${fadePercent}%)`
}
