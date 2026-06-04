import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import type { Queryable } from '../../server/db/pool.js'
import { loadFallbackWholesaleCostsForProducts } from './wholesaleCostFallback.js'

interface FakeRow extends QueryResultRow {
  product_id: number
  wholesale_cost_dollars: string | number
  observed_at_max: Date
  dealer_id: number
  inventory_item_id: string
}

function fakeQueryable(rows: FakeRow[]): Queryable & { lastSql: string | null; lastValues: unknown[] | null } {
  let lastSql: string | null = null
  let lastValues: unknown[] | null = null
  return {
    get lastSql() {
      return lastSql
    },
    get lastValues() {
      return lastValues
    },
    async query<TResult extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<TResult>> {
      lastSql = sql
      lastValues = values ?? null
      return {
        rows: rows as unknown as TResult[],
        rowCount: rows.length,
        command: 'SELECT',
        oid: 0,
        fields: [],
      }
    },
  }
}

describe('loadFallbackWholesaleCostsForProducts', () => {
  it('returns an empty map when no product ids are provided', async () => {
    const db = fakeQueryable([])
    const result = await loadFallbackWholesaleCostsForProducts(db, [])
    expect(result.size).toBe(0)
    expect(db.lastSql).toBe(null)
  })

  it('deduplicates and filters non-positive ids before querying', async () => {
    const db = fakeQueryable([])
    await loadFallbackWholesaleCostsForProducts(db, [-5, 0, 392898, 392898, Number.NaN])
    expect(db.lastValues).toEqual([[392898]])
  })

  it('coerces numeric strings and drops non-positive returned rows', async () => {
    const observedAt = new Date('2026-05-29T08:26:32.212Z')
    const db = fakeQueryable([
      { product_id: 392898, wholesale_cost_dollars: '11.0000', observed_at_max: observedAt, dealer_id: 210705, inventory_item_id: 'pkg-1' },
      { product_id: 392903, wholesale_cost_dollars: 0, observed_at_max: observedAt, dealer_id: 210705, inventory_item_id: 'pkg-2' },
      { product_id: 392904, wholesale_cost_dollars: 15, observed_at_max: observedAt, dealer_id: 210705, inventory_item_id: 'pkg-3' },
    ])
    const result = await loadFallbackWholesaleCostsForProducts(db, [392898, 392903, 392904])
    expect(result.size).toBe(2)
    expect(result.get(392898)?.wholesaleCost).toBe(11)
    expect(result.get(392898)?.observedAt).toEqual(observedAt)
    expect(result.get(392898)?.dealerId).toBe(210705)
    expect(result.get(392903)).toBeUndefined()
    expect(result.get(392904)?.wholesaleCost).toBe(15)
  })
})
