import { describe, expect, it } from 'vitest'

import type { TimeOfDayCell } from '../../../shared/contracts/index.js'
import {
  basisValue,
  cellValue,
  divergingColor,
  groupSummary,
  laborSurplus,
  percentile,
  sequentialColor,
  type LaborConfig,
} from './timeOfDayCells.js'

const cell = (over: Partial<TimeOfDayCell> = {}): TimeOfDayCell => ({
  weekday: 1,
  hour: 11,
  grossSales: 1000,
  netSales: 900,
  grossReceipts: 1100,
  netReceipts: 1050,
  margin: 400,
  orders: 20,
  ...over,
})

describe('basisValue', () => {
  it('selects the requested basis', () => {
    const c = cell()
    expect(basisValue(c, 'grossSales')).toBe(1000)
    expect(basisValue(c, 'netSales')).toBe(900)
    expect(basisValue(c, 'grossReceipts')).toBe(1100)
    expect(basisValue(c, 'margin')).toBe(400)
  })
})

describe('cellValue', () => {
  it('total returns the raw basis sum', () => {
    expect(cellValue(cell(), 4, 'margin', 'total')).toBe(400)
  })
  it('avg_per_occurrence divides by occurrences', () => {
    expect(cellValue(cell(), 4, 'margin', 'avg_per_occurrence')).toBe(100)
  })
  it('avg_per_occurrence is null with zero occurrences', () => {
    expect(cellValue(cell(), 0, 'margin', 'avg_per_occurrence')).toBeNull()
  })
  it('orders_per_hour divides order count by occurrences', () => {
    expect(cellValue(cell({ orders: 20 }), 4, 'margin', 'orders_per_hour')).toBe(5)
  })
  it('avg_basket divides basis by order count', () => {
    expect(cellValue(cell({ grossSales: 1000, orders: 20 }), 4, 'grossSales', 'avg_basket')).toBe(50)
  })
  it('avg_basket is null with zero orders', () => {
    expect(cellValue(cell({ orders: 0 }), 4, 'grossSales', 'avg_basket')).toBeNull()
  })
})

describe('laborSurplus', () => {
  it('subtracts marginal labor cost from avg margin per occurrence', () => {
    // avg margin = 400/4 = 100; labor = 56 * 1 = 56 → +44
    expect(laborSurplus(cell({ margin: 400 }), 4, { enabled: true, loadedCostPerStaffHour: 56, headcount: 1 })).toBe(44)
  })
  it('goes negative when labor exceeds margin', () => {
    expect(laborSurplus(cell({ margin: 200 }), 4, { enabled: true, loadedCostPerStaffHour: 56, headcount: 1 })).toBe(-6)
  })
  it('honors headcount', () => {
    // avg margin 100 − 56*2 = -12
    expect(laborSurplus(cell({ margin: 400 }), 4, { enabled: true, loadedCostPerStaffHour: 56, headcount: 2 })).toBe(-12)
  })
  it('is null with zero occurrences', () => {
    expect(laborSurplus(cell(), 0, { enabled: true, loadedCostPerStaffHour: 56, headcount: 1 })).toBeNull()
  })
  it('always uses margin, never the displayed basis', () => {
    // grossSales is huge but margin is what matters
    const v = laborSurplus(cell({ grossSales: 99999, margin: 400 }), 4, {
      enabled: true,
      loadedCostPerStaffHour: 56,
      headcount: 1,
    })
    expect(v).toBe(44)
  })
})

