import type { Queryable } from '../../server/db/pool.js'

/**
 * Per-product fallback wholesale-cost lookup for the pricing planner.
 *
 * Background: some vendors (Cannabals being the canonical example as
 * of 2026-06-04, run #74) leave the per-product `wholesaleCost` field
 * on Sweed's `store.product.get` payload at 0. Sweed's invoice
 * envelope ALSO returns `wholesaleCost: 0` for those vendors, which
 * is why we already snapshot every package's cost into the
 * `sweed_package_snapshots` hypertable via
 * configWorkersSweedPackageSnapshotsJob — see the long comment at
 * the top of that file for the operator-confirmed reasoning.
 *
 * Without this fallback the deterministic planner skips every product
 * with cost=0 ("Skipped because there is no usable wholesale cost in
 * the persisted live snapshot"), turning what looks like a real
 * Reprice run into 100% skips. This helper closes that gap by
 * surfacing the most-recent non-zero per-package cost we observed
 * from `store.inventory.item.list.grouped`, scoped to packages that
 * are still on-hand wherever possible.
 *
 * Provenance: the caller stamps the resulting overlay with
 * `wholesaleCostSource: 'package_snapshot'` (vs `'product_record'`
 * for the unmodified Sweed product field) so the run-detail UI can
 * indicate where each cost came from. The planner itself reads only
 * `wholesaleCost`; the source tag is plumbed through purely for the
 * reviewer.
 */
export interface ProductWholesaleCostFallback {
  productId: number
  wholesaleCost: number
  observedAt: Date
  dealerId: number | null
  inventoryItemId: string | null
}

/**
 * For each product id, return the freshest non-zero per-package
 * wholesale cost we have on record. On-stock packages are preferred
 * over off-stock; ties broken by `observed_at_max DESC`.
 *
 * Products with no usable snapshot (no rows, or every row had
 * `wholesale_cost_dollars` null/<=0) are simply omitted from the map.
 */
export async function loadFallbackWholesaleCostsForProducts(
  db: Queryable,
  productIds: number[],
): Promise<Map<number, ProductWholesaleCostFallback>> {
  const fallback = new Map<number, ProductWholesaleCostFallback>()
  const uniqueIds = [...new Set(productIds.filter((id) => Number.isFinite(id) && id > 0))]
  if (uniqueIds.length === 0) {
    return fallback
  }

  // Most recent non-zero cost per product_id; prefer on-stock rows.
  // The hypertable is keyed (dealer_id, inventory_item_id,
  // observed_at_min) so this is a hash-aggregate over a fairly small
  // slice (product_id is indexed via the catalog roll-up indexes
  // installed alongside the table).
  const result = await db.query<{
    product_id: number
    wholesale_cost_dollars: string | number
    observed_at_max: Date
    dealer_id: number
    inventory_item_id: string
  }>(
    `
      with ranked as (
        select
          product_id,
          wholesale_cost_dollars,
          observed_at_max,
          dealer_id,
          inventory_item_id,
          row_number() over (
            partition by product_id
            order by
              coalesce(is_on_stock, false) desc,
              observed_at_max desc
          ) as rn
        from sweed_package_snapshots
        where product_id = any($1)
          and wholesale_cost_dollars is not null
          and wholesale_cost_dollars > 0
      )
      select product_id, wholesale_cost_dollars, observed_at_max, dealer_id, inventory_item_id
      from ranked
      where rn = 1
    `,
    [uniqueIds],
  )

  for (const row of result.rows) {
    const cost = typeof row.wholesale_cost_dollars === 'number'
      ? row.wholesale_cost_dollars
      : Number.parseFloat(row.wholesale_cost_dollars)
    if (!Number.isFinite(cost) || cost <= 0) {
      continue
    }
    fallback.set(row.product_id, {
      productId: row.product_id,
      wholesaleCost: cost,
      observedAt: row.observed_at_max,
      dealerId: row.dealer_id ?? null,
      inventoryItemId: row.inventory_item_id ?? null,
    })
  }

  return fallback
}
