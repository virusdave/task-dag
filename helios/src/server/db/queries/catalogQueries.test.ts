import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it, vi } from 'vitest'

import {
  CatalogBrowserResponseSchema,
  type CatalogBrowserQuery,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'

// The catalog browser query path calls `loadRecentSalesForGroups`,
// which under the hood reaches out to Sweed via `withSweedSession`.
// That isn't available (or desirable) from a unit test, so stub the
// recent-sales helpers to return empty values synchronously. The
// `listCatalogGroups` caller already tolerates either shape — it
// degrades to `recentSalesIssue` on throw and falls back to
// `buildEmptyGroupRecentSales` per group otherwise.
vi.mock('../../catalog/liveRecentSales.js', () => ({
  buildEmptyGroupRecentSales: () => ({
    productRows: [],
    reportSource: 'helios.sweed_orders' as const,
    sites: [],
    summary: {
      combinationCount: 0,
      coverageCount: 0,
      daysPerUnit: null,
      last30DaysGrossSales: null,
      onHand: null,
      reportDate: null,
      unitsPerDay: null,
    },
  }),
  loadRecentSalesForGroups: async () => new Map(),
}))

const { listCatalogGroups } = await import('./catalogQueries.js')

// Regression for May 2026 prod 5xx on /catalog/browser:
//
// An earlier refactor sorted the browser query by `cg.updated_at`. Even
// though the catalog_groups table does carry an `updated_at` column,
// every other call site in this file already sorts/keys off
// `last_synced_at` and `drifted_at`, and the route was changed to
// match (commit 752678a). These grammar invariants pin that decision
// so a future "tidy up the sort key" pass doesn't quietly drift back.
describe('catalogQueries.ts source-level SQL invariants', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, 'catalogQueries.ts'), 'utf8')

  it('sorts the browser query by an existing catalog_groups column', () => {
    expect(source).toMatch(/order by\s+cg\.last_synced_at\s+desc/i)
  })

  it('never references cg.updated_at as a sort/filter key', () => {
    expect(source).not.toMatch(/cg\.updated_at/i)
  })
})

