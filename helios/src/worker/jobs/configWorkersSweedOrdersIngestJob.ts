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
//   1. **Forward poll + settlement refresh** — fetch invoices from
//      `min(highwater - OVERLAP, now - SETTLEMENT_REFRESH)` to `now`,
//      UPSERT into `sweed_orders` via `on conflict do update` (refresh
//      financials + raw_json + re-flatten line items), advance the
//      highwater to `max(pay_time)` of the batch.
//   2. **Backfill one day** — if `backfill_cursor_day` is non-null,
//      fetch invoices for that day, upsert (same path), decrement
//      the cursor by one day. Stops when the cursor reaches the
//      dealer's store-opening date (`min_pay_time`).
//
// Why UPSERT + settlement refresh (2026-06): Sweed's order-LIST feed
// returns an order's HEADER financials (subtotalAmount / grandTotal)
// and per-line revenue as **0 / partial** while the order is still
// `Open` / `In process` — i.e. a prepaid pickup/preorder that has not
// yet been fulfilled+settled to `Paid`. payTime is stamped at creation,
// so once the order settles (often same-day, hours later) its payTime
// is already behind the forward-poll highwater and a plain
// `highwater - OVERLAP` poll never sees it again. The original pipeline
// snapshotted each invoice ONCE (`on conflict do nothing`, flatten only
// genuinely-new invoices), so an order first seen pre-settlement stayed
// frozen at 0/partial revenue forever. A live audit of Midtown's
// 2026-06-05 business day found 19 such orders undercounting
// $1,023.94 (~25% of the day) — the dominant cause of helios reporting
// well below Sweed's dashboard.
//
// Fix: (a) `on conflict do update` refreshes the financial / cashier /
// raw columns (but NOT first_time_for_customer, delivery_zip,
// delivery_address_id, invoice_get_status, invoice_get_polled_at,
// ingested_at — those are owned by the first sighting or by the
// address-enrichment job), (b) the items flatten DELETEs + re-INSERTs
// for EVERY touched invoice (inserted or updated), and (c) the forward
// poll always re-fetches at least the trailing SETTLEMENT_REFRESH
// window so late-settling orders converge to their `Paid` state. The
// one-time historical repair is done by re-walking backfill_cursor_day.
//
// The `OVERLAP` window covers two failure modes:
//   * Sweed's `payTime` precision is seconds; multiple invoices can
//     share a second, and a strict `>` cursor would miss the second
//     one. Overlap + the idempotent upsert covers it.
//   * Late-arriving rows (e.g. kiosk offline → ticket lands minutes
//     after pay). The overlap window guarantees re-poll catches them.
// ============================================================================

/** Forward-poll overlap window — see the long comment above. */
const FORWARD_POLL_OVERLAP_MS = 15 * 60 * 1000

/** Settlement-refresh window. Every forward poll re-fetches at least
 *  this far back so orders that were `Open` / `In process` (with 0 /
 *  partial revenue) when first seen get re-upserted once they settle
 *  to `Paid`. Live data shows orders settle same-day or next-day, so
 *  48h is a safe margin while keeping the per-tick page count small
 *  (~5 pages/dealer). Anything older than this is repaired by the
 *  backfill day-walk. */
const SETTLEMENT_REFRESH_MS = 48 * 60 * 60 * 1000

// Maximum rows per bulk INSERT round-trip. Same rationale as the
// A2 commit on configWorkersStockRefreshJob.ts: keeps the
// jsonb_to_recordset payload bounded well under pg's protocol
// limits while collapsing per-row round-trips into a handful of
// statements per dealer / batch.
const BULK_CHUNK_SIZE = 500

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
// extracts them defensively. Field shapes confirmed against live
// Bronx + Midtown invoices on 2026-05-26 — see
// docs/runbooks/helios-metrics.md.
const NamedEntitySchema = z.object({ name: z.string().nullable().optional() }).passthrough()

const InvoiceStatusEnvelopeSchema = z
  .object({ invoiceStatus: NamedEntitySchema.nullable().optional() })
  .passthrough()

