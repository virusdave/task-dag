import { z } from 'zod'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  HELIOS_SWEED_DEALER_OPENING_DATES,
  type ConfigWorkersSweedPurchasesIngestJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import {
  PoDetailSchema,
  normaliseHeader,
  normaliseLine,
  upsertPurchase,
} from '../../server/catalogPurchaseSellThrough/purchaseMirrorUpsert.js'
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
