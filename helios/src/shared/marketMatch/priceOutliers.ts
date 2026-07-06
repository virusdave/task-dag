/**
 * Pure, deterministic price-outlier detection for the brand-categorical-family
 * market-match audit surface (issue #59, task T1).
 *
 * The operator reviews the LitAlerts listings the REAL matcher associates with
 * one brand-categorical-family and needs to quickly spot the rows worth
 * scrutinizing: a price that is a statistical outlier is either a mis-parse
 * skewing the price or a genuinely off competitor price. This helper flags
 * those rows as a REVIEW SIGNAL ONLY — it never removes, down-ranks, or
 * reorders a candidate.
 *
 * Cardinal rules (from automation#59 + Oracle design review):
 *   - Stats are computed ONLY over the caller-supplied eligible set (above
 *     auto-promote threshold, same hard-gated family) that also has a finite,
 *     positive price. Never include below-threshold or wrong-"type-of-thing"
 *     candidates — doing so recreates the IQR-pollution failure the operator
 *     has repeatedly been burned by. The finite/positive price gate lives
 *     HERE so every call site enforces it identically.
 *   - No statistical flag when the eligible basis count is below
 *     PRICE_OUTLIER_MIN_BASIS — small samples produce noise, not signal.
 *   - Tukey IQR fences (q1 − 1.5·IQR / q3 + 1.5·IQR), widened by a conservative
 *     tight-cluster guard so a near-degenerate IQR can't produce absurdly tight
 *     fences: a value must also differ from the median by BOTH an absolute AND
 *     a relative threshold (max($5, 20% of median)) to be flagged. Taking the
 *     WIDER of the two fences means we always pick the more conservative rule.
 *   - No clock / DB / network reads; every input is passed in by the caller.
 */

/** Minimum eligible basis count before any statistical flag is emitted. */
export const PRICE_OUTLIER_MIN_BASIS = 5
/** Absolute dollar guard for the conservative tight-cluster fallback. */
export const PRICE_OUTLIER_TIGHT_ABS_USD = 5
/** Relative (fraction-of-median) guard for the tight-cluster fallback. */
export const PRICE_OUTLIER_TIGHT_REL = 0.2
/** Prices within this many dollars are treated as equal (cents-rounded USD). */
const PRICE_EQ_TOLERANCE_USD = 0.005

export type PriceOutlierMethod = 'iqr' | 'tight-cluster' | 'insufficient-basis' | 'no-variation'

/** A single candidate's outlier flag. `delta` is signed (price − median). */
export interface PriceOutlierFlag {
  kind: 'low' | 'high'
  /** Signed price − basis median (USD); negative below median, positive above. */
  delta: number
  /** The crossed fence value (USD): effective low fence for `low`, high for `high`. */
  fence: number
  /** Basis median price (USD). */
  median: number
  /** Count of eligible candidates the stats were computed over. */
  basis: number
}

/** Family-level outlier statistics roll-up. Numeric stats are null when no basis. */
export interface PriceOutlierStats {
  method: PriceOutlierMethod
  basis: number
  median: number | null
  lowFence: number | null
  highFence: number | null
  lowCount: number
  highCount: number
  flaggedCount: number
}

