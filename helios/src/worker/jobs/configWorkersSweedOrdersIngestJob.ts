import { z } from 'zod'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  HELIOS_SWEED_DEALER_OPENING_DATES,
  type ConfigWorkersSweedOrdersIngestJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import { listSaleInvoices, type SweedInvoiceRow } from '../sweed/sales.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// ============================================================================
// Sweed orders ingest worker (FreshlyBakedNYC/automation#22, sibling/
// unblocker for #21 — Business & Performance Metrics page tree).
//
// One job per scheduler tick. For each dealer we:
//
//   1. **Forward poll** — fetch invoices from `highwater - OVERLAP` to
//      `now`, upsert into `sweed_orders` via `on conflict do nothing`,
//      advance the highwater to `max(pay_time)` of the inserted batch.
//   2. **Backfill one day** — if `backfill_cursor_day` is non-null,
//      fetch invoices for that day, insert (same upsert), decrement
//      the cursor by one day. Stops when the cursor reaches the
//      dealer's store-opening date (`min_pay_time`).
//
// The `OVERLAP` window covers two failure modes:
//   * Sweed's `payTime` precision is seconds; multiple invoices can
//     share a second, and a strict `>` cursor would miss the second
//     one. Overlap + `on conflict do nothing` is idempotent.
//   * Late-arriving rows (e.g. kiosk offline → ticket lands minutes
//     after pay). The overlap window guarantees re-poll catches them.
// ============================================================================

/** Forward-poll overlap window — see the long comment above. */
const FORWARD_POLL_OVERLAP_MS = 15 * 60 * 1000

/** Fallback per-dealer highwater seed if no row exists and there is
 * no entry in `HELIOS_SWEED_DEALER_OPENING_DATES`. We assume the
 * dealer is "new" and seed the highwater 1h in the past so the next
 * forward poll picks up everything since. */
const FALLBACK_BACKFILL_DAYS = 0

const NY_TZ = 'America/New_York'

