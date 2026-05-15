export const DEFAULT_PRICING_GENERATOR_MODEL = 'deterministic-margin-band'
export const DEFAULT_PRICING_PROMPT_VERSION = 'pricing-deterministic-v2-market-evidence'

export const PRICING_POST_TAX_MULTIPLIER = 1.13
export const PRICING_TARGET_MIN_GM_PERCENT = 55
export const PRICING_TARGET_MAX_GM_PERCENT = 65
export const PRICING_FALLBACK_TARGET_GM_PERCENT = 64.5
export const PRICING_GM_FORMULA = 'GM% = 1 - 1.13 * cost / price'
export const PRICING_PREFERRED_ENDING_POLICY = '.00 and .50 when possible inside the target band'
export const PRICING_BELOW_MARKET_TARGET_MULTIPLIER = 0.97
export const PRICING_NEAR_DISTANCE_MAX_MILES = 1
export const PRICING_MID_DISTANCE_MAX_MILES = 3
export const PRICING_FAR_DISTANCE_MAX_MILES = 10
export const PRICING_NEAR_DISTANCE_WEIGHT = 5
export const PRICING_MID_DISTANCE_WEIGHT = 1
