export const DEFAULT_PRICING_GENERATOR_MODEL = 'deterministic-margin-band'
export const DEFAULT_PRICING_PROMPT_VERSION = 'pricing-deterministic-v2-market-evidence'

export const PRICING_POST_TAX_MULTIPLIER = 1.13
export const PRICING_TARGET_MIN_GM_PERCENT = 55
export const PRICING_TARGET_MAX_GM_PERCENT = 65
export const PRICING_FALLBACK_TARGET_GM_PERCENT = 64.5
export const PRICING_GM_FORMULA = 'GM% = 1 - 1.13 * cost / price'

/**
 * Compute gross-margin percentage from a wholesale unit cost and a
 * post-tax retail price, using the canonical NY-cannabis formula
 * (`PRICING_GM_FORMULA`). Returns null when either input is missing,
 * non-finite, or the price is non-positive (so the SPA can render a
 * `—` without callers re-implementing the guards). Result is in
 * percentage units (e.g. `55.4`, not `0.554`).
 */
export function calculateGmPercent(
  costPerUnit: number | null | undefined,
  price: number | null | undefined,
): number | null {
  if (costPerUnit === null || costPerUnit === undefined) return null
  if (price === null || price === undefined) return null
  if (!Number.isFinite(costPerUnit) || !Number.isFinite(price)) return null
  if (price <= 0) return null
  return (1 - (PRICING_POST_TAX_MULTIPLIER * costPerUnit) / price) * 100
}
export const PRICING_PREFERRED_ENDING_POLICY = '.00 and .50 when possible inside the target band'
export const PRICING_BELOW_MARKET_TARGET_MULTIPLIER = 0.97
export const PRICING_NEAR_DISTANCE_MAX_MILES = 1
export const PRICING_MID_DISTANCE_MAX_MILES = 3
export const PRICING_FAR_DISTANCE_MAX_MILES = 10
export const PRICING_NEAR_DISTANCE_WEIGHT = 5
export const PRICING_MID_DISTANCE_WEIGHT = 1

/**
 * Multiplicative weight applied on top of the distance-band weight in
 * `buildWeightedAveragePrice` when blending exact-match vs brand-family
 * (fallback) competitor listings into the proposed price.
 *
 * Both tiers are *shown* on the pricing ladder so reviewers can see all
 * the comps we have, but family matches have noticeably less influence
 * on the proposed price than exact matches because they are size- /
 * format-adjacent rather than the literal same SKU.
 *
 * Effective weight = distance_band_weight × tier_weight
 *   exact + near    = 5  × 1.00 = 5.00
 *   fallback + near = 5  × 0.35 = 1.75
 *   exact + mid     = 1  × 1.00 = 1.00
 *   fallback + mid  = 1  × 0.35 = 0.35
 */
export const PRICING_EXACT_TIER_WEIGHT = 1
export const PRICING_FALLBACK_TIER_WEIGHT = 0.35