export interface PriceOutlierResult<K> {
  stats: PriceOutlierStats
  flagByKey: Map<K, PriceOutlierFlag>
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Linear-interpolated sample quantile (numpy/R "type 7"), deterministic.
 * `sorted` must be ascending and non-empty; `p` in [0, 1].
 */
function quantileSorted(sorted: readonly number[], p: number): number {
  const n = sorted.length
  if (n === 1) return sorted[0]!
  const idx = (n - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  const frac = idx - lo
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac
}

/**
 * Compute price outliers over `items`, flagging only eligible candidates whose
 * finite positive price falls outside the (conservatively widened) Tukey fences.
 *
 * @param items      full candidate set (already same-hard-gated-family)
 * @param getKey     stable key for a candidate (e.g. fuzzySkuId)
 * @param getPrice   candidate price (preTax); non-finite / <= 0 are excluded
 * @param isEligible whether the candidate counts toward the stats basis
 *                   (e.g. above the auto-promote threshold)
 */
export function computePriceOutliers<T, K>(
  items: readonly T[],
  getKey: (item: T) => K,
  getPrice: (item: T) => number | null,
  isEligible: (item: T) => boolean,
): PriceOutlierResult<K> {
  const eligible: Array<{ key: K; price: number }> = []
  for (const item of items) {
    if (!isEligible(item)) continue
    const price = getPrice(item)
    if (price === null || !Number.isFinite(price) || price <= 0) continue
    eligible.push({ key: getKey(item), price })
  }

  const basis = eligible.length
  const flagByKey = new Map<K, PriceOutlierFlag>()

  if (basis < PRICE_OUTLIER_MIN_BASIS) {
    return {
      stats: {
        method: 'insufficient-basis',
        basis,
        median: null,
        lowFence: null,
        highFence: null,
        lowCount: 0,
        highCount: 0,
        flaggedCount: 0,
      },
      flagByKey,
    }
  }

  const prices = eligible.map((e) => e.price).sort((a, b) => a - b)
  const median = quantileSorted(prices, 0.5)
  const min = prices[0]!
  const max = prices[prices.length - 1]!

  // Every eligible price equal within a cent → nothing to flag.
  if (max - min < PRICE_EQ_TOLERANCE_USD) {
    return {
      stats: {
        method: 'no-variation',
        basis,
        median: round2(median),
        lowFence: null,
        highFence: null,
        lowCount: 0,
        highCount: 0,
        flaggedCount: 0,
      },
      flagByKey,
    }
  }

  const q1 = quantileSorted(prices, 0.25)
  const q3 = quantileSorted(prices, 0.75)
  const iqr = q3 - q1
  const tukeyLow = q1 - 1.5 * iqr
  const tukeyHigh = q3 + 1.5 * iqr

  // Conservative tight-cluster guard: a flagged value must also differ from the
  // median by BOTH an absolute AND a relative threshold. max() yields the
  // stricter of the two; taking the WIDER fence keeps the more conservative rule.
  const tightGap = Math.max(PRICE_OUTLIER_TIGHT_ABS_USD, PRICE_OUTLIER_TIGHT_REL * median)
  const lowFence = Math.min(tukeyLow, median - tightGap)
  const highFence = Math.max(tukeyHigh, median + tightGap)

  // The tight guard dominated when it widened either fence beyond raw Tukey.
  const method: PriceOutlierMethod =
    median - tightGap < tukeyLow || median + tightGap > tukeyHigh ? 'tight-cluster' : 'iqr'

  let lowCount = 0
  let highCount = 0
  for (const { key, price } of eligible) {
    if (price < lowFence) {
      flagByKey.set(key, {
        kind: 'low',
        delta: round2(price - median),
        fence: round2(lowFence),
        median: round2(median),
        basis,
      })
      lowCount++
    } else if (price > highFence) {
      flagByKey.set(key, {
        kind: 'high',
        delta: round2(price - median),
        fence: round2(highFence),
        median: round2(median),
        basis,
      })
      highCount++
    }
  }

  return {
    stats: {
      method,
      basis,
      median: round2(median),
      lowFence: round2(lowFence),
      highFence: round2(highFence),
      lowCount,
      highCount,
      flaggedCount: lowCount + highCount,
    },
    flagByKey,
  }
}

/**
 * Severity used to rank the bounded `reviewCandidates` list: distance the price
 * fell PAST the crossed fence (always >= 0). Larger = more anomalous. Callers
 * tie-break on |delta|, then score, then a stable id.
 */
export function priceOutlierSeverity(price: number, flag: PriceOutlierFlag): number {
  return flag.kind === 'high' ? price - flag.fence : flag.fence - price
}
