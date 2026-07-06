/**
 * Query backing the temporary Categorical Family Explorer page
 * (issue #55, task T1). Returns the WHOLE variant catalog as flat, raw rows;
 * the client groups them into categorical families via the shared
 * `familyExplorer.ts` module.
 *
 * DB COST (canon §3): a single query that cracks
 * `catalog_groups.live_state_json.products[]` ONCE via
 * `cross join lateral jsonb_array_elements(...)` — the exact pattern the
 * catalog snapshot CSV export already uses
 * (`catalogSnapshotCsvQueries.ts`). Production today is ~3,400 groups /
 * ~3,500 products, so this is a milliseconds-scale, viewer-gated, one-shot
 * read per page load; it adds no recurring workload and needs no new index.
 *
 * Why NOT the skinny `catalog_group_products` projection table (migration
 * 078)? It intentionally omits `sku` and `packOfSize`, both of which this
 * audit page must show per variant, so "a few columns will do" (the canon
 * rule 078 cites) does NOT hold here — cracking the blob is required. If this
 * page is ever made permanent, the projection could be extended to carry
 * sku/pack, but that touches the `catalogGroupPersistence` write path and is
 * out of T1's isolated-surface scope.
 */

import type { CatalogFamilyExplorerVariant } from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'

interface VariantSqlRow {
  // `cg.id` is an int column and `::bigint` is parsed to number by the
  // global pg type parser in `pool.ts`, so these arrive as numbers.
  catalog_group_id: number
  product_id: number
  product_name: string | null
  product_sku: string | null
  brand_name: string | null
  category_name: string | null
  subcategory_name: string | null
  pack_count: number | null
  size_label: string | null
}

/**
 * Read every catalog variant (one row per product in every group's live
 * state). No de-duplication by productId: this is an audit surface, so any
 * (hypothetical) duplicate must be VISIBLE as two rows rather than silently
 * merged. DEAD/disabled-named groups are intentionally NOT filtered — T1's
 * scope is the whole catalog, and the operator wants to see everything.
 */
export async function listAllCatalogVariants(
  db: Queryable,
): Promise<CatalogFamilyExplorerVariant[]> {
  const sql = `
    select
      cg.id                                        as catalog_group_id,
      (prod->>'productId')::bigint                 as product_id,
      nullif(prod->>'name', '')                    as product_name,
      nullif(prod->>'sku', '')                     as product_sku,
      cg.brand_name                                as brand_name,
      cg.category_name                             as category_name,
      cg.subcategory_name                          as subcategory_name,
      nullif(prod->>'packOfSize', '')::int         as pack_count,
      nullif(prod->>'sizeName', '')                as size_label
    from catalog_groups cg
    cross join lateral jsonb_array_elements(
      coalesce(cg.live_state_json->'products', '[]'::jsonb)
    ) prod
    -- Products with a missing/non-numeric productId can't be keyed or
    -- joined; they are dropped here. Verified 0 such rows in production
    -- today, so this does not hide any real variant from the audit.
    where (prod->>'productId') ~ '^[0-9]+$'
    -- Deterministic order so a family's first-seen display fields (e.g.
    -- brand casing) are stable across page loads.
    order by cg.id, product_id
  `
  const result = await db.query<VariantSqlRow>(sql)
  return result.rows.map((row) => ({
    catalogGroupId: row.catalog_group_id,
    productId: row.product_id,
    name: row.product_name,
    sku: row.product_sku,
    brandName: row.brand_name,
    categoryName: row.category_name,
    subcategoryName: row.subcategory_name,
    packCount: row.pack_count,
    sizeLabel: row.size_label,
  }))
}