describe('groupSummary', () => {
  const noLabor: LaborConfig = { enabled: false, loadedCostPerStaffHour: 0, headcount: 0 }
  const labor = (over: Partial<LaborConfig> = {}): LaborConfig => ({
    enabled: true,
    loadedCostPerStaffHour: 50,
    headcount: 1,
    ...over,
  })

  it('non-labor avg_per_occurrence pools basis over the shared denominator', () => {
    // Two weekday cells, $400 margin each, 14 total occurrences → $800/14.
    const group = [cell({ margin: 400 }), cell({ margin: 400 })]
    expect(groupSummary(group, 14, 1, 'margin', 'avg_per_occurrence', noLabor)).toBeCloseTo(
      800 / 14,
    )
  })

  it('non-labor total sums regardless of occurrences', () => {
    const group = [cell({ margin: 400 }), cell({ margin: 100 })]
    expect(groupSummary(group, 14, 1, 'margin', 'total', noLabor)).toBe(500)
  })

  it('non-labor avg_basket pools basis over pooled orders (not avg of avgs)', () => {
    const group = [cell({ grossSales: 1000, orders: 20 }), cell({ grossSales: 500, orders: 5 })]
    expect(groupSummary(group, 14, 1, 'grossSales', 'avg_basket', noLabor)).toBe(1500 / 25)
  })

  it('non-labor returns null for an empty group', () => {
    expect(groupSummary([], 14, 1, 'margin', 'avg_per_occurrence', noLabor)).toBeNull()
  })

  it('labor pools margin and charges labor ONCE per occurrence-hour (not per cell)', () => {
    // 7 weekday cells of $400 over 14 total occ → 2800/14 = $200; minus $50×1.
    const group = Array.from({ length: 7 }, () => cell({ margin: 400 }))
    expect(groupSummary(group, 14, 1, 'margin', 'avg_per_occurrence', labor())).toBeCloseTo(150)
  })

  it('labor charges laborHoursPerOccurrence staff-hours (full open day)', () => {
    // One busy hour, $400 margin, occ 4 → 100/occ; minus $50 × 19 open hours.
    const group = [cell({ margin: 400 })]
    expect(groupSummary(group, 4, 19, 'margin', 'avg_per_occurrence', labor())).toBeCloseTo(
      100 - 50 * 19,
    )
  })

  it('labor charges an empty open hour its labor cost (margin 0 → deficit)', () => {
    expect(groupSummary([], 14, 1, 'margin', 'avg_per_occurrence', labor())).toBe(-50)
  })

  it('labor returns null when there are no occurrences', () => {
    expect(groupSummary([cell()], 0, 1, 'margin', 'avg_per_occurrence', labor())).toBeNull()
  })

  it('labor honors headcount', () => {
    // empty hour, 2 staff × $50 → -100.
    expect(groupSummary([], 14, 1, 'margin', 'avg_per_occurrence', labor({ headcount: 2 }))).toBe(
      -100,
    )
  })
})

describe('percentile', () => {
  it('returns 0 for empty', () => {
    expect(percentile([], 0.95)).toBe(0)
  })
  it('p100 is the max, p0 the min', () => {
    expect(percentile([5, 1, 3, 2, 4], 1)).toBe(5)
    expect(percentile([5, 1, 3, 2, 4], 0)).toBe(1)
  })
  it('caps an outlier below p95', () => {
    const vals = [...Array(19).fill(10), 1000]
    expect(percentile(vals, 0.95)).toBe(10)
  })
})

describe('color scales', () => {
  it('sequential is near-white at/below zero and changes with value', () => {
    expect(sequentialColor(0, 100)).toBe('rgb(247, 250, 252)')
    expect(sequentialColor(-5, 100)).toBe('rgb(247, 250, 252)')
    expect(sequentialColor(100, 100)).not.toBe(sequentialColor(10, 100))
  })
  it('diverging is green for positive, red for negative', () => {
    const pos = divergingColor(50, 100)
    const neg = divergingColor(-50, 100)
    expect(pos).not.toBe(neg)
    // green channel dominates for positive surplus
    const [pr, pg] = pos.match(/\d+/g)!.map(Number)
    expect(pg).toBeGreaterThan(pr)
    // red channel dominates for negative
    const [nr, , nb] = neg.match(/\d+/g)!.map(Number)
    expect(nr).toBeGreaterThan(nb)
  })
})