const InvoiceEnvelopeSchema = z
  .object({
    // Cash side. Sweed uses lowercase-T `subtotalAmount` /
    // `taxesAmount` / `grandTotalDiscountAmount`.
    subtotalAmount: z.coerce.number().nullable().optional(),
    taxesAmount: z.coerce.number().nullable().optional(),
    grandTotalDiscountAmount: z.coerce.number().nullable().optional(),

    // Which Sweed user (cashier / pharmacist / kiosk attendant)
    // rang up this invoice. Retained from the v1 (pre-038) design
    // of automation#27 so a future v2 of
    // `cashier.transactions_per_hour` can divide each cashier's
    // invoice count by their clocked-in minutes via a join to
    // `sweed_drawer_shift_sessions.user_id`. The v1 today-metric
    // does not need this column — it estimates cashier-hours from
    // drawer-shift duration × session count — but populating it
    // now keeps the historical record correct.
    //
    // Field shape varies across Sweed RPC variants; we try every
    // alias we've seen in the wild. The canonical (and operator-
    // verified, 2026-05-28) field on `store.sale.invoice.list` is
    // `creatorId` (+ `creatorType=1` for User); the older
    // `createdById` / `createdBy.id` / `cashierId` aliases are
    // retained as fallbacks because we don't want to lose
    // attribution on a staging deployment that emits a different
    // name. `creatorType` is taken alongside `creatorId` so
    // `pickCashierUserId` can ignore non-User creators (system
    // / API / kiosk batch jobs).
    creatorId: z.union([z.string(), z.number()]).nullable().optional(),
    creatorType: z.union([z.string(), z.number()]).nullable().optional(),
    createdById: z.union([z.string(), z.number()]).nullable().optional(),
    createdBy: z
      .object({ id: z.union([z.string(), z.number()]).nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    cashierId: z.union([z.string(), z.number()]).nullable().optional(),

    // Fulfillment lives on `issuingType.name`. Known values:
    //   * "Kiosk order"
    //   * "Pick-up sale"
    //   * "Delivery sale"
    //   * "Pharmacy order"  (the in-store flow)
    issuingType: NamedEntitySchema.nullable().optional(),
    // `salesChannel` is a related but coarser signal ("Kiosk",
    // "POS", "Website", …). We keep it as a fallback only.
    salesChannel: NamedEntitySchema.nullable().optional(),

    // Payments is an array of `{ paymentMethod: { name }, amount }`.
    // We collapse to a single string (the largest-amount method) so
    // the chart stack stays sane; raw_json keeps the full breakdown
    // for any deeper analysis.
    payments: z
      .array(
        z
          .object({
            amount: z.coerce.number().nullable().optional(),
            totalPaid: z.coerce.number().nullable().optional(),
            paymentMethod: NamedEntitySchema.nullable().optional(),
          })
          .passthrough(),
      )
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
  invoiceStatusName: string | null
  deliveryZip: string | null
  cashierUserId: number | null
  raw: unknown
}

function pickCashierUserId(env: z.infer<typeof InvoiceEnvelopeSchema>): number | null {
  // creatorId is the canonical Sweed field (verified 2026-05-28
  // against live store.sale.invoice.list output). We only accept
  // it when creatorType is the User-type sentinel (1) so non-user
  // creators — API integrations, system batch jobs — don't get
  // mis-attributed as a cashier. Other Sweed variants emit the
  // older `createdById` / `createdBy.id` / `cashierId` aliases;
  // those are accepted unconditionally because they're explicit
  // user references and the older RPC variants don't carry a
  // creator-type discriminator at all.
  const creatorTypeRaw = env.creatorType
  const creatorTypeNum =
    typeof creatorTypeRaw === 'number'
      ? creatorTypeRaw
      : typeof creatorTypeRaw === 'string'
        ? Number(creatorTypeRaw)
        : null
  const creatorIsUser = creatorTypeNum === 1
  const candidates: Array<string | number | null | undefined> = [
    creatorIsUser ? env.creatorId : null,
    env.createdById,
    env.createdBy?.id,
    env.cashierId,
  ]
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c
    if (typeof c === 'string') {
      const n = Number(c)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

function pickFulfillment(env: z.infer<typeof InvoiceEnvelopeSchema>): string | null {
  const issuing = env.issuingType?.name?.trim()
  if (issuing && issuing.length > 0) return issuing
  const channel = env.salesChannel?.name?.trim()
  if (channel && channel.length > 0) return channel
  return null
}

function pickPaymentMethod(env: z.infer<typeof InvoiceEnvelopeSchema>): string | null {
  const payments = env.payments ?? []
  // Pick the method that contributed the largest `amount` so a small
  // "Reverse ATM change" tender doesn't outvote the primary cash row.
  let bestName: string | null = null
  let bestAmount = -Infinity
  for (const p of payments) {
    const name = p.paymentMethod?.name?.trim()
    if (!name || name.length === 0) continue
    const amount = typeof p.amount === 'number' ? p.amount : 0
    if (amount > bestAmount) {
      bestAmount = amount
      bestName = name
    }
  }
  return bestName
}

export function invoiceStatusNameForIngest(raw: unknown): string | null {
  const parsed = InvoiceStatusEnvelopeSchema.safeParse(raw)
  if (!parsed.success) return null
  const name = parsed.data.invoiceStatus?.name?.trim()
  return name !== undefined && name.length > 0 ? name : null
}

function pickDeliveryZip(_env: z.infer<typeof InvoiceEnvelopeSchema>): string | null {
  // `store.sale.invoice.list` does not include the delivery address;
  // that field is only surfaced by `store.sale.invoice.get`. Until
  // we add a per-invoice get-call follow-on, the customer-origin
  // metric falls back to "Other" for every delivery row.
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
    subtotal: env.subtotalAmount ?? null,
    tax: env.taxesAmount ?? null,
    discount: env.grandTotalDiscountAmount ?? null,
    fulfillmentType: pickFulfillment(env),
    paymentMethod: pickPaymentMethod(env),
    // Parse status independently: malformed unrelated optional fields must not
    // erase the cancellation signal and silently include the order.
    invoiceStatusName: invoiceStatusNameForIngest(row.raw),
    deliveryZip: pickDeliveryZip(env),
    cashierUserId: pickCashierUserId(env),
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

/** Postgres `date` columns come back through the pg driver as JS
 *  Date objects in our worker (no custom type parser is registered).
 *  This helper accepts either shape and returns the canonical
 *  "YYYY-MM-DD" string the rest of the worker assumes. */
function coerceCursorToIso(value: string | Date | null): string | null {
  if (value === null) return null
  if (typeof value === 'string') return value
  // Date objects from pg are "midnight UTC of the date" — formatting
  // back as YYYY-MM-DD via UTC components is correct.
  const y = value.getUTCFullYear()
  const m = value.getUTCMonth() + 1
  const d = value.getUTCDate()
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
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

  // ----- 1. Forward poll + settlement refresh -----
  // Re-fetch from whichever is EARLIER: the usual `highwater - OVERLAP`
  // cursor, or `now - SETTLEMENT_REFRESH`. The latter guarantees the
  // last 48h are always re-upserted so orders that settle from
  // Open/In-process to Paid (gaining their real revenue) converge even
  // though their payTime is long behind the highwater. The upsert path
  // makes the wider window idempotent.
  const now = new Date()
  const overlapFrom = state.highwaterPayTime.getTime() - FORWARD_POLL_OVERLAP_MS
  const settlementFrom = now.getTime() - SETTLEMENT_REFRESH_MS
  const fromUtc = new Date(Math.min(overlapFrom, settlementFrom))
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
      highwater_pay_time: string | Date
      min_pay_time: string | Date
      // pg returns `date` columns as JS Dates, not strings. We
      // coerce below so the rest of the code can treat the cursor
      // uniformly as a "YYYY-MM-DD" string.
      backfill_cursor_day: string | Date | null
    }>(
      `select highwater_pay_time, min_pay_time, backfill_cursor_day
         from sweed_orders_ingest_highwater
        where dealer_id = $1`,
      [dealerId],
    )
    if (existing.rows.length === 1) {
      const r = existing.rows[0]!
      return {
        highwaterPayTime: new Date(r.highwater_pay_time as string),
        minPayTime: new Date(r.min_pay_time as string),
        backfillCursorDay: coerceCursorToIso(r.backfill_cursor_day),
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

export const SWEED_ORDERS_UPSERT_CHANGE_PREDICATE_SQL = `
  sweed_orders.raw_json is distinct from excluded.raw_json
  or sweed_orders.invoice_status_name is distinct from excluded.invoice_status_name
`

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
  // ============================================================================
  // Bulk-upsert path (phase A3).
  //
  // The previous implementation looped per-invoice, doing one
  // SELECT EXISTS to compute `first_time_for_customer`, one
  // INSERT … ON CONFLICT DO NOTHING into `sweed_orders`, and (on
  // genuine insert) one INSERT … SELECT into
  // `sweed_order_items_flat`. For a multi-hundred-invoice batch
  // this was 3N round-trips per dealer poll.
  //
  // We now collapse the per-batch work into:
  //
  //   (1) one bulk INSERT into `sweed_orders` via
  //       `jsonb_to_recordset`, with `first_time_for_customer`
  //       computed set-based in the same CTE. RETURNING gives us
  //       the genuinely-inserted invoice_ids so the items flatten
  //       only touches those rows.
  //   (2) one bulk INSERT into `sweed_order_items_flat`, restricted
  //       to the just-inserted invoices, replicating the same
  //       cross-join-lateral / on-conflict-do-update statement we
  //       used per-row.
  //
  // Both statements run inside a single per-batch transaction.
  // Chunked at BULK_CHUNK_SIZE so the jsonb payload stays well
  // under pg's protocol limits.
  //
  // first_time_for_customer semantics, preserved exactly:
  //   * NULL for guest invoices (customer_id IS NULL).
  //   * Otherwise: true iff no prior `sweed_orders` row exists for
  //     this customer with `pay_time < this.pay_time`, AND no
  //     other invoice earlier in the same batch (by strict <)
  //     shares the customer. The original per-row loop relied on
  //     intra-transaction visibility for the batch-internal half;
  //     the CTE makes that explicit by checking `input` itself.
  //     Ties on pay_time (Sweed's second precision) make both
  //     siblings first_time=true under the original loop too
  //     (strict `<` matches neither), so the new behaviour is
  //     identical.
  // ============================================================================
  let totalInserted = 0
  for (let i = 0; i < normalised.length; i += BULK_CHUNK_SIZE) {
    const chunk = normalised.slice(i, i + BULK_CHUNK_SIZE)
    await withTransaction(async (db) => {
      const payload = chunk.map((n) => ({
        invoice_id: n.invoiceId,
        pay_time: n.payTime.toISOString(),
        customer_id: n.customerId,
        is_guest: n.isGuest,
        grand_total: n.grandTotal,
        subtotal: n.subtotal,
        tax: n.tax,
        discount: n.discount,
        fulfillment_type: n.fulfillmentType,
        payment_method: n.paymentMethod,
        invoice_status_name: n.invoiceStatusName,
        delivery_zip: n.deliveryZip,
        cashier_user_id: n.cashierUserId,
        raw: n.raw,
      }))
      const insertedResult = await db.query<{ invoice_id: string }>(
        `
          with input as (
            select * from jsonb_to_recordset($2::jsonb) as x(
              invoice_id       text,
              pay_time         timestamptz,
              customer_id      bigint,
              is_guest         boolean,
              grand_total      numeric,
              subtotal         numeric,
              tax              numeric,
              discount         numeric,
              fulfillment_type text,
              payment_method   text,
              invoice_status_name text,
              delivery_zip     text,
              cashier_user_id  bigint,
              raw              jsonb
            )
          ),
          input_with_first_time as (
            select
              i.*,
              case
                when i.customer_id is null then null::boolean
                else not (
                  exists (
                    select 1 from sweed_orders so
                     where so.customer_id = i.customer_id
                       and so.pay_time < i.pay_time
                  )
                  or exists (
                    select 1 from input i2
                     where i2.customer_id = i.customer_id
                       and i2.pay_time   < i.pay_time
                  )
                )
              end as first_time_for_customer
            from input i
          ),
          inserted as (
            insert into sweed_orders (
              dealer_id, invoice_id, pay_time, customer_id, is_guest,
              first_time_for_customer, grand_total_dollars, subtotal_dollars,
              tax_dollars, discount_dollars, fulfillment_type, payment_method,
              invoice_status_name, delivery_zip, cashier_user_id, raw_json
            )
            select
              $1::bigint,
              invoice_id,
              pay_time,
              customer_id,
              is_guest,
              first_time_for_customer,
              grand_total,
              subtotal,
              tax,
              discount,
              fulfillment_type,
              payment_method,
              invoice_status_name,
              delivery_zip,
              cashier_user_id,
              raw
            from input_with_first_time
            on conflict (dealer_id, invoice_id) do update set
              -- Refresh the financial / denormalised header fields +
              -- raw envelope so an order that has settled from
              -- Open/In-process to Paid (gaining real revenue) is
              -- corrected. We DO NOT touch first_time_for_customer
              -- (owned by the first sighting), delivery_zip /
              -- delivery_address_id / invoice_get_status /
              -- invoice_get_polled_at (owned by the address-enrichment
              -- job), pay_time (stable creation time; avoids
              -- business-day bucket drift), or ingested_at.
              customer_id         = excluded.customer_id,
              is_guest            = excluded.is_guest,
              grand_total_dollars = excluded.grand_total_dollars,
              subtotal_dollars    = excluded.subtotal_dollars,
              tax_dollars         = excluded.tax_dollars,
              discount_dollars    = excluded.discount_dollars,
              fulfillment_type    = excluded.fulfillment_type,
              payment_method      = excluded.payment_method,
              invoice_status_name = excluded.invoice_status_name,
              cashier_user_id     = excluded.cashier_user_id,
              raw_json            = excluded.raw_json
            -- Only actually write (and therefore RETURN, and therefore
            -- re-flatten) when the raw envelope changed or the typed status
            -- projection needs repair. Keeps the 48h settlement-refresh
            -- window from churning unchanged rows every tick while closing
            -- the migration-apply/deploy gap for status.
            where ${SWEED_ORDERS_UPSERT_CHANGE_PREDICATE_SQL}
            returning invoice_id
          )
          select invoice_id from inserted
        `,
        [dealerId, JSON.stringify(payload)],
      )
      const touchedInvoiceIds = insertedResult.rows.map((r) => r.invoice_id)
      totalInserted += touchedInvoiceIds.length
      if (touchedInvoiceIds.length === 0) {
        return
      }
      // (2) Items flatten — set-based over every TOUCHED (inserted or
      // updated) invoice. We DELETE the existing flat rows first so a
      // re-fetched order that lost a line (rare, but possible) can't
      // leave a stale higher-ordinal row behind, then re-INSERT from
      // the fresh raw_json. We restrict via `invoice_id = ANY($2)` so
      // the planner uses the (dealer_id, invoice_id) PK / index.
      await db.query(
        `delete from sweed_order_items_flat
          where dealer_id = $1 and invoice_id = any($2::text[])`,
        [dealerId, touchedInvoiceIds],
      )
      await db.query(
        `
          insert into sweed_order_items_flat (
            dealer_id, invoice_id, item_ordinal,
            pay_time, inventory_item_id, qty, revenue, raw_item,
            product_id, product_category_name
          )
          select
            so.dealer_id,
            so.invoice_id,
            (item.ord - 1)::int as item_ordinal,
            so.pay_time,
            item.value->>'inventoryItemId' as inventory_item_id,
            coalesce(
              nullif(item.value->>'currentQty', '')::numeric,
              nullif(item.value->>'quantity', '')::numeric,
              nullif(item.value->>'qty', '')::numeric,
              0
            ) as qty,
            coalesce(nullif(item.value->>'subtotalAmount', '')::numeric, 0) as revenue,
            item.value as raw_item,
            -- D1: typed projections. product id lives at
            -- item.product.id (NOT item.productId, which does not
            -- exist); guarded cast so a non-numeric surprise never
            -- fails ingest. Use [0-9] NOT \d: this is a JS template
            -- literal, where \d silently collapses to a bare 'd' (so
            -- '^\d+$' would reach Postgres as '^d+$' and match nothing,
            -- leaving product_id null on every ingested line — the
            -- original 060 bug that this fixes). The migration .sql
            -- files are fine with \d because they are not JS strings.
            case
              when nullif(item.value #>> '{product,id}', '') ~ '^[0-9]+$'
                then (item.value #>> '{product,id}')::bigint
              else null
            end as product_id,
            nullif(item.value #>> '{productCategory,name}', '') as product_category_name
          from sweed_orders so
          cross join lateral jsonb_array_elements(coalesce(so.raw_json->'items', '[]'::jsonb))
            with ordinality as item(value, ord)
          where so.dealer_id = $1
            and so.invoice_id = any($2::text[])
            and nullif(item.value->>'inventoryItemId', '') is not null
          on conflict (dealer_id, invoice_id, item_ordinal) do update set
            pay_time              = excluded.pay_time,
            inventory_item_id     = excluded.inventory_item_id,
            qty                   = excluded.qty,
            revenue               = excluded.revenue,
            raw_item              = excluded.raw_item,
            product_id            = excluded.product_id,
            product_category_name = excluded.product_category_name,
            flattened_at          = now()
        `,
        [dealerId, touchedInvoiceIds],
      )
      // (3) Invoice-margin rollup — recompute the just-(re)flattened
      // invoices in analytics_invoice_margin_facts (migration 085). This
      // is where we pay the expensive sweed_package_cost_as_of_or_earliest()
      // lookups ONCE, so the CRM Segment Analysis read path can join
      // precomputed margin instead of calling the cost function per line.
      // Margin convention is identical to the margins.gross_margin_dollars
      // registry metric (REVENUE_EXPR / QTY_EXPR / COGS_EXPR /
      // NON_CANCELED_LINE_SQL in sweedPackageSnapshotsQueries.ts) — keep
      // these expressions in lock-step. Set-based over the touched
      // invoices; idempotent via the PK upsert.
      await db.query(
        `
          insert into analytics_invoice_margin_facts as aimf
            (dealer_id, invoice_id, pay_time, line_count,
             revenue_dollars, cogs_dollars, margin_dollars, refreshed_at)
          select
            f.dealer_id,
            f.invoice_id,
            max(f.pay_time) as pay_time,
            count(*)::int as line_count,
            coalesce(sum(
              case when lower(coalesce(f.raw_item->'invoiceItemStatus'->>'name', '')) <> 'canceled'
                   then f.revenue else 0 end
            ), 0)::numeric as revenue_dollars,
            coalesce(sum(
              (case when lower(coalesce(f.raw_item->'invoiceItemStatus'->>'name', '')) <> 'canceled'
                    then f.qty else 0 end)
              * coalesce(sweed_package_cost_as_of_or_earliest(f.dealer_id, f.inventory_item_id, f.pay_time), 0)
            ), 0)::numeric as cogs_dollars,
            coalesce(sum(
              (case when lower(coalesce(f.raw_item->'invoiceItemStatus'->>'name', '')) <> 'canceled'
                    then f.revenue else 0 end)
              - (case when lower(coalesce(f.raw_item->'invoiceItemStatus'->>'name', '')) <> 'canceled'
                      then f.qty else 0 end)
                * coalesce(sweed_package_cost_as_of_or_earliest(f.dealer_id, f.inventory_item_id, f.pay_time), 0)
            ), 0)::numeric as margin_dollars,
            now()
          from sweed_order_items_flat f
          where f.dealer_id = $1 and f.invoice_id = any($2::text[])
          group by f.dealer_id, f.invoice_id
          on conflict (dealer_id, invoice_id) do update set
            pay_time        = excluded.pay_time,
            line_count      = excluded.line_count,
            revenue_dollars = excluded.revenue_dollars,
            cogs_dollars    = excluded.cogs_dollars,
            margin_dollars  = excluded.margin_dollars,
            refreshed_at    = excluded.refreshed_at
        `,
        [dealerId, touchedInvoiceIds],
      )
    })
  }
  return { normalised, insertedCount: totalInserted }
}
