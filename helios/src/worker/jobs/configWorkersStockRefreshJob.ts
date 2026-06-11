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

// Maximum number of rows to send per bulk INSERT / UPDATE round-trip
// in `persistSnapshotAndDiff`. The whole point of this job is to
// turn an O(N) per-row-transaction loop into a handful of bulk
// statements; chunking at 500 keeps individual jsonb_to_recordset
// payloads bounded (well under pg's protocol limits) without giving
// up the per-poll round-trip-count win.
const BULK_CHUNK_SIZE = 500

const StockInventoryItemSchema = z
  .object({
    availableQty: z.coerce.number().nullable().optional(),
    currentQty: z.coerce.number().nullable().optional(),
    isAvailableOnline: z.boolean().nullable().optional(),
    isNotForSale: z.boolean().nullable().optional(),
    isTradeSample: z.boolean().nullable().optional(),
    // The canonical Sweed field for the METRC tag is
    // `externalTrackCode` (a UID like "1A41203000005DD000010231").
    // The `metrcTag` / `metrcPackageTag` / `packageMetrcTag` aliases
    // are only present in a handful of older Sweed builds and are
    // kept here as belt-and-suspenders fallbacks.
    externalTrackCode: z.string().nullable().optional(),
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

      // The grouped feed at `store.inventory.item.list.grouped`
      // already returns per-product `items[]` with each package's
      // `externalTrackCode` (the METRC tag), so we no longer need
      // a second pass against `store.inventory.item.list`. That
      // RPC also now rejects bulk enumeration with subcode 816
      // ("Mandatory filter not found") — it requires a per-product
      // filter — which made the old fallback impossible anyway.

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

function collectMetrcTagsFromInventoryItems(
  items: ReadonlyArray<{
    externalTrackCode?: string | null
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
      nonEmptyTrimmed(item.externalTrackCode) ??
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

  // ============================================================================
  // Bulk-upsert path (db-cost-reduction A2, virusdave/top-level#11).
  //
  // The previous implementation iterated `rows` and issued one
  // INSERT-ON-CONFLICT per variant against `stock_variant_state`, plus
  // one SELECT-then-INSERT per transitioning variant against
  // `pending_litalerts_refresh_queue`, plus one upsert per brand
  // against `landingpage_brand_site_presence`. On the 5-minute
  // per-dealer cadence with ~thousands of variants per site, that's
  // measured in 10⁴+ extra DB round-trips per day.
  //
  // The new path:
  //
  //   (1) chunked bulk INSERT to `stock_snapshot_items` (unchanged
  //       in spirit; just chunked at BULK_CHUNK_SIZE so a giant site
  //       doesn't build one O(N) parameter list).
  //   (2) one SELECT to load existing (product_id, is_on_stock) for
  //       this site (unchanged).
  //   (3) one bulk INSERT … SELECT FROM jsonb_to_recordset(...) ON
  //       CONFLICT DO UPDATE against `stock_variant_state`, chunked
  //       at BULK_CHUNK_SIZE.
  //   (4) one bulk INSERT … SELECT FROM jsonb_to_recordset(...) ON
  //       CONFLICT DO NOTHING against `pending_litalerts_refresh_queue`
  //       — the partial unique index makes the existence-check
  //       SELECT redundant, and RETURNING gives us the accurate
  //       newly-enqueued count.
  //   (5) one bulk INSERT … SELECT FROM jsonb_to_recordset(...) ON
  //       CONFLICT DO UPDATE against `landingpage_brand_site_presence`.
  //
  // All inside the single per-dealer transaction we already opened.
  // ============================================================================
  return withTransaction(async (db) => {
    // (1) stock_snapshot_items — bulk insert, chunked.
    for (let i = 0; i < rows.length; i += BULK_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + BULK_CHUNK_SIZE)
      const values: string[] = []
      const args: unknown[] = []
      let argIndex = 1
      for (const row of chunk) {
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

    // (2) Load prior per-variant state in one read.
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

    // Compute transitions in JS so the bulk INSERT below stays a pure
    // upsert; transition counts and the "variants transitioned to
    // in-stock" list are derived from the (prior, current) diff.
    let newlyInStockVariantCount = 0
    let newlyOutOfStockVariantCount = 0
    const variantsTransitionedToInStock: number[] = []

    const observedAt = new Date()
    for (const row of rows) {
      const previousIsOnStock = existingByProductId.get(row.productId) ?? null
      if (row.isOnStock && previousIsOnStock !== true) {
        newlyInStockVariantCount += 1
        variantsTransitionedToInStock.push(row.productId)
      }
      if (!row.isOnStock && previousIsOnStock === true) {
        newlyOutOfStockVariantCount += 1
      }
    }

    // (3) stock_variant_state — bulk upsert via jsonb_to_recordset.
    // Matches the previous per-row CASE semantics exactly: when the
    // observed row is in stock we stamp last_in_stock_at; otherwise we
    // stamp last_out_of_stock_at. The COALESCE in the ON CONFLICT
    // clauses preserves the older stamp for the other column, same as
    // before.
    for (let i = 0; i < rows.length; i += BULK_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + BULK_CHUNK_SIZE)
      const payload = chunk.map((row) => ({
        product_id: row.productId,
        is_on_stock: row.isOnStock,
        quantity: row.quantity,
        metrc_tags: row.metrcTags,
      }))
      await db.query(
        `
          insert into stock_variant_state (
            site_dealer_id, product_id, is_on_stock, quantity, metrc_tags_json,
            last_snapshot_id, last_observed_at,
            last_in_stock_at, last_out_of_stock_at
          )
          select
            $1::bigint,
            x.product_id,
            x.is_on_stock,
            x.quantity,
            x.metrc_tags::jsonb,
            $2::bigint,
            $3::timestamptz,
            case when x.is_on_stock then $3::timestamptz else null end,
            case when x.is_on_stock then null else $3::timestamptz end
          from jsonb_to_recordset($4::jsonb) as x(
            product_id  bigint,
            is_on_stock boolean,
            quantity    numeric,
            metrc_tags  jsonb
          )
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
            -- Write-on-change (canon §3 R3): only emit a new row version
            -- when a column a CONSUMER reads actually changed. The only
            -- readers of stock_variant_state are is_on_stock, quantity,
            -- and metrc_tags_json (catalog maintenance, the pricing-
            -- evidence freshness view, orphan-group discovery, the
            -- conquest comparison loader). last_snapshot_id /
            -- last_observed_at / last_in_stock_at / last_out_of_stock_at
            -- have ZERO readers, so refreshing them every 5-min poll
            -- produced ~19.5M dead tuples and ~20k autovacuums on a
            -- ~1,853-row table for no benefit. metrc_tags_json is built
            -- sorted+deduped (collectMetrcTagsFromInventoryItems /
            -- mergeMetrcTags), so the jsonb IS DISTINCT FROM comparison
            -- is order-stable and won't false-positive. Transitions for
            -- pending_litalerts_refresh_queue are computed from a
            -- separate prior-state read above, NOT from this upsert, so
            -- skipping no-op writes here cannot affect them.
            where stock_variant_state.is_on_stock is distinct from excluded.is_on_stock
               or stock_variant_state.quantity is distinct from excluded.quantity
               or stock_variant_state.metrc_tags_json is distinct from excluded.metrc_tags_json
        `,
        [site.dealerId, snapshotId, observedAt, JSON.stringify(payload)],
      )
    }

    // (4) pending_litalerts_refresh_queue — bulk insert of the
    // transitioned-to-in-stock variants, deduped against the existing
    // partial unique index via ON CONFLICT DO NOTHING. RETURNING
    // gives us the accurate inserted-row count (so the operator-facing
    // `litalerts_refresh_enqueued_count` matches reality, not just
    // "how many we tried"). Chunked at BULK_CHUNK_SIZE; usually the
    // whole transition set fits in one chunk.
    let litalertsRefreshEnqueuedCount = 0
    for (let i = 0; i < variantsTransitionedToInStock.length; i += BULK_CHUNK_SIZE) {
      const chunk = variantsTransitionedToInStock.slice(i, i + BULK_CHUNK_SIZE)
      const payload = chunk.map((productId) => ({
        product_id: productId,
        notes: `Variant transitioned out-of-stock -> in-stock at ${site.siteLabel} via snapshot ${snapshotId}.`,
      }))
      const result = await db.query(
        `
          insert into pending_litalerts_refresh_queue (
            product_id, site_dealer_id, reason, source_snapshot_id, status, notes
          )
          select
            x.product_id,
            $1::bigint,
            'variant_in_stock_transition',
            $2::bigint,
            'pending',
            x.notes
          from jsonb_to_recordset($3::jsonb) as x(
            product_id bigint,
            notes      text
          )
          on conflict do nothing
        `,
        [site.dealerId, snapshotId, JSON.stringify(payload)],
      )
      litalertsRefreshEnqueuedCount += result.rowCount ?? 0
    }

    // (5) landingpage_brand_site_presence — bulk upsert per dealer.
    const brandRollupArray = [...brandRollupsByBrandId.values()]
    for (let i = 0; i < brandRollupArray.length; i += BULK_CHUNK_SIZE) {
      const chunk = brandRollupArray.slice(i, i + BULK_CHUNK_SIZE)
      const payload = chunk.map((rollup) => {
        const forSaleVariantCount = rollup.forSaleProductIds.size
        return {
          brand_id: rollup.brandId,
          brand_name: rollup.brandName,
          for_sale_variant_count: forSaleVariantCount,
          for_sale_total_available_qty: rollup.forSaleTotalAvailableQty,
          for_sale_lot_count: rollup.forSaleLotCount,
          has_for_sale_now: forSaleVariantCount > 0,
        }
      })
      await db.query(
        `
          insert into landingpage_brand_site_presence (
            site_dealer_id, site_key, site_label, brand_id, brand_name,
            for_sale_variant_count, for_sale_total_available_qty, for_sale_lot_count,
            last_observed_at, last_for_sale_observed_at,
            last_observed_snapshot_id, last_for_sale_observed_snapshot_id,
            first_observed_at
          )
          select
            $1::bigint,
            $2::text,
            $3::text,
            x.brand_id,
            x.brand_name,
            x.for_sale_variant_count,
            x.for_sale_total_available_qty,
            x.for_sale_lot_count,
            $4::timestamptz,
            case when x.has_for_sale_now then $4::timestamptz else null end,
            $5::bigint,
            case when x.has_for_sale_now then $5::bigint else null end,
            $4::timestamptz
          from jsonb_to_recordset($6::jsonb) as x(
            brand_id                     bigint,
            brand_name                   text,
            for_sale_variant_count       integer,
            for_sale_total_available_qty numeric,
            for_sale_lot_count           integer,
            has_for_sale_now             boolean
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
            -- Write-on-change (canon §3 R3). Only the real-state columns
            -- are read by consumers (the freshlybakedus-site live-menu
            -- builder reads brand_name, for_sale_variant_count, and the
            -- last_*_observed_at timestamps — but the timestamps are used
            -- only as a non-null page-existence gate / max-merge / display,
            -- never as a recency cutoff). Refreshing last_observed_at /
            -- last_observed_snapshot_id on every 5-min poll churned all
            -- ~315 rows every cycle: ~2.16M dead tuples and ~16,668
            -- autovacuums for nothing. Guard on the read/real-state cols
            -- so unchanged brands don't write; the first for-sale
            -- transition still stamps last_for_sale_observed_at (non-null
            -- gate preserved), and out-of-sale transitions preserve it.
            where landingpage_brand_site_presence.brand_name is distinct from excluded.brand_name
               or landingpage_brand_site_presence.site_key is distinct from excluded.site_key
               or landingpage_brand_site_presence.site_label is distinct from excluded.site_label
               or landingpage_brand_site_presence.for_sale_variant_count is distinct from excluded.for_sale_variant_count
               or landingpage_brand_site_presence.for_sale_total_available_qty is distinct from excluded.for_sale_total_available_qty
               or landingpage_brand_site_presence.for_sale_lot_count is distinct from excluded.for_sale_lot_count
        `,
        [
          site.dealerId,
          site.siteKey,
          site.siteLabel,
          observedAt,
          snapshotId,
          JSON.stringify(payload),
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
