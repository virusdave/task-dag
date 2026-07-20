import { describe, expect, it } from 'vitest'

import {
  nonCancelledLinePredicateSql,
  nonCancelledLineSql,
  nonCancelledOrderPredicateSql,
  nonCancelledOrderSql,
} from './sweedOrderStatus.js'

describe('sweedOrderStatus canonical predicates', () => {
  it('order predicate uses the typed header status and excludes cancelled', () => {
    expect(nonCancelledOrderPredicateSql('so')).toBe(
      `lower(coalesce(so.invoice_status_name, '')) <> 'cancelled'`,
    )
  })

  it('order predicate omits the dot prefix when unaliased', () => {
    expect(nonCancelledOrderPredicateSql('')).toBe(
      `lower(coalesce(invoice_status_name, '')) <> 'cancelled'`,
    )
    // default arg behaves like ''
    expect(nonCancelledOrderPredicateSql()).toBe(nonCancelledOrderPredicateSql(''))
  })

  it('order clause form prepends "and " for WHERE composition', () => {
    expect(nonCancelledOrderSql('so')).toBe(`and ${nonCancelledOrderPredicateSql('so')}`)
    expect(nonCancelledOrderSql('')).toBe(`and ${nonCancelledOrderPredicateSql('')}`)
  })

  it('line predicate uses the differently-spelled item invoiceItemStatus path', () => {
    // Header uses British "cancelled"; line uses American "canceled".
    expect(nonCancelledLinePredicateSql('f')).toBe(
      `lower(coalesce(f.raw_item->'invoiceItemStatus'->>'name', '')) <> 'canceled'`,
    )
    // line alias defaults to the common `f`.
    expect(nonCancelledLinePredicateSql()).toBe(nonCancelledLinePredicateSql('f'))
  })

  it('line clause form prepends "and "', () => {
    expect(nonCancelledLineSql('soi')).toBe(`and ${nonCancelledLinePredicateSql('soi')}`)
  })

  it('header and line spellings differ (regression guard against copy-paste)', () => {
    expect(nonCancelledOrderPredicateSql('x')).toContain(`'cancelled'`)
    expect(nonCancelledLinePredicateSql('x')).toContain(`'canceled'`)
    expect(nonCancelledOrderPredicateSql('x')).not.toContain(`'canceled' `)
  })
})