// ----- Loose schema for fields we want off the raw invoice envelope -----
//
// `listSaleInvoices()` returns a narrow normalised shape (invoice id,
// pay time, total, customer summary) plus the raw envelope. We want
// a few extra header fields for metrics queries; this Zod schema
// extracts them defensively. Any new field added here MUST be
// `.optional()` because Sweed's envelope is operator-configurable.
const InvoiceEnvelopeSchema = z
  .object({
    subTotalAmount: z.coerce.number().nullable().optional(),
    taxAmount: z.coerce.number().nullable().optional(),
    discountAmount: z.coerce.number().nullable().optional(),
    // Fulfillment is exposed under several field names in different
    // Sweed builds. We try them in preference order.
    fulfillmentType: z.string().nullable().optional(),
    orderType: z.string().nullable().optional(),
    deliveryType: z.string().nullable().optional(),
    saleType: z.string().nullable().optional(),
    // Payments may be a single `paymentMethod` string or an array
    // of `payments[].method`. We collapse to a single string for
    // simple stacking; `raw_json` keeps the full breakdown.
    paymentMethod: z.string().nullable().optional(),
    payments: z
      .array(
        z
          .object({
            method: z.string().nullable().optional(),
            type: z.string().nullable().optional(),
            paymentMethod: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
    deliveryAddress: z
      .object({
        zip: z.string().nullable().optional(),
        zipCode: z.string().nullable().optional(),
        postalCode: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    // Some Sweed builds put the address one level up.
    address: z
      .object({
        zip: z.string().nullable().optional(),
        zipCode: z.string().nullable().optional(),
        postalCode: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

interface NormalisedInvoice {
  invoiceId: string
  payTime: Date
  customerId: number | null
  isGuest: boolean
  grandTotal: number
  subtotal: number | null
  tax: number | null
  discount: number | null
  fulfillmentType: string | null
  paymentMethod: string | null
  deliveryZip: string | null
  raw: unknown
}

function pickFulfillment(env: z.infer<typeof InvoiceEnvelopeSchema>): string | null {
  return (
    (env.fulfillmentType?.trim() ?? null) ||
    (env.orderType?.trim() ?? null) ||
    (env.deliveryType?.trim() ?? null) ||
    (env.saleType?.trim() ?? null) ||
    null
  )
}

function pickPaymentMethod(env: z.infer<typeof InvoiceEnvelopeSchema>): string | null {
  const flat = env.paymentMethod?.trim()
  if (flat && flat.length > 0) return flat
  const payments = env.payments ?? []
  for (const p of payments) {
    const m = p.method ?? p.type ?? p.paymentMethod
    if (typeof m === 'string' && m.trim().length > 0) return m.trim()
  }
  return null
}

function pickDeliveryZip(env: z.infer<typeof InvoiceEnvelopeSchema>): string | null {
  const candidates = [
    env.deliveryAddress?.zip,
    env.deliveryAddress?.zipCode,
    env.deliveryAddress?.postalCode,
    env.address?.zip,
    env.address?.zipCode,
    env.address?.postalCode,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      // Normalise to first 5 digits of US zip if available.
      const m = c.trim().match(/^(\d{5})/)
      return m ? m[1]! : c.trim()
    }
  }
  return null
}

function normaliseForIngest(row: SweedInvoiceRow): NormalisedInvoice | null {
  if (row.invoiceId === null || row.saleTime === null || row.total === null) {
    return null
  }
  const parsed = InvoiceEnvelopeSchema.safeParse(row.raw)
  const env = parsed.success ? parsed.data : ({} as z.infer<typeof InvoiceEnvelopeSchema>)
  return {
    invoiceId: row.invoiceId,
    payTime: row.saleTime,
    customerId: row.clientId,
    isGuest: row.clientId === null,
    grandTotal: row.total,
    subtotal: env.subTotalAmount ?? null,
    tax: env.taxAmount ?? null,
    discount: env.discountAmount ?? null,
    fulfillmentType: pickFulfillment(env),
    paymentMethod: pickPaymentMethod(env),
    deliveryZip: pickDeliveryZip(env),
    raw: row.raw,
  }
}

// ----- ET-day boundary helpers -----
//
// We want the UTC instants that bracket an ET local day, so a
// "2025-07-15 in NY" query rounds correctly across DST.
function partsInNY(d: Date): { y: number; m: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const map: Record<string, string> = {}
  for (const p of fmt.formatToParts(d)) map[p.type] = p.value
  return {
    y: Number(map.year),
    m: Number(map.month),
    day: Number(map.day),
  }
}

function offsetMsAt(instantUtc: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const map: Record<string, string> = {}
  for (const p of fmt.formatToParts(instantUtc)) map[p.type] = p.value
  const asIfUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour === '24' ? '00' : map.hour),
    Number(map.minute),
    Number(map.second),
  )
  return asIfUtc - instantUtc.getTime()
}

/** Returns the UTC instant for "00:00 in NY on the given ISO date". */
function nyDayStartUtc(isoDate: string): Date {
  const [yStr, mStr, dStr] = isoDate.split('-')
  const y = Number(yStr)
  const m = Number(mStr)
  const d = Number(dStr)
  // First approximation: treat 00:00 local as if it were UTC.
  const approxUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0)
  const approx = new Date(approxUtcMs)
  // Compute the NY offset at that approximate instant; subtract to
  // pull the wall-clock moment back to true 00:00 NY.
  const off = offsetMsAt(approx)
  return new Date(approxUtcMs - off)
}

/** "YYYY-MM-DD" of the given UTC instant interpreted in NY. */
function nyDateString(d: Date): string {
  const { y, m, day } = partsInNY(d)
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Subtract one day from a "YYYY-MM-DD" string. */
function decrementIsoDate(iso: string): string {
  const [yStr, mStr, dStr] = iso.split('-')
  const t = Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr)) - 24 * 60 * 60 * 1000
  const d = new Date(t)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// ----- Job entry point -----

export async function runConfigWorkersSweedOrdersIngestJob(
  context: JobHandlerContext,
  payload: ConfigWorkersSweedOrdersIngestJobPayload,
): Promise<void> {
  const candidates =
    payload.siteDealerIds.length > 0
      ? payload.siteDealerIds
      : HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => d.dealerId)
  const dealerIds = [...new Set(candidates)]

  const perDealer: Array<{
    dealerId: number
    forwardSeen: number
    forwardInserted: number
    backfillDays: number
    backfillInserted: number
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
        forwardInserted: 0,
        backfillDays: 0,
        backfillInserted: 0,
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
      eventType: 'config.workers.sweed_orders_ingest.completed',
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
  forwardInserted: number
  backfillDays: number
  backfillInserted: number
  backfillCursorRemaining: string | null
}

async function ingestDealer(dealerId: number, requestedBackfillDays: number): Promise<DealerResult> {
  const state = await ensureHighwaterRow(dealerId)

  // ----- 1. Forward poll -----
  const now = new Date()
  const fromUtc = new Date(state.highwaterPayTime.getTime() - FORWARD_POLL_OVERLAP_MS)
  const forward = await fetchAndInsert(dealerId, fromUtc, now)
  let newHighwater = state.highwaterPayTime
  for (const inv of forward.normalised) {
    if (inv.payTime > newHighwater) newHighwater = inv.payTime
  }

  // ----- 2. Backfill (one or more historical days, oldest first
  //         within each call, but cursor walks newest→oldest) -----
  let backfillCursor = state.backfillCursorDay
  let backfillDaysDone = 0
  let backfillInserted = 0
  for (let i = 0; i < requestedBackfillDays && backfillCursor !== null; i++) {
    const dayStart = nyDayStartUtc(backfillCursor)
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
    const day = await fetchAndInsert(dealerId, dayStart, dayEnd)
    backfillInserted += day.insertedCount
    backfillDaysDone++

    const prev = decrementIsoDate(backfillCursor)
    const prevStart = nyDayStartUtc(prev)
    // Stop when the next-prev day's start would be before min_pay_time
    // (i.e., we've reached the dealer's opening date).
    if (prevStart < state.minPayTime) {
      backfillCursor = null
    } else {
      backfillCursor = prev
    }
  }

  // ----- 3. Persist updated cursor + highwater + counters -----
  await withTransaction(async (db) => {
    await db.query(
      `
        update sweed_orders_ingest_highwater
           set highwater_pay_time = greatest(highwater_pay_time, $2),
               backfill_cursor_day = $3,
               last_polled_at = now(),
               last_seen_count = $4,
               last_inserted_count = $5,
               consecutive_empty_polls = case when $5 = 0 and $6 = 0 then consecutive_empty_polls + 1 else 0 end
         where dealer_id = $1
      `,
      [
        dealerId,
        newHighwater.toISOString(),
        backfillCursor,
        forward.normalised.length,
        forward.insertedCount,
        backfillInserted,
      ],
    )
  })

  return {
    forwardSeen: forward.normalised.length,
    forwardInserted: forward.insertedCount,
    backfillDays: backfillDaysDone,
    backfillInserted,
    backfillCursorRemaining: backfillCursor,
  }
}

interface HighwaterState {
  highwaterPayTime: Date
  minPayTime: Date
  backfillCursorDay: string | null
}

async function ensureHighwaterRow(dealerId: number): Promise<HighwaterState> {
  return withTransaction(async (db) => {
    const existing = await db.query<{
      highwater_pay_time: string
      min_pay_time: string
      backfill_cursor_day: string | null
    }>(
      `select highwater_pay_time, min_pay_time, backfill_cursor_day
         from sweed_orders_ingest_highwater
        where dealer_id = $1`,
      [dealerId],
    )
    if (existing.rows.length === 1) {
      const r = existing.rows[0]!
      return {
        highwaterPayTime: new Date(r.highwater_pay_time),
        minPayTime: new Date(r.min_pay_time),
        backfillCursorDay: r.backfill_cursor_day,
      }
    }
    const openingIso = HELIOS_SWEED_DEALER_OPENING_DATES[dealerId]
    const minPayTime = openingIso
      ? nyDayStartUtc(openingIso)
      : new Date(Date.now() - FALLBACK_BACKFILL_DAYS * 24 * 60 * 60 * 1000)
    // Highwater seeded at now() - 1h: the first forward poll catches
    // anything that landed in the last hour while backfill chips
    // away at the historical tail. Backfill cursor starts at
    // "yesterday in NY" (today is being covered by the forward poll
    // window and the next ticks).
    const highwater = new Date(Date.now() - 60 * 60 * 1000)
    const todayIso = nyDateString(new Date())
    const initialCursor = openingIso ? decrementIsoDate(todayIso) : null
    await db.query(
      `
        insert into sweed_orders_ingest_highwater
          (dealer_id, highwater_pay_time, min_pay_time, backfill_cursor_day, notes)
        values ($1, $2, $3, $4, $5)
        on conflict (dealer_id) do nothing
      `,
      [
        dealerId,
        highwater.toISOString(),
        minPayTime.toISOString(),
        initialCursor,
        `Seeded by ingest worker; opening=${openingIso ?? 'unknown'}`,
      ],
    )
    return {
      highwaterPayTime: highwater,
      minPayTime,
      backfillCursorDay: initialCursor,
    }
  })
}

interface FetchAndInsertResult {
  normalised: NormalisedInvoice[]
  insertedCount: number
}

async function fetchAndInsert(
  dealerId: number,
  fromDate: Date,
  toDate: Date,
): Promise<FetchAndInsertResult> {
  const rows = await listSaleInvoices({ dealerId, fromDate, toDate })
  const normalised: NormalisedInvoice[] = []
  for (const r of rows) {
    const n = normaliseForIngest(r)
    if (n !== null) normalised.push(n)
  }
  if (normalised.length === 0) {
    return { normalised, insertedCount: 0 }
  }
  const insertedCount = await withTransaction(async (db) => {
    let inserted = 0
    for (const n of normalised) {
      // Determine first_time_for_customer at insert time (cheap
      // single-row query against the indexed customer_id, pay_time
      // composite). For guests we leave it null.
      let firstTime: boolean | null = null
      if (n.customerId !== null) {
        const prior = await db.query<{ exists: boolean }>(
          `select exists(
             select 1
               from sweed_orders
              where customer_id = $1
                and pay_time < $2
           ) as exists`,
          [n.customerId, n.payTime.toISOString()],
        )
        firstTime = !(prior.rows[0]?.exists ?? false)
      }
      const result = await db.query(
        `
          insert into sweed_orders (
            dealer_id, invoice_id, pay_time, customer_id, is_guest,
            first_time_for_customer, grand_total_dollars, subtotal_dollars,
            tax_dollars, discount_dollars, fulfillment_type, payment_method,
            delivery_zip, raw_json
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb
          )
          on conflict (dealer_id, invoice_id) do nothing
        `,
        [
          dealerId,
          n.invoiceId,
          n.payTime.toISOString(),
          n.customerId,
          n.isGuest,
          firstTime,
          n.grandTotal,
          n.subtotal,
          n.tax,
          n.discount,
          n.fulfillmentType,
          n.paymentMethod,
          n.deliveryZip,
          JSON.stringify(n.raw),
        ],
      )
      if ((result.rowCount ?? 0) > 0) inserted++
    }
    return inserted
  })
  return { normalised, insertedCount }
}
