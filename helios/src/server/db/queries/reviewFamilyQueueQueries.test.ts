import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import type { JsonValue, ReviewFamilyQueueQuery } from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'
import { listReviewFamilyQueue } from './reviewFamilyQueueQueries.js'

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { command: 'SELECT', fields: [], oid: 0, rowCount: rows.length, rows }
}

/** Route each query to canned rows by matching a fragment of its SQL. */
function routingDb(handlers: {
  narrow?: QueryResultRow[]
  detail?: QueryResultRow[]
  observations?: QueryResultRow[]
}): { db: Queryable; queryText: string[] } {
  const queryText: string[] = []
  const db: Queryable = {
    async query<T extends QueryResultRow>(text: string): Promise<QueryResult<T>> {
      queryText.push(text)
      if (text.includes('family_rollup')) return result((handlers.narrow ?? []) as T[])
      if (text.includes('selected_families')) return result((handlers.detail ?? []) as T[])
      if (text.includes('litalerts_competitor_observations')) return result((handlers.observations ?? []) as T[])
      throw new Error(`Unexpected query: ${text.slice(0, 80)}`)
    },
  }
  return { db, queryText }
}

function narrowRow(over: Record<string, unknown>): QueryResultRow {
  return {
    page_row: true,
    family_brand: 'Acme',
    family_category: 'Flower',
    family_subcategory: 'Indica',
    has_drift: false,
    line_item_count: 2,
    review_row_count: 1,
    total_family_count: 10,
    total_row_count: 50,
    ...over,
  }
}

let detailId = 1
function detailRow(over: Record<string, unknown>): QueryResultRow {
  const liveState: JsonValue = { products: [{ productId: 900, name: 'P', tab: 'flower', sizeName: '3.5g', price: 40 }] }
  return {
    id: detailId++,
    proposal_row_id: 1,
    catalog_group_id: 1,
    target_entity_type: 'catalog_group',
    target_entity_id: 1,
    field_path: 'products.price',
    baseline_preview_src: 40,
    suggested_preview_src: 42,
    edited_preview_src: null,
    effective_preview_src: 42,
    approval_status: 'pending',
    version: 1,
    notes: null,
    validation_issues_json: [],
    proposal_batch_type: 'pricing',
    group_name: 'Acme Flower',
    brand_name: 'Acme',
    category_name: 'Flower',
    subcategory_name: 'Indica',
    reconcile_status: 'clean',
    live_state_json: liveState,
    family_ord: 0,
    ...over,
  }
}

const baseFilters: ReviewFamilyQueueQuery = { limit: 12 }

describe('listReviewFamilyQueue (Phase A pagination)', () => {
  it('returns whole-queue totals with an empty page when no families match', async () => {
    const { db } = routingDb({
      narrow: [{ page_row: false, family_brand: null, family_category: null, family_subcategory: null,
        has_drift: null, line_item_count: null, review_row_count: null,
        total_family_count: 0, total_row_count: 0 }],
    })
    const res = await listReviewFamilyQueue(db, baseFilters)
    expect(res.families).toEqual([])
    expect(res.totalFamilyCount).toBe(0)
    expect(res.totalRowCount).toBe(0)
    expect(res.pageInfo.hasNextPage).toBe(false)
    expect(res.pageInfo.endCursor).toBeNull()
  })

  it('emits exactly `limit` families and a forward cursor when more remain', async () => {
    // limit 2 → narrow returns limit+1 = 3 candidates.
    const { db } = routingDb({
      narrow: [
        narrowRow({ family_brand: 'A', has_drift: true }),
        narrowRow({ family_brand: 'B' }),
        narrowRow({ family_brand: 'C' }),
      ],
      detail: [
        detailRow({ proposal_row_id: 1, brand_name: 'A', family_ord: 0 }),
        detailRow({ proposal_row_id: 2, brand_name: 'B', family_ord: 1 }),
      ],
    })
    const res = await listReviewFamilyQueue(db, { ...baseFilters, limit: 2 })
    expect(res.pageInfo.returnedFamilyCount).toBe(2)
    expect(res.pageInfo.familyLimit).toBe(2)
    expect(res.pageInfo.hasNextPage).toBe(true)
    expect(res.pageInfo.endCursor).toBeTruthy()
    expect(res.totalFamilyCount).toBe(10)
    expect(res.families).toHaveLength(2)
  })

  it('does not emit a cursor on the last page', async () => {
    const { db } = routingDb({
      narrow: [narrowRow({ family_brand: 'A' })],
      detail: [detailRow({ proposal_row_id: 1, brand_name: 'A' })],
    })
    const res = await listReviewFamilyQueue(db, { ...baseFilters, limit: 5 })
    expect(res.pageInfo.hasNextPage).toBe(false)
    expect(res.pageInfo.endCursor).toBeNull()
  })

  it('returns an oversized family alone and flags it', async () => {
    const { db } = routingDb({
      narrow: [
        narrowRow({ family_brand: 'Big', line_item_count: 300, review_row_count: 300 }),
        narrowRow({ family_brand: 'Next' }),
      ],
      detail: [detailRow({ proposal_row_id: 1, brand_name: 'Big' })],
    })
    const res = await listReviewFamilyQueue(db, { ...baseFilters, limit: 5 })
    expect(res.pageInfo.truncatedByItemCap).toBe(true)
    expect(res.pageInfo.oversizedFamily?.lineItemCount).toBe(300)
    expect(res.pageInfo.oversizedFamily?.familyKey.brand).toBe('Big')
    expect(res.pageInfo.returnedFamilyCount).toBe(1)
    expect(res.pageInfo.hasNextPage).toBe(true)
  })

  it('labels a multi-size family "Mixed" but keeps identity size-agnostic', async () => {
    const mixedLiveState: JsonValue = {
      products: [
        { productId: 1, name: 'a', tab: 'flower', sizeName: '1g', price: 10 },
        { productId: 2, name: 'b', tab: 'flower', sizeName: '3.5g', price: 30 },
      ],
    }
    const { db } = routingDb({
      narrow: [narrowRow({ family_brand: 'Acme' })],
      detail: [detailRow({ proposal_row_id: 1, brand_name: 'Acme', live_state_json: mixedLiveState })],
    })
    const res = await listReviewFamilyQueue(db, { ...baseFilters, limit: 5 })
    expect(res.families[0]!.familyKey.sizeName).toBe('Mixed')
  })
})
