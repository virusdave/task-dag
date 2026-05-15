import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import type { PricingScopePreviewQuery } from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'
import { resolvePricingRunScope } from './pricingQueries.js'

describe('resolvePricingRunScope', () => {
  it('searches product names and short names when previewing a pricing scope', async () => {
    let capturedQueryText = ''
    let capturedValues: unknown[] = []

    const db: Queryable = {
      async query<TResult extends QueryResultRow>(queryText: string, values?: unknown[]) {
        capturedQueryText = queryText
        capturedValues = values ?? []
        const result: QueryResult<TResult> = {
          command: 'SELECT',
          fields: [],
          oid: 0,
          rowCount: 0,
          rows: [],
        }
        return result
      },
    }

    const filters: PricingScopePreviewQuery = {
      brand: undefined,
      category: undefined,
      liveBronxInventory: false,
      liveMidtownInventory: false,
      midtownEverReceived: false,
      scopeKind: 'filtered_catalog',
      search: 'Roapz',
      subcategory: undefined,
    }

    await resolvePricingRunScope(db, filters)

    expect(capturedValues).toContain('%Roapz%')
    expect(capturedQueryText).toContain("product ->> 'name'")
    expect(capturedQueryText).toContain("product ->> 'shortName'")
  })
})
