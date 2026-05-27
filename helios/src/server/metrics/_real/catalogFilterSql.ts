import type { MetricQueryArgs } from '../types.js'

// ============================================================================
// Catalog-scope filter SQL helpers.
//
// The category / subcategory / brand / size labels surfaced by the
// /api/catalog-analytics/filters endpoint come from coalesced columns
// on the catalog_groups mapping table:
//
//   coalesce(nullif(category_name,    ''), '(uncategorised)')   as category_label
//   coalesce(nullif(subcategory_name, ''), '(no subcategory)')  as subcategory_label
//   coalesce(nullif(brand_name,       ''), '(no brand)')        as brand_label
//   coalesce(nullif(size_name,        ''), '(no size)')         as size_label
//
// Time-series / inventory metric queries that opt in to catalog
// filters must use the SAME label coalescing so the filter values the
// SPA sends round-trip correctly. This module exports a CTE that
// re-derives those labels for each catalog product id and a WHERE
// snippet that applies the four filter arrays against an alias of
// that CTE.
//
// The CTE collapses to ONE row per `product_id` (so joining it to
// orders / packages never duplicates a row).
// ============================================================================

export interface CatalogFilterValues {
  readonly categoryIds: readonly string[]
  readonly subcategoryIds: readonly string[]
  readonly brandIds: readonly string[]
  readonly sizes: readonly string[]
}

export function extractCatalogFilterValues(args: MetricQueryArgs): CatalogFilterValues {
  return {
    categoryIds: args.categoryIds ?? [],
    subcategoryIds: args.subcategoryIds ?? [],
    brandIds: args.brandIds ?? [],
    sizes: args.sizes ?? [],
  }
}

export function hasAnyCatalogFilter(args: MetricQueryArgs): boolean {
  const f = extractCatalogFilterValues(args)
  return (
    f.categoryIds.length +
      f.subcategoryIds.length +
      f.brandIds.length +
      f.sizes.length >
    0
  )
}

/**
 * SQL fragment defining a `catalog_product_mapping(product_id text,
 * category_label text, subcategory_label text, brand_label text,
 * size_label text)` CTE. The caller must:
 *
 *   * insert this immediately after a `with` keyword (or after `,` in
 *     an existing CTE chain);
 *   * join `catalog_product_mapping` by `product_id` (text comparison
 *     — order items expose `productId` as a JSON string);
 *   * bind the four filter arrays in the order returned by
 *     `catalogFilterParams()` (or otherwise account for parameter
 *     positions when building the WHERE snippet).
 */
export const CATALOG_PRODUCT_MAPPING_CTE = `
  catalog_product_mapping as (
    select (prod->>'productId')::text                                       as product_id,
           max(coalesce(nullif(cg.category_name,    ''), '(uncategorised)'))   as category_label,
           max(coalesce(nullif(cg.subcategory_name, ''), '(no subcategory)')) as subcategory_label,
           max(coalesce(nullif(cg.brand_name,       ''), '(no brand)'))       as brand_label,
           max(coalesce(nullif(prod->>'sizeName',   ''), '(no size)'))        as size_label
      from catalog_groups cg,
           jsonb_array_elements(cg.live_state_json->'products') as prod
     where cg.deleted_at is null
       and prod->>'productId' is not null
     group by 1
  )
`

/**
 * Builds an `and ... and ...` WHERE snippet that applies all four
 * filter arrays against `<alias>.category_label` / `.subcategory_label`
 * / `.brand_label` / `.size_label`. Empty arrays no-op.
 *
 * `startParam` is the parameter index of the FIRST filter array; the
 * snippet uses startParam .. startParam+3 in order:
 * categoryIds, subcategoryIds, brandIds, sizes.
 */
export function catalogFilterWhere(alias: string, startParam: number): string {
  const c = startParam
  const s = startParam + 1
  const b = startParam + 2
  const z = startParam + 3
  return `
    and (cardinality($${c}::text[]) = 0 or ${alias}.category_label    = any($${c}::text[]))
    and (cardinality($${s}::text[]) = 0 or ${alias}.subcategory_label = any($${s}::text[]))
    and (cardinality($${b}::text[]) = 0 or ${alias}.brand_label       = any($${b}::text[]))
    and (cardinality($${z}::text[]) = 0 or ${alias}.size_label        = any($${z}::text[]))
  `
}

/** Returns the four filter arrays in the order expected by
 *  catalogFilterWhere(): [categoryIds, subcategoryIds, brandIds, sizes]. */
export function catalogFilterParams(
  args: MetricQueryArgs,
): [readonly string[], readonly string[], readonly string[], readonly string[]] {
  const f = extractCatalogFilterValues(args)
  return [f.categoryIds, f.subcategoryIds, f.brandIds, f.sizes]
}

/**
 * For metric queries against `sweed_orders so` × `jsonb_array_elements(so.raw_json->'items') as item`,
 * produce the optional `with` prefix, an extra join clause to apply
 * catalog filters, and the WHERE snippet — or empty strings when no
 * filter is active. Use like:
 *
 *   const { withPrefix, joinClause, whereClause, params, paramStart } =
 *     orderItemsCatalogFilterSql(args, /* params before mapping arrays *\/ 3)
 *
 *   const sql = `
 *     ${withPrefix}
 *     select ...
 *       from sweed_orders so
 *            cross join lateral jsonb_array_elements(so.raw_json->'items') as item
 *            ${joinClause}
 *      where so.dealer_id = any($1::bigint[])
 *        and so.pay_time >= $2 and so.pay_time < $3
 *        ${whereClause}
 *      group by ...
 *   `
 *   await pool.query(sql, [...baseParams, ...params])
 */
export function orderItemsCatalogFilterSql(
  args: MetricQueryArgs,
  paramStart: number,
): {
  readonly withPrefix: string
  readonly joinClause: string
  readonly whereClause: string
  readonly params: ReadonlyArray<readonly string[]>
} {
  if (!hasAnyCatalogFilter(args)) {
    return { withPrefix: '', joinClause: '', whereClause: '', params: [] }
  }
  return {
    withPrefix: `with ${CATALOG_PRODUCT_MAPPING_CTE}`,
    joinClause: `join catalog_product_mapping cpm on cpm.product_id = (item->>'productId')`,
    whereClause: catalogFilterWhere('cpm', paramStart),
    params: catalogFilterParams(args),
  }
}
