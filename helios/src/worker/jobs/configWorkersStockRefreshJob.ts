import type { QueryResultRow } from 'pg'
import { z } from 'zod'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type ConfigWorkersStockRefreshJobPayload,
  type HeliosPendingPurchaseSiteDealer,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import { callSweedRpcForDealer } from '../sweed/client.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

const STOCK_INVENTORY_PAGE_SIZE = 200

const StockInventoryItemSchema = z
  .object({
    availableQty: z.coerce.number().nullable().optional(),
    currentQty: z.coerce.number().nullable().optional(),
    isAvailableOnline: z.boolean().nullable().optional(),
    isNotForSale: z.boolean().nullable().optional(),
    isTradeSample: z.boolean().nullable().optional(),
    metrcTag: z.string().nullable().optional(),
    metrcPackageTag: z.string().nullable().optional(),
    packageMetrcTag: z.string().nullable().optional(),
    stockLocation: z
      .object({
        id: z.coerce.number().int().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

const StockInventoryRowSchema = z
  .object({
    // Some Sweed builds expose `isOnStock` directly; the current grouped feed
    // does not and we instead derive it from the available quantity below.
    isOnStock: z.boolean().optional(),
    packageCount: z.coerce.number().int().min(0).optional(),
    product: z
      .object({
        id: z.coerce.number().int().positive().optional(),
        name: z.string().nullable().optional(),
        shortName: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    productBrand: z
      .object({
        id: z.coerce.number().int().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    quantity: z.coerce.number().nullable().optional(),
    // Live grouped feed shape: per-row `currentQty`, `holdQty`, `availableQty`.
    // `availableQty` already nets out holds; treat it as the in-stock signal.
    currentQty: z.coerce.number().nullable().optional(),
    holdQty: z.coerce.number().nullable().optional(),
    availableQty: z.coerce.number().nullable().optional(),
    items: z.array(StockInventoryItemSchema).default([]),
  })
  .passthrough()

const StockInventoryResponseSchema = z
  .object({
    data: z.array(StockInventoryRowSchema).default([]),
    totalCount: z.coerce.number().int().min(0).optional(),
  })
  .passthrough()

interface ParsedRow {
  productId: number
  isOnStock: boolean
  quantity: number | null
  packageCount: number | null
  productName: string | null
  metrcTags: string[]
}

interface BrandRollup {
  brandId: number
  brandName: string
  // product_ids whose row had at least one "for sale" lot in this scan
  forSaleProductIds: Set<number>
  forSaleLotCount: number
  forSaleTotalAvailableQty: number
}

interface SiteScanResult {
  rowsByProductId: Map<number, ParsedRow>
  brandRollupsByBrandId: Map<number, BrandRollup>
}

const FOR_SALE_STOCK_LOCATION_PREFIX = 'for sale'

function isForSaleStockLocationName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') {
    return false
  }
  return name.trim().toLowerCase().startsWith(FOR_SALE_STOCK_LOCATION_PREFIX)
}

interface SnapshotInsertRow extends QueryResultRow {
  id: number
}

interface ExistingStateRow extends QueryResultRow {
  product_id: number
  is_on_stock: boolean
}

export async function runConfigWorkersStockRefreshJob(
  context: JobHandlerContext,
  payload: ConfigWorkersStockRefreshJobPayload,
): Promise<void> {
  const requestedSites = resolveTargetSites(payload.siteDealerIds)
  if (requestedSites.length === 0) {
    return
  }

  let totalNewlyInStockVariants = 0
  let totalLitalertsRefreshEnqueued = 0

  for (const site of requestedSites) {
    const startedAt = new Date()
    const snapshotId = await withTransaction(async (db) => {
      const result = await db.query<SnapshotInsertRow>(
        `
          insert into stock_snapshots (
            site_dealer_id, site_key, site_label, job_id, status, started_at, metadata_json
          ) values ($1, $2, $3, $4, 'running', $5, $6::jsonb)
          returning id
        `,
        [
          site.dealerId,
          site.siteKey,
          site.siteLabel,
          context.id,
          startedAt,
          JSON.stringify({ trigger: payload.trigger, jobId: context.id }),
        ],
      )
      return result.rows[0].id
    })

    try {
      const scan = await scanFullStockForSite(site)

      // The grouped feed at `store.inventory.item.list.grouped` does not
      // include the per-package `items[]` arrays in every Sweed build, so
      // METRC tags end up empty when we read only from it. Make a second
      // pass against the un-grouped `store.inventory.item.list` "stock
      // items" RPC, which returns one row per package (both in-stock and
      // out-of-stock) at the store level with `metrcTag` /
      // `metrcPackageTag` and `stockLocation` populated. Variant -> METRC
      // is one-to-many (multiple lots / packages per product), so we
      // aggregate as a deduped array per (site, product).
      const perPackageMetrcByProductId = await scanPerPackageMetrcForSite(site)
      mergePerPackageMetrcIntoRows(scan.rowsByProductId, perPackageMetrcByProductId)

      const summary = await persistSnapshotAndDiff({
        context,
        site,
        snapshotId,
        rowsByProductId: scan.rowsByProductId,
        brandRollupsByBrandId: scan.brandRollupsByBrandId,
      })

      totalNewlyInStockVariants += summary.newlyInStockVariantCount
      totalLitalertsRefreshEnqueued += summary.litalertsRefreshEnqueuedCount
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown stock refresh error.'
      await withTransaction(async (db) => {
        await db.query(
          `
            update stock_snapshots
            set status = 'failed',
                finished_at = now(),
                error = $2
            where id = $1
          `,
          [snapshotId, message],
        )
      })
      throw error
    }
  }

  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: payload.requestedByUserId ? 'user' : 'system',
      actorUserId: payload.requestedByUserId ?? null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'config.workers.stock_refresh.completed',
      module: 'config',
      payload: {
        litalertsRefreshEnqueuedCount: totalLitalertsRefreshEnqueued,
        newlyInStockVariantCount: totalNewlyInStockVariants,
        siteDealerIds: requestedSites.map((site) => site.dealerId),
        trigger: payload.trigger,
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

function resolveTargetSites(siteDealerIds: number[]): HeliosPendingPurchaseSiteDealer[] {
  if (siteDealerIds.length === 0) {
    return [...HELIOS_PENDING_PURCHASE_SITE_DEALERS]
  }
  const requested = new Set(siteDealerIds)
  return HELIOS_PENDING_PURCHASE_SITE_DEALERS.filter((site) => requested.has(site.dealerId))
}

async function scanFullStockForSite(site: HeliosPendingPurchaseSiteDealer): Promise<SiteScanResult> {
  const rowsByProductId = new Map<number, ParsedRow>()
  const brandRollupsByBrandId = new Map<number, BrandRollup>()

  let page = 1
  while (true) {
    const raw = await callSweedRpcForDealer(site.dealerId, 'store.inventory.item.list.grouped', {
      page,
      pageSize: STOCK_INVENTORY_PAGE_SIZE,
    })
    const parsed = StockInventoryResponseSchema.parse(raw)

    for (const row of parsed.data) {
      const productId = row.product?.id
      if (!productId) {
        continue
      }
      const existing = rowsByProductId.get(productId)
      // Prefer the new grouped-feed `availableQty` (already nets out holds),
      // then fall back to legacy `quantity`/`currentQty` if a Sweed build
      // ever returns those instead.
      const quantity =
        typeof row.availableQty === 'number'
          ? row.availableQty
          : typeof row.quantity === 'number'
            ? row.quantity
            : typeof row.currentQty === 'number'
              ? row.currentQty
              : null
      const packageCount = typeof row.packageCount === 'number' ? row.packageCount : null
      const isOnStock = typeof row.isOnStock === 'boolean'
        ? row.isOnStock
        : (typeof quantity === 'number' && quantity > 0) || (typeof packageCount === 'number' && packageCount > 0)
      const productName = row.product?.shortName ?? row.product?.name ?? null
      const metrcTags = collectMetrcTagsFromInventoryItems(row.items)

      if (!existing) {
        rowsByProductId.set(productId, {
          productId,
          isOnStock,
          quantity,
          packageCount,
          productName,
          metrcTags,
        })
      } else {
        // The grouped feed should be unique-per-product, but defensively merge.
        rowsByProductId.set(productId, {
          productId,
          isOnStock: existing.isOnStock || isOnStock,
          quantity: sumNullable(existing.quantity, quantity),
          packageCount: sumNullable(existing.packageCount, packageCount),
          productName: existing.productName ?? productName,
          metrcTags: mergeMetrcTags(existing.metrcTags, metrcTags),
        })
      }

      accumulateBrandRollup(brandRollupsByBrandId, row, productId)
    }

    if (parsed.data.length < STOCK_INVENTORY_PAGE_SIZE) {
      break
    }
    page += 1
  }

  return { rowsByProductId, brandRollupsByBrandId }
}

function accumulateBrandRollup(
  brandRollupsByBrandId: Map<number, BrandRollup>,
  row: z.infer<typeof StockInventoryRowSchema>,
  productId: number,
): void {
  const brandId = row.productBrand?.id
  const brandName = (row.productBrand?.name ?? '').trim()
  if (typeof brandId !== 'number' || brandId <= 0 || brandName.length === 0) {
    return
  }

  let productHasForSaleLot = false
  let forSaleLotCount = 0
  let forSaleAvailableQty = 0
  for (const item of row.items) {
    if (item.isTradeSample === true) continue
    if (item.isNotForSale === true) continue
    if (item.isAvailableOnline !== true) continue
    if (!isForSaleStockLocationName(item.stockLocation?.name)) continue
    const itemQty =
      typeof item.availableQty === 'number'
        ? item.availableQty
        : typeof item.currentQty === 'number'
          ? item.currentQty
          : 0
    if (itemQty <= 0) continue
    productHasForSaleLot = true
    forSaleLotCount += 1
    forSaleAvailableQty += itemQty
  }

  let rollup = brandRollupsByBrandId.get(brandId)
  if (!rollup) {
    rollup = {
      brandId,
      brandName,
      forSaleProductIds: new Set<number>(),
      forSaleLotCount: 0,
      forSaleTotalAvailableQty: 0,
    }
    brandRollupsByBrandId.set(brandId, rollup)
  } else if (rollup.brandName.length === 0 && brandName.length > 0) {
    rollup.brandName = brandName
  }

  if (productHasForSaleLot) {
    rollup.forSaleProductIds.add(productId)
    rollup.forSaleLotCount += forSaleLotCount
    rollup.forSaleTotalAvailableQty += forSaleAvailableQty
  }
}

/**
 * Per-package shape returned by `store.inventory.item.list` (the
 * un-grouped "stock items" RPC). One row per physical package at the
 * store level. The same `product.id` can appear many times because a
 * single variant can have multiple METRC packages (one-to-many).
 */
const PerPackageStockItemSchema = z
  .object({
    product: z
      .object({ id: z.coerce.number().int().positive().optional() })
      .passthrough()
      .optional(),
    metrcTag: z.string().nullable().optional(),
    metrcPackageTag: z.string().nullable().optional(),
    packageMetrcTag: z.string().nullable().optional(),
    availableQty: z.coerce.number().nullable().optional(),
    currentQty: z.coerce.number().nullable().optional(),
    isNotForSale: z.boolean().nullable().optional(),
    isTradeSample: z.boolean().nullable().optional(),
    stockLocation: z
      .object({
        id: z.coerce.number().int().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

const PerPackageStockItemResponseSchema = z
  .object({
    data: z.array(PerPackageStockItemSchema).default([]),
    totalCount: z.coerce.number().int().min(0).optional(),
  })
  .passthrough()

async function scanPerPackageMetrcForSite(
  site: HeliosPendingPurchaseSiteDealer,
): Promise<Map<number, string[]>> {
  const tagsByProductId = new Map<number, Set<string>>()
  let page = 1
  while (true) {
    const raw = await callSweedRpcForDealer(site.dealerId, 'store.inventory.item.list', {
      page,
      pageSize: STOCK_INVENTORY_PAGE_SIZE,
    })
    const parsed = PerPackageStockItemResponseSchema.parse(raw)
    for (const item of parsed.data) {
      const productId = item.product?.id
      if (!productId) continue
      const tag =
        nonEmptyTrimmed(item.metrcTag) ??
        nonEmptyTrimmed(item.metrcPackageTag) ??
        nonEmptyTrimmed(item.packageMetrcTag)
      if (!tag) continue
      let set = tagsByProductId.get(productId)
      if (!set) {
        set = new Set<string>()
        tagsByProductId.set(productId, set)
      }
      set.add(tag)
    }
    if (parsed.data.length < STOCK_INVENTORY_PAGE_SIZE) break
    page += 1
  }
  const result = new Map<number, string[]>()
  for (const [productId, set] of tagsByProductId.entries()) {
    result.set(productId, [...set].sort())
  }
  return result
}

function mergePerPackageMetrcIntoRows(
  rowsByProductId: Map<number, ParsedRow>,
  perPackageMetrcByProductId: Map<number, string[]>,
): void {
  for (const [productId, tags] of perPackageMetrcByProductId.entries()) {
    const existing = rowsByProductId.get(productId)
    if (existing) {
      existing.metrcTags = mergeMetrcTags(existing.metrcTags, tags)
      continue
    }
    // Package exists at the store but the grouped feed didn't produce a
    // row for it (e.g. fully out-of-stock and not surfaced). Insert a
    // metric-only row so the METRC fatal check passes for in-stock
    // variants the grouped feed *does* surface that share the same
    // productId via another lot.
    rowsByProductId.set(productId, {
      productId,
      isOnStock: false,
      quantity: null,
      packageCount: null,
      productName: null,
      metrcTags: tags,
    })
  }
}

function collectMetrcTagsFromInventoryItems(
  items: ReadonlyArray<{
    metrcTag?: string | null
    metrcPackageTag?: string | null
    packageMetrcTag?: string | null
    availableQty?: number | null
  }>,
): string[] {
  const seen = new Set<string>()
  for (const item of items) {
    if (typeof item.availableQty === 'number' && item.availableQty <= 0) {
      continue
    }
    const tag =
      nonEmptyTrimmed(item.metrcTag) ??
      nonEmptyTrimmed(item.metrcPackageTag) ??
      nonEmptyTrimmed(item.packageMetrcTag)
    if (tag) {
      seen.add(tag)
    }
  }
  return [...seen].sort()
}

function nonEmptyTrimmed(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function mergeMetrcTags(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])].sort()
}

function sumNullable(left: number | null, right: number | null): number | null {
  if (left === null && right === null) {
    return null
  }
  return (left ?? 0) + (right ?? 0)
}

interface PersistResult {
  newlyInStockVariantCount: number
  litalertsRefreshEnqueuedCount: number
}

async function persistSnapshotAndDiff(input: {
  context: JobHandlerContext
  site: HeliosPendingPurchaseSiteDealer
  snapshotId: number
  rowsByProductId: Map<number, ParsedRow>
  brandRollupsByBrandId: Map<number, BrandRollup>
}): Promise<PersistResult> {
  const { context, site, snapshotId, rowsByProductId, brandRollupsByBrandId } = input
  const rows = [...rowsByProductId.values()]
  const inStockRows = rows.filter((row) => row.isOnStock)

  return withTransaction(async (db) => {
    if (rows.length > 0) {
      const values: string[] = []
      const args: unknown[] = []
      let argIndex = 1
      for (const row of rows) {
        values.push(`($${argIndex++}, $${argIndex++}, $${argIndex++}, $${argIndex++}, $${argIndex++}, $${argIndex++})`)
        args.push(snapshotId, row.productId, row.isOnStock, row.quantity, row.packageCount, row.productName)
      }
      await db.query(
        `
          insert into stock_snapshot_items (
            snapshot_id, product_id, is_on_stock, quantity, package_count, product_name
          ) values ${values.join(', ')}
        `,
        args,
      )
    }

    const existingResult = await db.query<ExistingStateRow>(
      `
        select product_id, is_on_stock
        from stock_variant_state
        where site_dealer_id = $1
      `,
      [site.dealerId],
    )
    const existingByProductId = new Map<number, boolean>()
    for (const row of existingResult.rows) {
      existingByProductId.set(row.product_id, row.is_on_stock)
    }

    let newlyInStockVariantCount = 0
    let newlyOutOfStockVariantCount = 0
    const variantsTransitionedToInStock: number[] = []

    const observedAt = new Date()
    for (const row of rows) {
      const previousIsOnStock = existingByProductId.get(row.productId) ?? null
      const transitionedToInStock = row.isOnStock && previousIsOnStock !== true
      const transitionedToOutOfStock = !row.isOnStock && previousIsOnStock === true
      if (transitionedToInStock) {
        newlyInStockVariantCount += 1
        variantsTransitionedToInStock.push(row.productId)
      }
      if (transitionedToOutOfStock) {
        newlyOutOfStockVariantCount += 1
      }

      await db.query(
        `
          insert into stock_variant_state (
            site_dealer_id, product_id, is_on_stock, quantity, metrc_tags_json,
            last_snapshot_id, last_observed_at,
            last_in_stock_at, last_out_of_stock_at
          ) values ($1, $2, $3, $4, $7::jsonb, $5, $6::timestamptz,
            case when $3 then $6::timestamptz else null end,
            case when $3 then null else $6::timestamptz end)
          on conflict (site_dealer_id, product_id) do update
            set is_on_stock = excluded.is_on_stock,
                quantity = excluded.quantity,
                metrc_tags_json = excluded.metrc_tags_json,
                last_snapshot_id = excluded.last_snapshot_id,
                last_observed_at = excluded.last_observed_at,
                last_in_stock_at = case
                  when excluded.is_on_stock then excluded.last_observed_at
                  else stock_variant_state.last_in_stock_at
                end,
                last_out_of_stock_at = case
                  when excluded.is_on_stock then stock_variant_state.last_out_of_stock_at
                  else excluded.last_observed_at
                end
        `,
        [
          site.dealerId,
          row.productId,
          row.isOnStock,
          row.quantity,
          snapshotId,
          observedAt,
          JSON.stringify(row.metrcTags),
        ],
      )
    }

    let litalertsRefreshEnqueuedCount = 0
    for (const productId of variantsTransitionedToInStock) {
      // Skip if a pending refresh row already exists for this (product, site).
      // The partial unique index protects us under concurrent inserts; this
      // guard avoids the catch path on the common no-op case.
      const existing = await db.query<{ id: number }>(
        `
          select id from pending_litalerts_refresh_queue
          where product_id = $1
            and coalesce(site_dealer_id, 0) = coalesce($2, 0)
            and status = 'pending'
          limit 1
        `,
        [productId, site.dealerId],
      )
      if (existing.rows.length > 0) {
        continue
      }
      try {
        await db.query(
          `
            insert into pending_litalerts_refresh_queue (
              product_id, site_dealer_id, reason, source_snapshot_id, status, notes
            ) values ($1, $2, 'variant_in_stock_transition', $3, 'pending', $4)
          `,
          [
            productId,
            site.dealerId,
            snapshotId,
            `Variant transitioned out-of-stock -> in-stock at ${site.siteLabel} via snapshot ${snapshotId}.`,
          ],
        )
        litalertsRefreshEnqueuedCount += 1
      } catch (insertError) {
        // Either a concurrent insert or a violation of the partial unique
        // index. Either way, the desired pending refresh row exists; do not
        // double-count.
        if (!(insertError instanceof Error) || !/duplicate key|unique/i.test(insertError.message)) {
          throw insertError
        }
      }
    }

    for (const rollup of brandRollupsByBrandId.values()) {
      const forSaleVariantCount = rollup.forSaleProductIds.size
      const hasForSaleNow = forSaleVariantCount > 0
      await db.query(
        `
          insert into landingpage_brand_site_presence (
            site_dealer_id, site_key, site_label, brand_id, brand_name,
            for_sale_variant_count, for_sale_total_available_qty, for_sale_lot_count,
            last_observed_at, last_for_sale_observed_at,
            last_observed_snapshot_id, last_for_sale_observed_snapshot_id,
            first_observed_at
          ) values (
            $1, $2, $3, $4, $5,
            $6, $7, $8,
            $9::timestamptz,
            case when $10 then $9::timestamptz else null end,
            $11::bigint,
            case when $10 then $11::bigint else null end,
            $9::timestamptz
          )
          on conflict (site_dealer_id, brand_id) do update
            set site_key = excluded.site_key,
                site_label = excluded.site_label,
                brand_name = excluded.brand_name,
                for_sale_variant_count = excluded.for_sale_variant_count,
                for_sale_total_available_qty = excluded.for_sale_total_available_qty,
                for_sale_lot_count = excluded.for_sale_lot_count,
                last_observed_at = excluded.last_observed_at,
                last_observed_snapshot_id = excluded.last_observed_snapshot_id,
                last_for_sale_observed_at = case
                  when excluded.for_sale_variant_count > 0 then excluded.last_observed_at
                  else landingpage_brand_site_presence.last_for_sale_observed_at
                end,
                last_for_sale_observed_snapshot_id = case
                  when excluded.for_sale_variant_count > 0 then excluded.last_observed_snapshot_id
                  else landingpage_brand_site_presence.last_for_sale_observed_snapshot_id
                end
        `,
        [
          site.dealerId,
          site.siteKey,
          site.siteLabel,
          rollup.brandId,
          rollup.brandName,
          forSaleVariantCount,
          rollup.forSaleTotalAvailableQty,
          rollup.forSaleLotCount,
          observedAt,
          hasForSaleNow,
          snapshotId,
        ],
      )
    }

    await db.query(
      `
        update stock_snapshots
        set status = 'succeeded',
            finished_at = now(),
            variant_count = $2,
            in_stock_variant_count = $3,
            newly_in_stock_variant_count = $4,
            newly_out_of_stock_variant_count = $5,
            litalerts_refresh_enqueued_count = $6
        where id = $1
      `,
      [
        snapshotId,
        rows.length,
        inStockRows.length,
        newlyInStockVariantCount,
        newlyOutOfStockVariantCount,
        litalertsRefreshEnqueuedCount,
      ],
    )

    void context
    return {
      newlyInStockVariantCount,
      litalertsRefreshEnqueuedCount,
    }
  })
}
