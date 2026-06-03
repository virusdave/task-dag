import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import type { PricingScopePreviewQuery } from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'
import { resolvePricingRunScope } from './pricingQueries.js'

function captureQuery(): { capturedQueryText: () => string; capturedValues: () => unknown[]; db: Queryable } {
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

  return {
    capturedQueryText: () => capturedQueryText,
    capturedValues: () => capturedValues,
    db,
  }
}

describe('resolvePricingRunScope', () => {
  it('searches product names and short names when previewing a filtered scope', async () => {
    const { db, capturedQueryText, capturedValues } = captureQuery()

    const filters: PricingScopePreviewQuery = {
      brands: [],
      categories: [],
      distributorNames: [],
      includePending: false,
      packSizes: [],
      scopeKind: 'filtered_catalog',
      search: 'Roapz',
      sites: [],
      stockOnly: false,
      strict: false,
      subcategories: [],
      unitSizes: [],
    }

    await resolvePricingRunScope(db, filters)

    expect(capturedValues()).toContain('Roapz')
    expect(capturedQueryText()).toContain("product ->> 'name'")
    expect(capturedQueryText()).toContain("product ->> 'shortName'")
  })

  it('uses multiselect brand/category/subcategory arrays via any($n::text[])', async () => {
    const { db, capturedQueryText, capturedValues } = captureQuery()

    const filters: PricingScopePreviewQuery = {
      brands: ['BrandA', 'BrandB'],
      categories: ['Flower'],
      distributorNames: [],
      includePending: false,
      packSizes: [],
      scopeKind: 'filtered_catalog',
      search: undefined,
      sites: [],
      stockOnly: false,
      strict: false,
      subcategories: ['Infused'],
      unitSizes: [],
    }

    await resolvePricingRunScope(db, filters)

    expect(capturedQueryText()).toMatch(/cg\.brand_name\s*=\s*any\(\$\d+::text\[\]\)/)
    expect(capturedQueryText()).toMatch(/cg\.category_name\s*=\s*any\(\$\d+::text\[\]\)/)
    expect(capturedQueryText()).toMatch(/cg\.subcategory_name\s*=\s*any\(\$\d+::text\[\]\)/)
    expect(capturedValues()).toEqual(expect.arrayContaining([
      ['BrandA', 'BrandB'],
      ['Flower'],
      ['Infused'],
    ]))
  })

  it('emits family-expansion SQL in family mode (sizeName + seed_family_sizes)', async () => {
    const { db, capturedQueryText, capturedValues } = captureQuery()

    const filters: PricingScopePreviewQuery = {
      brands: [],
      categories: [],
      distributorNames: [],
      includePending: true,
      packSizes: [],
      scopeKind: 'family_expansion_from_stock_or_pending',
      search: undefined,
      sites: ['bronx'],
      stockOnly: true,
      strict: false,
      subcategories: [],
      unitSizes: [],
    }

    await resolvePricingRunScope(db, filters, { seedProductIds: [101, 202] })

    expect(capturedQueryText()).toContain("product ->> 'sizeName'")
    expect(capturedQueryText()).toContain('seed_family_sizes')
    expect(capturedQueryText()).toContain('family_expanded_products')
    // The mode parameter is `family_expanded` for non-strict family mode.
    expect(capturedValues()).toContain('family_expanded')
    expect(capturedValues()).toContainEqual([101, 202])
  })

  it('emits seed_only mode SQL when the strict toggle is on', async () => {
    const { db, capturedQueryText, capturedValues } = captureQuery()

    const filters: PricingScopePreviewQuery = {
      brands: [],
      categories: [],
      distributorNames: [],
      includePending: true,
      packSizes: [],
      scopeKind: 'family_expansion_from_stock_or_pending',
      search: undefined,
      sites: ['bronx', 'midtown'],
      stockOnly: true,
      strict: true,
      subcategories: [],
      unitSizes: [],
    }

    await resolvePricingRunScope(db, filters, { seedProductIds: [101] })

    expect(capturedValues()).toContain('seed_only')
    expect(capturedQueryText()).toContain("product_id = any($1::int[])")
  })

  it('emits "all" mode SQL for full_catalog when no seeds are provided', async () => {
    const { db, capturedQueryText, capturedValues } = captureQuery()

    const filters: PricingScopePreviewQuery = {
      brands: [],
      categories: [],
      distributorNames: [],
      includePending: false,
      packSizes: [],
      scopeKind: 'full_catalog',
      search: undefined,
      sites: [],
      stockOnly: false,
      strict: false,
      subcategories: [],
      unitSizes: [],
    }

    await resolvePricingRunScope(db, filters)

    expect(capturedValues()).toContain('all')
    expect(capturedQueryText()).toContain('catalog_products')
  })

  it('returns an empty scope when family mode is requested with no seed', async () => {
    const { db } = captureQuery()
    const filters: PricingScopePreviewQuery = {
      brands: [],
      categories: [],
      distributorNames: [],
      includePending: true,
      packSizes: [],
      scopeKind: 'family_expansion_from_stock_or_pending',
      search: undefined,
      sites: ['bronx'],
      stockOnly: true,
      strict: false,
      subcategories: [],
      unitSizes: [],
    }

    const result = await resolvePricingRunScope(db, filters)
    expect(result.catalogGroupIds).toEqual([])
    expect(result.scopedProductIds).toEqual([])
  })

  it('emits "seed_only" mode SQL for explicit_selection scope, passing the seed list through', async () => {
    const { db, capturedQueryText, capturedValues } = captureQuery()

    const filters: PricingScopePreviewQuery = {
      brands: [],
      categories: [],
      distributorNames: [],
      includePending: false,
      packSizes: [],
      scopeKind: 'explicit_selection',
      search: undefined,
      sites: [],
      stockOnly: false,
      strict: false,
      subcategories: [],
      unitSizes: [],
    }

    await resolvePricingRunScope(db, filters, { seedProductIds: [101, 202, 303] })

    expect(capturedValues()).toContain('seed_only')
    expect(capturedValues()).toContainEqual([101, 202, 303])
    expect(capturedQueryText()).toContain("'seed_only'")
  })

  it('filters catalog products by distributor names from current package snapshots', async () => {
    const { db, capturedQueryText, capturedValues } = captureQuery()

    const filters: PricingScopePreviewQuery = {
      brands: ['MFNY'],
      categories: [],
      distributorNames: ['MFUSED LLC'],
      includePending: false,
      packSizes: [],
      scopeKind: 'filtered_catalog',
      search: undefined,
      sites: [],
      stockOnly: false,
      strict: false,
      subcategories: [],
      unitSizes: [],
    }

    await resolvePricingRunScope(db, filters)

    expect(capturedValues()).toContainEqual(['MFUSED LLC'])
    expect(capturedQueryText()).toContain('sweed_package_current')
    expect(capturedQueryText()).toContain('product_distributors')
    expect(capturedQueryText()).toContain('pd.distributor_name = any')
  })
})
