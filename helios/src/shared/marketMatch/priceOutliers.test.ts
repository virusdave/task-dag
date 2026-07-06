import { describe, expect, it } from 'vitest'

import {
  computePriceOutliers,
  PRICE_OUTLIER_MIN_BASIS,
  priceOutlierSeverity,
  type PriceOutlierFlag,
} from './priceOutliers.js'

interface Row {
  id: number
  price: number | null
  above: boolean
}

function row(id: number, price: number | null, above = true): Row {
  return { id, price, above }
}

function run(rows: Row[]) {
  return computePriceOutliers(
    rows,
    (r) => r.id,
    (r) => r.price,
    (r) => r.above,
  )
}

describe('computePriceOutliers', () => {
  it('suppresses all flags below the minimum basis', () => {
    // 4 eligible priced rows (< PRICE_OUTLIER_MIN_BASIS), one an obvious outlier.
    const rows = [row(1, 10), row(2, 10), row(3, 10), row(4, 1000)]
    expect(rows.filter((r) => r.above && r.price != null).length).toBeLessThan(PRICE_OUTLIER_MIN_BASIS)
    const { stats, flagByKey } = run(rows)
    expect(stats.method).toBe('insufficient-basis')
    expect(stats.basis).toBe(4)
    expect(stats.median).toBeNull()
    expect(stats.flaggedCount).toBe(0)
    expect(flagByKey.size).toBe(0)
  })

  it('flags a high IQR outlier and leaves the cluster alone', () => {
    // Tight cluster around 10 plus one big value; IQR-based fences catch it.
    const rows = [row(1, 10), row(2, 11), row(3, 12), row(4, 10), row(5, 11), row(6, 200)]
    const { stats, flagByKey } = run(rows)
    expect(stats.basis).toBe(6)
    expect(stats.highCount).toBe(1)
    expect(stats.lowCount).toBe(0)
    const flag = flagByKey.get(6)
    expect(flag?.kind).toBe('high')
    expect(flag?.delta).toBeGreaterThan(0)
    // Every clustered row is un-flagged.
    for (const id of [1, 2, 3, 4, 5]) expect(flagByKey.has(id)).toBe(false)
  })

  it('flags a low outlier', () => {
    const rows = [row(1, 100), row(2, 101), row(3, 99), row(4, 100), row(5, 102), row(6, 5)]
    const { stats, flagByKey } = run(rows)
    expect(stats.lowCount).toBe(1)
    const flag = flagByKey.get(6)
    expect(flag?.kind).toBe('low')
    expect(flag?.delta).toBeLessThan(0)
    expect(flag?.fence).toBeLessThan(flag?.median ?? 0)
  })

  it('uses the conservative tight-cluster guard when IQR is tiny', () => {
    // Prices essentially all $10, one $25. Raw Tukey IQR here is ~0 and would
    // flag anything a cent off; the tight guard (max($5, 20%·median)) must keep
    // the fence sane and flag only the genuine $25 outlier.
    const rows = [row(1, 10), row(2, 10), row(3, 10.01), row(4, 10.01), row(5, 10), row(6, 25)]
    const { stats, flagByKey } = run(rows)
    expect(stats.method).toBe('tight-cluster')
    expect(stats.flaggedCount).toBe(1)
    expect(flagByKey.get(6)?.kind).toBe('high')
    // A one-cent deviation is NOT flagged despite the near-zero raw IQR.
    for (const id of [1, 2, 3, 4, 5]) expect(flagByKey.has(id)).toBe(false)
  })

  it('flags nothing when every eligible price is identical', () => {
    const rows = [row(1, 10), row(2, 10), row(3, 10), row(4, 10), row(5, 10)]
    const { stats, flagByKey } = run(rows)
    expect(stats.method).toBe('no-variation')
    expect(stats.median).toBe(10)
    expect(stats.flaggedCount).toBe(0)
    expect(flagByKey.size).toBe(0)
  })

  it('excludes below-threshold candidates from the basis and from flagging', () => {
    // The big value is below threshold: it must neither pollute the fences nor be flagged.
    const rows = [
      row(1, 10),
      row(2, 11),
      row(3, 12),
      row(4, 10),
      row(5, 11),
      row(6, 5000, false),
    ]
    const { stats, flagByKey } = run(rows)
    expect(stats.basis).toBe(5)
    expect(flagByKey.has(6)).toBe(false)
    expect(stats.flaggedCount).toBe(0)
  })

  it('excludes missing / non-positive / non-finite prices from the basis', () => {
    const rows = [
      row(1, 10),
      row(2, 11),
      row(3, null),
      row(4, 0),
      row(5, -3),
      row(6, Number.NaN),
      row(7, Number.POSITIVE_INFINITY),
    ]
    const { stats } = run(rows)
    // Only ids 1 and 2 are finite positive → below min basis, no flags, basis 2.
    expect(stats.basis).toBe(2)
    expect(stats.method).toBe('insufficient-basis')
  })

  it('flags both a low and a high outlier over the same basis', () => {
    const rows = [
      row(1, 2),
      row(2, 100),
      row(3, 101),
      row(4, 99),
      row(5, 100),
      row(6, 102),
      row(7, 400),
    ]
    const { stats, flagByKey } = run(rows)
    expect(stats.lowCount).toBe(1)
    expect(stats.highCount).toBe(1)
    expect(stats.flaggedCount).toBe(2)
    expect(flagByKey.get(1)?.kind).toBe('low')
    expect(flagByKey.get(7)?.kind).toBe('high')
    // Outliers are NOT removed before computing the median (standard Tukey).
    expect(stats.median).toBe(100)
  })
})

describe('priceOutlierSeverity', () => {
  const highFlag: PriceOutlierFlag = { kind: 'high', delta: 50, fence: 120, median: 100, basis: 6 }
  const lowFlag: PriceOutlierFlag = { kind: 'low', delta: -60, fence: 80, median: 100, basis: 6 }

  it('measures distance past the crossed fence', () => {
    expect(priceOutlierSeverity(200, highFlag)).toBe(80)
    expect(priceOutlierSeverity(10, lowFlag)).toBe(70)
  })
})