// Regression coverage for issue #17 ("Catalog → Browser: fix 5xx"),
// size-facet path:
//
// The inline size facet query — added alongside the brand/category/
// subcategory/status facets — was syntactically broken in two
// compounding ways:
//
//   1. `jsonb_array_elements(...) AS p` exposes a column literally named
//      `value`, and the query also aliased `trim(p->>'sizeName') AS value`
//      via a `cross join lateral (select ...)`. A bare `select distinct
//      value` against both produced postgres' `column reference "value"
//      is ambiguous` at runtime — but only when the route was hit, since
//      the route handler did not validate the response shape and the
//      compiler had no SQL knowledge.
//
//   2. Even with #1 disambiguated, `select distinct value ... order by
//      length(value)` violates `SELECT DISTINCT … ORDER BY expressions
//      must appear in select list`. That second error would have only
//      surfaced after the first was fixed, masking the deeper issue.
//
// The structural fix is to push the `select distinct trim(...) as value`
// down into an inner select and do the `length()` ordering in an outer
// select. This test pins that structure so a future "tidy up the lateral
// join" refactor cannot quietly re-introduce either failure mode.
describe('listCatalogGroups — facets SQL shape (issue #17 regression)', () => {
  it('selects distinct size names from an inner subquery, not directly over jsonb_array_elements', async () => {
    const seenQueryTexts: string[] = []

    const db: Queryable = {
      async query<TResult extends QueryResultRow>(queryText: string) {
        seenQueryTexts.push(queryText)
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

    const filters: CatalogBrowserQuery = {
      brand: undefined,
      category: undefined,
      page: 1,
      pageSize: 25,
      reconcileStatus: undefined,
      search: undefined,
      size: undefined,
      subcategory: undefined,
    }

    await listCatalogGroups(db, filters)

    const sizeFacetQuery = seenQueryTexts.find((sql) => sql.includes("p->>'sizeName'"))
    expect(sizeFacetQuery, 'expected listCatalogGroups to issue the size facet query').toBeDefined()

    // The two regression-bearing patterns must NOT reappear:
    //   - a bare `select distinct value` directly against the lateral
    //     `jsonb_array_elements(...) p` (postgres exposes p.value, our
    //     own alias collides → ambiguous-column at runtime), and
    //   - a `cross join lateral (... as value) v` re-aliasing pattern
    //     that produced the same collision in the original buggy code.
    expect(sizeFacetQuery).not.toMatch(/select\s+distinct\s+value\b/i)
    expect(sizeFacetQuery).not.toMatch(/cross\s+join\s+lateral\s*\(\s*select\s+trim\([^)]*\)\s+as\s+value\s*\)/i)

    // And the safer shape (inner `select distinct ... as value`, outer
    // `order by length(v.value)`) must be present.
    expect(sizeFacetQuery).toMatch(/select\s+distinct\s+trim\([^)]*\)\s+as\s+value/i)
    expect(sizeFacetQuery).toMatch(/order\s+by\s+length\(v\.value\)/i)
  })

  it('produces a response that round-trips through CatalogBrowserResponseSchema', async () => {
    // Canned row shapes that match what the SQL returns in production
    // for a representative group. The schema parse below is what would
    // have caught any "missing column" / "wrong type" regression *on
    // the server* (issue #17 also adds an explicit
    // CatalogBrowserResponseSchema.parse on the route handler).
    const itemsRow = {
      active_desired_field_count: 0,
      approved_line_item_count: 0,
      brand_name: 'Test Brand',
      category_name: 'Flower',
      catalog_group_id: 1,
      drifted_at: null,
      group_name: 'Test Group',
      last_synced_at: new Date('2026-05-25T15:00:00Z'),
      live_state_json: { products: [] },
      pending_line_item_count: 0,
      product_tabs_json: ['3.5g'],
      reconcile_status: 'in_sync',
      subcategory_name: 'Infused',
      sweed_group_id: 1234,
    }

    const db: Queryable = {
      async query<TResult extends QueryResultRow>(queryText: string) {
        const reply = <TRows extends QueryResultRow>(rows: TRows[]): QueryResult<TRows> => ({
          command: 'SELECT',
          fields: [],
          oid: 0,
          rowCount: rows.length,
          rows,
        })

        if (queryText.includes('select count(*)')) {
          return reply([{ total_count: 1 }]) as unknown as QueryResult<TResult>
        }
        if (queryText.includes('from catalog_groups cg') && queryText.includes('order by cg.last_synced_at desc')) {
          return reply([itemsRow]) as unknown as QueryResult<TResult>
        }
        if (queryText.includes("p->>'sizeName'")) {
          return reply([{ value: '3.5g' }]) as unknown as QueryResult<TResult>
        }
        if (queryText.includes('select distinct brand_name')) {
          return reply([{ value: 'Test Brand' }]) as unknown as QueryResult<TResult>
        }
        if (queryText.includes('select distinct category_name')) {
          return reply([{ value: 'Flower' }]) as unknown as QueryResult<TResult>
        }
        if (queryText.includes('select distinct subcategory_name')) {
          return reply([{ value: 'Infused' }]) as unknown as QueryResult<TResult>
        }
        if (queryText.includes('select distinct reconcile_status')) {
          return reply([{ value: 'in_sync' }]) as unknown as QueryResult<TResult>
        }
        return reply([]) as unknown as QueryResult<TResult>
      },
    }

    const filters: CatalogBrowserQuery = {
      brand: undefined,
      category: undefined,
      page: 1,
      pageSize: 25,
      reconcileStatus: undefined,
      search: undefined,
      size: undefined,
      subcategory: undefined,
    }

    const response = await listCatalogGroups(db, filters)

    // The route handler validates with CatalogBrowserResponseSchema.parse;
    // do the same here so a shape regression (e.g. missing productTabs,
    // wrong type for recentSales) fails this test rather than 5xx'ing
    // /api/catalog/groups in production.
    const parsed = CatalogBrowserResponseSchema.parse(response)
    expect(parsed.totalCount).toBe(1)
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]?.productTabs).toEqual(['3.5g'])
    expect(parsed.facets.sizes).toContain('3.5g')
  })
})
