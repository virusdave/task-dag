import { z } from 'zod'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  HELIOS_SWEED_DEALER_OPENING_DATES,
  type ConfigWorkersSweedPurchasesIngestJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import { callSweedRpc } from '../sweed/rpc.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// ============================================================================
// Sweed purchases ingest worker — backs the Catalog → Purchase Sell-Through
// page family.
//
// Per dealer per tick we:
//   1. Forward-poll `store.purchase.order.list` for a recent window
//      (overlap from highwater_delivery_date back N days, walking
//      newest-first), then call `store.purchase.order.get` for each
//      listed PO that is *not* in pending status (orderStatusId=2 —
//      pending POs are owned by the catalog enrichment workflow,
//      not the sell-through workflow).
//   2. Backfill one historical day per tick from `backfill_cursor_day`
//      toward the dealer's store-opening date.
//   3. UPSERT the header keyed on (dealer_id, po_id) and rewrite the
//      line items in the same transaction (PO line shape can change
//      after partial reception / edits, so overwrite-in-place rather
//      than version like sweed_package_snapshots — operators don't
//      need a PO-edit audit trail, just current truth).
//   4. Direct-match every line item to a sweed_package_snapshots row
//      via externalTrackCode (== sweed_package_snapshots.metrc_tag).
//      The PO probe (2026-06-02) confirms every position carries this
//      field, so we don't need a fuzzy fallback for v1.
//
// Sell-through computation lives in the server query layer
// (server/catalogPurchaseSellThrough/queries.ts); this worker only
// materialises the static PO facts + the line→package bridge.
// ============================================================================

const NY_TZ = 'America/New_York'

// Forward-poll overlap window. Sweed's PO `deliveryDate` is a day
// precision; a one-day overlap is plenty for the on-conflict-do-update
// upsert to be idempotent.
const FORWARD_OVERLAP_DAYS = 3

// Orders Sweed flags as `orderStatusId=2` are *pending* (the catalog-
// enrichment workflow handles them via the pending_purchase_* tables).
// We mirror everything else.
const PENDING_ORDER_STATUS_ID = 2

// Page size cap. Tested against staging at 100; matches the limit
// pendingPurchases uses for the same endpoint.
const PO_LIST_PAGE_SIZE = 100

// ----- Schemas -----

const PoListItemSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    orderStatusId: z.coerce.number().int().nullable().optional(),
    deliveryDate: z.string().nullable().optional(),
  })
  .passthrough()

const PoListResponseSchema = z
  .object({
    data: z.array(PoListItemSchema).default([]),
    totalCount: z.coerce.number().int().nullable().optional(),
    page: z.coerce.number().int().nullable().optional(),
    pageSize: z.coerce.number().int().nullable().optional(),
  })
  .passthrough()

const PoPositionSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    distributorProduct: z
      .object({
        id: z.union([z.string(), z.number()]).nullable().optional(),
        name: z.string().nullable().optional(),
        externalTrackCode: z.string().nullable().optional(),
        product: z
          .object({
            id: z.union([z.string(), z.number()]).nullable().optional(),
            name: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    suggestedProduct: z
      .object({
        id: z.union([z.string(), z.number()]).nullable().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    distributorProductQty: z.coerce.number().nullable().optional(),
    orderPositionQty: z.coerce.number().nullable().optional(),
    positionProductQty: z.coerce.number().nullable().optional(),
    extendedAmount: z.coerce.number().nullable().optional(),
    regularAmount: z.coerce.number().nullable().optional(),
    distributorProductPrice: z.coerce.number().nullable().optional(),
    discountProductPrice: z.coerce.number().nullable().optional(),
    productPrice: z.coerce.number().nullable().optional(),
    externalTrackCode: z.string().nullable().optional(),
    packOfSize: z.coerce.number().int().nullable().optional(),
    isTradeSample: z.boolean().nullable().optional(),
    isTestingSample: z.boolean().nullable().optional(),
    orderPositionIntegrationData: z
      .object({
        externalTrackCode: z.string().nullable().optional(),
        sourceTag: z.string().nullable().optional(),
        wholesalePrice: z.coerce.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    productSize: z
      .object({
        uomNumber: z.coerce.number().nullable().optional(),
        uom: z
          .object({ abbr: z.string().nullable().optional(), name: z.string().nullable().optional() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    catalogProductSize: z
      .object({
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

const PoDetailSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string().nullable().optional(),
    externalOrderId: z.string().nullable().optional(),
    deliveryDate: z.string().nullable().optional(),
    dueDate: z.string().nullable().optional(),
    orderStatus: z
      .object({ id: z.coerce.number().int().nullable().optional(), name: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    financialStatus: z
      .object({ name: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    distributor: z
      .object({
        id: z.coerce.number().int().nullable().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    distributorIntegration: z
      .object({
        id: z.coerce.number().int().nullable().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    isCashOnDelivery: z.boolean().nullable().optional(),
    totalPayAmount: z.coerce.number().nullable().optional(),
    totalSubtotalAmount: z.coerce.number().nullable().optional(),
    totalRegularAmount: z.coerce.number().nullable().optional(),
    totalDiscountAmount: z.coerce.number().nullable().optional(),
    totalDeliveryChargesAmount: z.coerce.number().nullable().optional(),
    totalTaxAmount: z.coerce.number().nullable().optional(),
    totalOwedAmount: z.coerce.number().nullable().optional(),
    totalProductQty: z.coerce.number().nullable().optional(),
    totalDistributorProductQty: z.coerce.number().nullable().optional(),
    positions: z.array(PoPositionSchema).default([]),
  })
  .passthrough()

// ----- Date helpers (copied from sweed_orders worker; same NY-day math) -----

function partsInNY(d: Date): { y: number; m: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const map: Record<string, string> = {}
  for (const p of fmt.formatToParts(d)) map[p.type] = p.value
  return { y: Number(map.year), m: Number(map.month), day: Number(map.day) }
}

function nyDateString(d: Date): string {
  const { y, m, day } = partsInNY(d)
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function decrementIsoDate(iso: string): string {
  const [yStr, mStr, dStr] = iso.split('-')
  const t = Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr)) - 24 * 60 * 60 * 1000
  const d = new Date(t)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function coerceCursorToIso(value: string | Date | null): string | null {
  if (value === null) return null
  if (typeof value === 'string') return value
  const y = value.getUTCFullYear()
  const m = value.getUTCMonth() + 1
  const d = value.getUTCDate()
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// ----- Normalisation -----

function deliveryDateOnly(raw: string | null | undefined): string | null {
  if (!raw) return null
  // Sweed `deliveryDate` is an ISO timestamp like "2026-06-01T00:00:00Z".
  return raw.slice(0, 10)
}

interface NormalisedHeader {
  dealerId: number
  siteKey: string
  poId: string
  poName: string | null
  externalOrderId: string | null
  deliveryDate: string | null
  deliveryAt: Date | null
  paymentDueDate: string | null
  orderStatusId: number | null
  orderStatusName: string | null
  financialStatusName: string | null
  isCashOnDelivery: boolean | null
  distributorId: number | null
  distributorName: string | null
  distributorIntegrationId: number | null
  distributorIntegrationName: string | null
  poTotalDollars: number | null
  poSubtotalDollars: number | null
  poRegularDollars: number | null
  poDiscountDollars: number | null
  poDeliveryChargesDollars: number | null
  poTaxDollars: number | null
  poOwedDollars: number | null
  orderedUnitsTotal: number | null
  distributorProductQtyTotal: number | null
  raw: unknown
}

interface NormalisedLine {
  lineId: string
  lineIndex: number
  distributorProductId: string | null
  distributorProductName: string | null
  sweedProductId: number | null
  sweedProductName: string | null
  sizeLabel: string | null
  packCount: number | null
  orderedUnits: number
  distributorProductQty: number | null
  extendedCostDollars: number | null
  unitCostDollars: number | null
  unitCostSource: string
  discountProductPriceDollars: number | null
  metrcWholesalePriceDollars: number | null
  listPriceDollarsAtIngest: number | null
  isTradeSample: boolean | null
  isTestingSample: boolean | null
  metrcTag: string | null
  raw: unknown
}

function normaliseHeader(
  dealerId: number,
  siteKey: string,
  detail: z.infer<typeof PoDetailSchema>,
): NormalisedHeader {
  return {
    dealerId,
    siteKey,
    poId: String(detail.id),
    poName: detail.name ?? null,
    externalOrderId: detail.externalOrderId ?? null,
    deliveryDate: deliveryDateOnly(detail.deliveryDate ?? null),
    deliveryAt: detail.deliveryDate ? new Date(detail.deliveryDate) : null,
    paymentDueDate: deliveryDateOnly(detail.dueDate ?? null),
    orderStatusId: detail.orderStatus?.id ?? null,
    orderStatusName: detail.orderStatus?.name ?? null,
    financialStatusName: detail.financialStatus?.name ?? null,
    isCashOnDelivery: detail.isCashOnDelivery ?? null,
    distributorId: detail.distributor?.id ?? null,
    distributorName: detail.distributor?.name ?? null,
    distributorIntegrationId: detail.distributorIntegration?.id ?? null,
    distributorIntegrationName: detail.distributorIntegration?.name ?? null,
    poTotalDollars: detail.totalPayAmount ?? null,
    poSubtotalDollars: detail.totalSubtotalAmount ?? null,
    poRegularDollars: detail.totalRegularAmount ?? null,
    poDiscountDollars: detail.totalDiscountAmount ?? null,
    poDeliveryChargesDollars: detail.totalDeliveryChargesAmount ?? null,
    poTaxDollars: detail.totalTaxAmount ?? null,
    poOwedDollars: detail.totalOwedAmount ?? null,
    orderedUnitsTotal: detail.totalProductQty ?? null,
    distributorProductQtyTotal: detail.totalDistributorProductQty ?? null,
    raw: detail,
  }
}

function normaliseLine(index: number, p: z.infer<typeof PoPositionSchema>): NormalisedLine {
  const orderedUnits = p.positionProductQty ?? p.orderPositionQty ?? p.distributorProductQty ?? 0
  const extended = p.extendedAmount ?? null
  let unitCost: number | null = null
  let unitCostSource = 'unknown'
  // Treat a literal 0 in the per-line price fields as "not provided"
  // — some distributors (e.g. HR BOTANICAL) send 0 in
  // distributorProductPrice / discountProductPrice and carry the real
  // amount only in extendedAmount. Without the `> 0` guard the
  // fallback to (extended / orderedUnits) never fires and every line
  // on those POs lands with unit_cost_dollars = 0, which silently
  // zeroes the entire sold-through payment basis on the
  // Catalog → Purchase Sell-Through page family.
  if (
    p.distributorProductPrice !== null &&
    p.distributorProductPrice !== undefined &&
    p.distributorProductPrice > 0
  ) {
    unitCost = p.distributorProductPrice
    unitCostSource = 'distributor_product_price'
  } else if (
    p.discountProductPrice !== null &&
    p.discountProductPrice !== undefined &&
    p.discountProductPrice > 0
  ) {
    unitCost = p.discountProductPrice
    unitCostSource = 'discount_product_price'
  } else if (extended !== null && orderedUnits > 0) {
    unitCost = extended / orderedUnits
    unitCostSource = 'derived_from_extended'
  }
  const metrcTag =
    p.externalTrackCode ??
    p.distributorProduct?.externalTrackCode ??
    p.orderPositionIntegrationData?.externalTrackCode ??
    null
  const wholesale = p.orderPositionIntegrationData?.wholesalePrice ?? null
  const metrcWholesalePerUnit =
    wholesale !== null && orderedUnits > 0 ? wholesale / orderedUnits : null

  const sweedProductRaw =
    p.suggestedProduct?.id ?? p.distributorProduct?.product?.id ?? null
  const sweedProductId =
    sweedProductRaw === null
      ? null
      : typeof sweedProductRaw === 'number'
        ? sweedProductRaw
        : Number(sweedProductRaw)
  const sweedProductName =
    p.suggestedProduct?.name ?? p.distributorProduct?.product?.name ?? null

  const sizeLabel = p.catalogProductSize?.name ?? null
  const packCount = p.packOfSize ?? null

  const distributorProductIdRaw = p.distributorProduct?.id ?? null
  const distributorProductId =
    distributorProductIdRaw === null ? null : String(distributorProductIdRaw)

  return {
    lineId: String(p.id),
    lineIndex: index,
    distributorProductId,
    distributorProductName: p.distributorProduct?.name ?? null,
    sweedProductId: Number.isFinite(sweedProductId ?? NaN) ? sweedProductId : null,
    sweedProductName,
    sizeLabel,
    packCount,
    orderedUnits,
    distributorProductQty: p.distributorProductQty ?? null,
    extendedCostDollars: extended,
    unitCostDollars: unitCost,
    unitCostSource,
    discountProductPriceDollars: p.discountProductPrice ?? null,
    metrcWholesalePriceDollars: metrcWholesalePerUnit,
    listPriceDollarsAtIngest: p.productPrice ?? null,
    isTradeSample: p.isTradeSample ?? null,
    isTestingSample: p.isTestingSample ?? null,
    metrcTag,
    raw: p,
  }
}

// ----- Job entry point -----

export async function runConfigWorkersSweedPurchasesIngestJob(
  context: JobHandlerContext,
  payload: ConfigWorkersSweedPurchasesIngestJobPayload,
): Promise<void> {
  const dealerIds = (() => {
    const candidates =
      payload.siteDealerIds.length > 0
        ? payload.siteDealerIds
        : HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => d.dealerId)
    return [...new Set(candidates)]
  })()

  const perDealer: Array<{
    dealerId: number
    forwardSeen: number
    forwardUpserted: number
    forwardSkippedPending: number
    backfillDays: number
    backfillUpserted: number
    backfillCursorRemaining: string | null
    error: string | null
  }> = []

  for (const dealerId of dealerIds) {
    try {
      const result = await ingestDealer(dealerId, payload.backfillDays)
      perDealer.push({ dealerId, error: null, ...result })
    } catch (e) {
      perDealer.push({
        dealerId,
        forwardSeen: 0,
        forwardUpserted: 0,
        forwardSkippedPending: 0,
        backfillDays: 0,
        backfillUpserted: 0,
        backfillCursorRemaining: null,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'config.workers.sweed_purchases_ingest.completed',
      module: 'config',
      payload: {
        jobId: context.id,
        trigger: payload.trigger,
        backfillDaysRequested: payload.backfillDays,
        perDealer,
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

interface DealerResult {
  forwardSeen: number
  forwardUpserted: number
  forwardSkippedPending: number
  backfillDays: number
  backfillUpserted: number
  backfillCursorRemaining: string | null
}

async function ingestDealer(dealerId: number, requestedBackfillDays: number): Promise<DealerResult> {
  const siteKey = HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((d) => d.dealerId === dealerId)?.siteKey
  if (!siteKey) throw new Error(`Unknown helios dealer ${dealerId}`)

  const state = await ensureIngestState(dealerId)

  // ----- 1. Forward poll -----
  const today = nyDateString(new Date())
  const fwdFrom =
    state.highwaterDeliveryDate !== null
      ? state.highwaterDeliveryDate
      : decrementIsoDate(today)
  // Walk back FORWARD_OVERLAP_DAYS days to be robust to late-arriving
  // status flips (e.g. a Sweed user marking received yesterday's PO
  // this morning).
  let from = fwdFrom
  for (let i = 0; i < FORWARD_OVERLAP_DAYS; i++) from = decrementIsoDate(from)

  const fwd = await fetchAndUpsertWindow(dealerId, siteKey, from, today)
  let newHighwater = state.highwaterDeliveryDate
  if (newHighwater === null || today > newHighwater) newHighwater = today

  // ----- 2. Backfill one or more historical days -----
  let backfillCursor = state.backfillCursorDay
  let backfillDays = 0
  let backfillUpserted = 0
  for (let i = 0; i < requestedBackfillDays && backfillCursor !== null; i++) {
    const day = backfillCursor
    const dayRes = await fetchAndUpsertWindow(dealerId, siteKey, day, day)
    backfillUpserted += dayRes.upserted
    backfillDays += 1
    const prev = decrementIsoDate(backfillCursor)
    if (prev < state.minDeliveryDate) backfillCursor = null
    else backfillCursor = prev
  }

  // ----- 3. Persist state -----
  await withTransaction(async (db) => {
    await db.query(
      `
        update sweed_purchases_ingest_state
           set highwater_delivery_date = greatest(highwater_delivery_date, $2::date),
               backfill_cursor_day = $3,
               last_polled_at = now(),
               last_seen_count = $4,
               last_upserted_count = $5,
               last_skipped_pending_count = $6,
               consecutive_empty_polls = case when $5 = 0 and $7 = 0 then consecutive_empty_polls + 1 else 0 end
         where dealer_id = $1
      `,
      [
        dealerId,
        newHighwater,
        backfillCursor,
        fwd.seen,
        fwd.upserted,
        fwd.skippedPending,
        backfillUpserted,
      ],
    )
  })

  return {
    forwardSeen: fwd.seen,
    forwardUpserted: fwd.upserted,
    forwardSkippedPending: fwd.skippedPending,
    backfillDays,
    backfillUpserted,
    backfillCursorRemaining: backfillCursor,
  }
}

interface IngestState {
  highwaterDeliveryDate: string | null
  minDeliveryDate: string
  backfillCursorDay: string | null
}

async function ensureIngestState(dealerId: number): Promise<IngestState> {
  return withTransaction(async (db) => {
    const existing = await db.query<{
      highwater_delivery_date: string | Date | null
      min_delivery_date: string | Date
      backfill_cursor_day: string | Date | null
    }>(
      `select highwater_delivery_date, min_delivery_date, backfill_cursor_day
         from sweed_purchases_ingest_state
        where dealer_id = $1`,
      [dealerId],
    )
    if (existing.rows.length === 1) {
      const r = existing.rows[0]!
      return {
        highwaterDeliveryDate: coerceCursorToIso(r.highwater_delivery_date),
        minDeliveryDate: coerceCursorToIso(r.min_delivery_date) ?? '2024-01-01',
        backfillCursorDay: coerceCursorToIso(r.backfill_cursor_day),
      }
    }
    const openingIso = HELIOS_SWEED_DEALER_OPENING_DATES[dealerId] ?? '2024-01-01'
    const todayIso = nyDateString(new Date())
    const initialCursor = decrementIsoDate(todayIso)
    await db.query(
      `
        insert into sweed_purchases_ingest_state
          (dealer_id, highwater_delivery_date, min_delivery_date, backfill_cursor_day, notes)
        values ($1, null, $2, $3, $4)
        on conflict (dealer_id) do nothing
      `,
      [dealerId, openingIso, initialCursor, `Seeded by ingest worker; opening=${openingIso}`],
    )
    return {
      highwaterDeliveryDate: null,
      minDeliveryDate: openingIso,
      backfillCursorDay: initialCursor,
    }
  })
}

interface WindowResult {
  seen: number
  upserted: number
  skippedPending: number
}

async function fetchAndUpsertWindow(
  dealerId: number,
  siteKey: string,
  fromDate: string,
  toDate: string,
): Promise<WindowResult> {
  // Page through the list endpoint until either we get a short page or
  // we exceed PO_LIST_PAGE_SIZE×5 rows (a defensive ceiling so a
  // misbehaving response can't loop forever).
  const seenIds: Array<{ id: string; orderStatusId: number | null }> = []
  let page = 1
  while (seenIds.length < PO_LIST_PAGE_SIZE * 5) {
    const raw = await callSweedRpc<unknown>(dealerId, 'store.purchase.order.list', {
      fromDate,
      toDate,
      page,
      pageSize: PO_LIST_PAGE_SIZE,
    })
    const parsed = PoListResponseSchema.safeParse(raw)
    if (!parsed.success) break
    const rows = parsed.data.data
    for (const r of rows) {
      seenIds.push({
        id: String(r.id),
        orderStatusId: r.orderStatusId ?? null,
      })
    }
    if (rows.length < PO_LIST_PAGE_SIZE) break
    page += 1
  }

  let upserted = 0
  let skippedPending = 0
  for (const stub of seenIds) {
    if (stub.orderStatusId === PENDING_ORDER_STATUS_ID) {
      skippedPending += 1
      continue
    }
    try {
      const detailRaw = await callSweedRpc<unknown>(dealerId, 'store.purchase.order.get', {
        id: stub.id,
      })
      const parsed = PoDetailSchema.safeParse(detailRaw)
      if (!parsed.success) {
        console.warn(
          `[sweed_purchases_ingest] PO ${stub.id} dealer=${dealerId} failed schema parse:`,
          parsed.error.message,
        )
        continue
      }
      const detail = parsed.data
      // Sometimes orderStatusId on the get-detail differs from the
      // list stub; honour the detail. Pending POs are still owned by
      // the pending-purchases workflow.
      if (detail.orderStatus?.id === PENDING_ORDER_STATUS_ID) {
        skippedPending += 1
        continue
      }
      const header = normaliseHeader(dealerId, siteKey, detail)
      const lines = (detail.positions ?? []).map((p, i) => normaliseLine(i, p))
      await upsertPurchase(header, lines)
      upserted += 1
    } catch (e) {
      console.warn(
        `[sweed_purchases_ingest] PO ${stub.id} dealer=${dealerId} get failed:`,
        e instanceof Error ? e.message : String(e),
      )
    }
  }
  return { seen: seenIds.length, upserted, skippedPending }
}

async function upsertPurchase(header: NormalisedHeader, lines: NormalisedLine[]): Promise<void> {
  await withTransaction(async (db) => {
    // ----- Pre-resolve package matches via metrc_tag → snapshot -----
    const metrcTags = lines.map((l) => l.metrcTag).filter((t): t is string => t !== null)
    const metrcToPackages = new Map<string, { inventoryItemIds: string[]; receivedAtMin: Date | null; receivedAtMax: Date | null }>()
    if (metrcTags.length > 0) {
      const res = await db.query<{
        metrc_tag: string
        inventory_item_id: string
        received_at_min: string | Date | null
        received_at_max: string | Date | null
      }>(
        `select sps.metrc_tag,
                sps.inventory_item_id,
                min(sps.received_at) as received_at_min,
                max(sps.observed_at_max) as received_at_max
           from sweed_package_snapshots sps
          where sps.dealer_id = $1
            and sps.metrc_tag = any($2::text[])
          group by sps.metrc_tag, sps.inventory_item_id`,
        [header.dealerId, metrcTags],
      )
      for (const row of res.rows) {
        const prev = metrcToPackages.get(row.metrc_tag) ?? {
          inventoryItemIds: [],
          receivedAtMin: null,
          receivedAtMax: null,
        }
        prev.inventoryItemIds.push(row.inventory_item_id)
        const rmin = row.received_at_min ? new Date(row.received_at_min as string) : null
        const rmax = row.received_at_max ? new Date(row.received_at_max as string) : null
        if (rmin && (!prev.receivedAtMin || rmin < prev.receivedAtMin)) prev.receivedAtMin = rmin
        if (rmax && (!prev.receivedAtMax || rmax > prev.receivedAtMax)) prev.receivedAtMax = rmax
        metrcToPackages.set(row.metrc_tag, prev)
      }
    }

    // ----- Also pull product → catalog denorms from sweed_package_snapshots
    //       so we can fill brand/category/subcategory/size on the line
    //       without a second round-trip per-render. We use the most
    //       recent snapshot keyed off inventory_item_id (the metrc
    //       match) when available, else by sweed_product_id.
    const inventoryItemIds = [...new Set(
      [...metrcToPackages.values()].flatMap((v) => v.inventoryItemIds),
    )]
    const sweedProductIds = [
      ...new Set(lines.map((l) => l.sweedProductId).filter((v): v is number => v !== null)),
    ]
    const productDenormByInv = new Map<
      string,
      { brandName: string | null; brandId: number | null; categoryName: string | null; categoryId: number | null; subcategoryName: string | null; subcategoryId: number | null; sizeLabel: string | null; productName: string | null; productSku: string | null }
    >()
    const productDenormByProductId = new Map<
      number,
      { brandName: string | null; brandId: number | null; categoryName: string | null; categoryId: number | null; subcategoryName: string | null; subcategoryId: number | null; sizeLabel: string | null; productName: string | null; productSku: string | null }
    >()
    if (inventoryItemIds.length > 0) {
      const res = await db.query<{
        inventory_item_id: string
        product_id: number | null
        product_name: string | null
        product_sku: string | null
        brand_id: number | null
        brand_name: string | null
        category_id: number | null
        category_name: string | null
        subcategory_id: number | null
        subcategory_name: string | null
        size_label: string | null
      }>(
        `select inventory_item_id, product_id, product_name, product_sku,
                brand_id, brand_name, category_id, category_name,
                subcategory_id, subcategory_name, size_label
           from sweed_package_current
          where dealer_id = $1
            and inventory_item_id = any($2::text[])`,
        [header.dealerId, inventoryItemIds],
      )
      for (const row of res.rows) {
        productDenormByInv.set(row.inventory_item_id, {
          brandName: row.brand_name,
          brandId: row.brand_id,
          categoryName: row.category_name,
          categoryId: row.category_id,
          subcategoryName: row.subcategory_name,
          subcategoryId: row.subcategory_id,
          sizeLabel: row.size_label,
          productName: row.product_name,
          productSku: row.product_sku,
        })
        if (row.product_id) {
          productDenormByProductId.set(row.product_id, {
            brandName: row.brand_name,
            brandId: row.brand_id,
            categoryName: row.category_name,
            categoryId: row.category_id,
            subcategoryName: row.subcategory_name,
            subcategoryId: row.subcategory_id,
            sizeLabel: row.size_label,
            productName: row.product_name,
            productSku: row.product_sku,
          })
        }
      }
    }
    if (sweedProductIds.length > 0) {
      const res = await db.query<{
        product_id: number
        product_name: string | null
        product_sku: string | null
        brand_id: number | null
        brand_name: string | null
        category_id: number | null
        category_name: string | null
        subcategory_id: number | null
        subcategory_name: string | null
        size_label: string | null
      }>(
        `select distinct on (product_id) product_id, product_name, product_sku,
                brand_id, brand_name, category_id, category_name,
                subcategory_id, subcategory_name, size_label
           from sweed_package_snapshots
          where dealer_id = $1
            and product_id = any($2::bigint[])
          order by product_id, observed_at_max desc`,
        [header.dealerId, sweedProductIds],
      )
      for (const row of res.rows) {
        if (!productDenormByProductId.has(row.product_id)) {
          productDenormByProductId.set(row.product_id, {
            brandName: row.brand_name,
            brandId: row.brand_id,
            categoryName: row.category_name,
            categoryId: row.category_id,
            subcategoryName: row.subcategory_name,
            subcategoryId: row.subcategory_id,
            sizeLabel: row.size_label,
            productName: row.product_name,
            productSku: row.product_sku,
          })
        }
      }
    }

    // ----- Compute line-level denorms + header roll-ups -----
    interface ResolvedLine extends NormalisedLine {
      matchedInventoryItemIds: string[]
      packageMatchMethod: string
      packageMatchConfidence: number | null
      receivedAtMin: Date | null
      receivedAtMax: Date | null
      brandId: number | null
      brandName: string | null
      categoryId: number | null
      categoryName: string | null
      subcategoryId: number | null
      subcategoryName: string | null
      resolvedSizeLabel: string | null
      productName: string | null
      productSku: string | null
    }
    const resolved: ResolvedLine[] = lines.map((l) => {
      const match = l.metrcTag ? metrcToPackages.get(l.metrcTag) : undefined
      const matchedIds = match?.inventoryItemIds ?? []
      const denormFromInv = matchedIds.length > 0 ? productDenormByInv.get(matchedIds[0]!) : undefined
      const denormFromProd =
        l.sweedProductId !== null ? productDenormByProductId.get(l.sweedProductId) : undefined
      const denorm = denormFromInv ?? denormFromProd ?? null
      return {
        ...l,
        matchedInventoryItemIds: matchedIds,
        packageMatchMethod: matchedIds.length > 0 ? 'direct_metrc_tag' : 'unmatched',
        packageMatchConfidence: matchedIds.length > 0 ? 1 : null,
        receivedAtMin: match?.receivedAtMin ?? null,
        receivedAtMax: match?.receivedAtMax ?? null,
        brandId: denorm?.brandId ?? null,
        brandName: denorm?.brandName ?? null,
        categoryId: denorm?.categoryId ?? null,
        categoryName: denorm?.categoryName ?? null,
        subcategoryId: denorm?.subcategoryId ?? null,
        subcategoryName: denorm?.subcategoryName ?? null,
        resolvedSizeLabel: l.sizeLabel ?? denorm?.sizeLabel ?? null,
        productName: denorm?.productName ?? l.sweedProductName ?? null,
        productSku: denorm?.productSku ?? null,
      }
    })

    const productIds = [...new Set(resolved.map((r) => r.sweedProductId).filter((v): v is number => v !== null))]
    const productNames = [...new Set(resolved.map((r) => r.productName ?? r.sweedProductName).filter((v): v is string => !!v))]
    const brandNames = [...new Set(resolved.map((r) => r.brandName).filter((v): v is string => !!v))]
    const categoryNames = [...new Set(resolved.map((r) => r.categoryName).filter((v): v is string => !!v))]
    const subcategoryNames = [...new Set(resolved.map((r) => r.subcategoryName).filter((v): v is string => !!v))]
    const lineCount = resolved.length
    const orderedUnitsTotal =
      header.orderedUnitsTotal ?? resolved.reduce((sum, r) => sum + (r.orderedUnits || 0), 0)
    const extendedTotal = resolved.reduce(
      (sum, r) => sum + (r.extendedCostDollars ?? 0),
      0,
    )

    await db.query(
      `
        insert into sweed_purchases (
          dealer_id, po_id, site_key,
          po_name, external_order_id, delivery_date, delivery_at, payment_due_date,
          order_status_name, financial_status_name, is_cash_on_delivery,
          distributor_id, distributor_name, distributor_integration_id, distributor_integration_name,
          po_total_dollars, po_subtotal_dollars, po_regular_amount_dollars,
          po_discount_amount_dollars, po_delivery_charges_dollars, po_tax_dollars, po_owed_dollars,
          ordered_units_total, distributor_product_qty_total, line_count,
          product_ids, product_names, brand_names, category_names, subcategory_names,
          fetched_at, raw_json
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
          $26::bigint[], $27::text[], $28::text[], $29::text[], $30::text[],
          now(), $31::jsonb
        )
        on conflict (dealer_id, po_id) do update set
          site_key = excluded.site_key,
          po_name = excluded.po_name,
          external_order_id = excluded.external_order_id,
          delivery_date = excluded.delivery_date,
          delivery_at = excluded.delivery_at,
          payment_due_date = excluded.payment_due_date,
          order_status_name = excluded.order_status_name,
          financial_status_name = excluded.financial_status_name,
          is_cash_on_delivery = excluded.is_cash_on_delivery,
          distributor_id = excluded.distributor_id,
          distributor_name = excluded.distributor_name,
          distributor_integration_id = excluded.distributor_integration_id,
          distributor_integration_name = excluded.distributor_integration_name,
          po_total_dollars = excluded.po_total_dollars,
          po_subtotal_dollars = excluded.po_subtotal_dollars,
          po_regular_amount_dollars = excluded.po_regular_amount_dollars,
          po_discount_amount_dollars = excluded.po_discount_amount_dollars,
          po_delivery_charges_dollars = excluded.po_delivery_charges_dollars,
          po_tax_dollars = excluded.po_tax_dollars,
          po_owed_dollars = excluded.po_owed_dollars,
          ordered_units_total = excluded.ordered_units_total,
          distributor_product_qty_total = excluded.distributor_product_qty_total,
          line_count = excluded.line_count,
          product_ids = excluded.product_ids,
          product_names = excluded.product_names,
          brand_names = excluded.brand_names,
          category_names = excluded.category_names,
          subcategory_names = excluded.subcategory_names,
          fetched_at = now(),
          updated_at = now(),
          raw_json = excluded.raw_json
      `,
      [
        header.dealerId,
        header.poId,
        header.siteKey,
        header.poName,
        header.externalOrderId,
        header.deliveryDate,
        header.deliveryAt ? header.deliveryAt.toISOString() : null,
        header.paymentDueDate,
        header.orderStatusName,
        header.financialStatusName,
        header.isCashOnDelivery,
        header.distributorId,
        header.distributorName,
        header.distributorIntegrationId,
        header.distributorIntegrationName,
        header.poTotalDollars ?? extendedTotal,
        header.poSubtotalDollars,
        header.poRegularDollars,
        header.poDiscountDollars,
        header.poDeliveryChargesDollars,
        header.poTaxDollars,
        header.poOwedDollars,
        orderedUnitsTotal,
        header.distributorProductQtyTotal,
        lineCount,
        productIds,
        productNames,
        brandNames,
        categoryNames,
        subcategoryNames,
        JSON.stringify(header.raw),
      ],
    )

    await db.query(
      `delete from sweed_purchase_line_items where dealer_id = $1 and po_id = $2`,
      [header.dealerId, header.poId],
    )

    for (const r of resolved) {
      await db.query(
        `
          insert into sweed_purchase_line_items (
            dealer_id, po_id, line_id, line_index,
            distributor_product_id, distributor_product_name,
            sweed_product_id, sweed_product_name,
            product_name, product_sku,
            brand_id, brand_name, category_id, category_name,
            subcategory_id, subcategory_name, size_label, pack_count,
            ordered_units, distributor_product_qty,
            extended_cost_dollars, unit_cost_dollars, unit_cost_source,
            discount_product_price_dollars, metrc_wholesale_price_dollars,
            is_trade_sample, is_testing_sample,
            list_price_dollars_at_ingest,
            metrc_tag, matched_inventory_item_ids,
            package_match_method, package_match_confidence,
            received_at_min, received_at_max,
            fetched_at, raw_json
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
            $29, $30::text[], $31, $32, $33, $34, now(), $35::jsonb
          )
        `,
        [
          header.dealerId,
          header.poId,
          r.lineId,
          r.lineIndex,
          r.distributorProductId,
          r.distributorProductName,
          r.sweedProductId,
          r.sweedProductName,
          r.productName,
          r.productSku,
          r.brandId,
          r.brandName,
          r.categoryId,
          r.categoryName,
          r.subcategoryId,
          r.subcategoryName,
          r.resolvedSizeLabel,
          r.packCount,
          r.orderedUnits,
          r.distributorProductQty,
          r.extendedCostDollars,
          r.unitCostDollars,
          r.unitCostSource,
          r.discountProductPriceDollars,
          r.metrcWholesalePriceDollars,
          r.isTradeSample,
          r.isTestingSample,
          r.listPriceDollarsAtIngest,
          r.metrcTag,
          r.matchedInventoryItemIds,
          r.packageMatchMethod,
          r.packageMatchConfidence,
          r.receivedAtMin ? r.receivedAtMin.toISOString() : null,
          r.receivedAtMax ? r.receivedAtMax.toISOString() : null,
          JSON.stringify(r.raw),
        ],
      )
    }
  })
}
