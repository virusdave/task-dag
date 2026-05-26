import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  HELIOS_SWEED_DEALER_OPENING_DATES,
  type ConfigWorkersSweedShiftsIngestJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import { listSaleShifts, type SweedShiftRow } from '../sweed/shifts.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// ============================================================================
// Sweed shifts ingest worker (FreshlyBakedNYC/automation#27, follow-on under
// #22 and remaining blocker for the cashier-throughput stub in #21's P5).
//
// One job per scheduler tick. For each dealer we:
//
//   1. **Forward poll** — fetch shifts from `highwater - OVERLAP` to
//      `now`, upsert into `sweed_shifts`. Re-upsert is harmless and
//      is what lets the eventual `closeTime` land on rows we first
//      ingested while they were still open.
//   2. **Backfill one or more days** — if `backfill_cursor_day` is
//      non-null, fetch that day's shifts, upsert, decrement cursor.
//      Stops when the cursor reaches the dealer's store-opening
//      date (`min_open_time`).
//
// The `OVERLAP` window covers the same failure modes as the sibling
// orders ingest (#22): mid-tick crashes plus clock-in / clock-out
// updates that land between two adjacent polls (most importantly,
// the close-time update on a shift that was open during the
// previous poll). Idempotent upsert + the overlap window mean the
// "no row lost" invariant holds even across worker restarts.
// ============================================================================

/** Forward-poll overlap window. */
const FORWARD_POLL_OVERLAP_MS = 30 * 60 * 1000

const NY_TZ = 'America/New_York'

// ----- ET-day boundary helpers (kept private; identical to the
// orders ingest helpers — duplicating < 30 lines of timezone math
// is cheaper than the cross-module dependency it would introduce
// and lets both workers evolve their date semantics independently
// if Sweed ever changes a date contract on one RPC family but not
// the other) -----

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

function nyDayStartUtc(isoDate: string): Date {
  const [yStr, mStr, dStr] = isoDate.split('-')
  const y = Number(yStr)
  const m = Number(mStr)
  const d = Number(dStr)
  const approxUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0)
  const approx = new Date(approxUtcMs)
  const off = offsetMsAt(approx)
  return new Date(approxUtcMs - off)
}

function nyDateString(d: Date): string {
  const { y, m, day } = partsInNY(d)
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

function decrementIsoDate(iso: string): string {
  const [yStr, mStr, dStr] = iso.split('-')
  const t = Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr)) - 24 * 60 * 60 * 1000
  const d = new Date(t)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

interface NormalisedShift {
  shiftId: string
  employeeId: number
  employeeName: string | null
  role: string
  openTime: Date
  closeTime: Date | null
  raw: unknown
}

function normaliseForIngest(row: SweedShiftRow): NormalisedShift | null {
  if (
    row.shiftId === null ||
    row.employeeId === null ||
    row.openTime === null ||
    row.role === null ||
    row.role.length === 0
  ) {
    return null
  }
  return {
    shiftId: row.shiftId,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    role: row.role,
    openTime: row.openTime,
    closeTime: row.closeTime,
    raw: row.raw,
  }
}

// ----- Job entry point -----

export async function runConfigWorkersSweedShiftsIngestJob(
  context: JobHandlerContext,
  payload: ConfigWorkersSweedShiftsIngestJobPayload,
): Promise<void> {
  const candidates =
    payload.siteDealerIds.length > 0
      ? payload.siteDealerIds
      : HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => d.dealerId)
  const dealerIds = [...new Set(candidates)]

  const perDealer: Array<{
    dealerId: number
    forwardSeen: number
    forwardUpserted: number
    backfillDays: number
    backfillUpserted: number
    backfillCursorRemaining: string | null
    skippedNotShiftShaped: number
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
        backfillDays: 0,
        backfillUpserted: 0,
        backfillCursorRemaining: null,
        skippedNotShiftShaped: 0,
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
      eventType: 'config.workers.sweed_shifts_ingest.completed',
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
  backfillDays: number
  backfillUpserted: number
  backfillCursorRemaining: string | null
  skippedNotShiftShaped: number
}

async function ingestDealer(dealerId: number, requestedBackfillDays: number): Promise<DealerResult> {
  const state = await ensureHighwaterRow(dealerId)

  // ----- 1. Forward poll -----
  const now = new Date()
  const fromUtc = new Date(state.highwaterOpenTime.getTime() - FORWARD_POLL_OVERLAP_MS)
  const forward = await fetchAndUpsert(dealerId, fromUtc, now)
  let newHighwater = state.highwaterOpenTime
  for (const sh of forward.normalised) {
    if (sh.openTime > newHighwater) newHighwater = sh.openTime
  }

  // ----- 2. Backfill -----
  let backfillCursor = state.backfillCursorDay
  let backfillDaysDone = 0
  let backfillUpserted = 0
  let backfillSkipped = 0
  for (let i = 0; i < requestedBackfillDays && backfillCursor !== null; i++) {
    const dayStart = nyDayStartUtc(backfillCursor)
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
    const day = await fetchAndUpsert(dealerId, dayStart, dayEnd)
    backfillUpserted += day.upsertedCount
    backfillSkipped += day.skippedCount
    backfillDaysDone++

    const prev = decrementIsoDate(backfillCursor)
    const prevStart = nyDayStartUtc(prev)
    if (prevStart < state.minOpenTime) {
      backfillCursor = null
    } else {
      backfillCursor = prev
    }
  }

  // ----- 3. Persist cursor + highwater + counters -----
  await withTransaction(async (db) => {
    await db.query(
      `
        update sweed_shifts_ingest_highwater
           set highwater_open_time = greatest(highwater_open_time, $2),
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
        forward.upsertedCount,
        backfillUpserted,
      ],
    )
  })

  return {
    forwardSeen: forward.normalised.length,
    forwardUpserted: forward.upsertedCount,
    backfillDays: backfillDaysDone,
    backfillUpserted,
    backfillCursorRemaining: backfillCursor,
    skippedNotShiftShaped: forward.skippedCount + backfillSkipped,
  }
}

interface HighwaterState {
  highwaterOpenTime: Date
  minOpenTime: Date
  backfillCursorDay: string | null
}

async function ensureHighwaterRow(dealerId: number): Promise<HighwaterState> {
  return withTransaction(async (db) => {
    const existing = await db.query<{
      highwater_open_time: string | Date
      min_open_time: string | Date
      backfill_cursor_day: string | Date | null
    }>(
      `select highwater_open_time, min_open_time, backfill_cursor_day
         from sweed_shifts_ingest_highwater
        where dealer_id = $1`,
      [dealerId],
    )
    if (existing.rows.length === 1) {
      const r = existing.rows[0]!
      return {
        highwaterOpenTime: new Date(r.highwater_open_time as string),
        minOpenTime: new Date(r.min_open_time as string),
        backfillCursorDay: coerceCursorToIso(r.backfill_cursor_day),
      }
    }
    const openingIso = HELIOS_SWEED_DEALER_OPENING_DATES[dealerId]
    const minOpenTime = openingIso ? nyDayStartUtc(openingIso) : new Date(Date.now() - 60 * 60 * 1000)
    // Seed highwater 1h in the past so the first forward poll picks
    // up shifts from the last hour while the backfill walks history.
    const highwater = new Date(Date.now() - 60 * 60 * 1000)
    const todayIso = nyDateString(new Date())
    const initialCursor = openingIso ? decrementIsoDate(todayIso) : null
    await db.query(
      `
        insert into sweed_shifts_ingest_highwater
          (dealer_id, highwater_open_time, min_open_time, backfill_cursor_day, notes)
        values ($1, $2, $3, $4, $5)
        on conflict (dealer_id) do nothing
      `,
      [
        dealerId,
        highwater.toISOString(),
        minOpenTime.toISOString(),
        initialCursor,
        `Seeded by shifts ingest worker; opening=${openingIso ?? 'unknown'}`,
      ],
    )
    return {
      highwaterOpenTime: highwater,
      minOpenTime,
      backfillCursorDay: initialCursor,
    }
  })
}

interface FetchAndUpsertResult {
  normalised: NormalisedShift[]
  upsertedCount: number
  skippedCount: number
}

async function fetchAndUpsert(
  dealerId: number,
  fromDate: Date,
  toDate: Date,
): Promise<FetchAndUpsertResult> {
  const rows = await listSaleShifts({ dealerId, fromDate, toDate })
  const normalised: NormalisedShift[] = []
  let skipped = 0
  for (const r of rows) {
    const n = normaliseForIngest(r)
    if (n === null) {
      skipped++
      continue
    }
    normalised.push(n)
  }
  if (normalised.length === 0) {
    return { normalised, upsertedCount: 0, skippedCount: skipped }
  }
  const upsertedCount = await withTransaction(async (db) => {
    let upserted = 0
    for (const n of normalised) {
      // Upsert: on conflict update the mutable fields (close time,
      // employee name, role, raw_json). We deliberately do NOT update
      // `shift_open` — that field is immutable once first seen, and
      // any later poll that "moves" it would be a Sweed-side data
      // correction we'd want to investigate manually.
      const result = await db.query(
        `
          insert into sweed_shifts (
            dealer_id, shift_id, employee_id, employee_name,
            role, shift_open, shift_close, raw_json
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb
          )
          on conflict (dealer_id, shift_id) do update set
            employee_name = excluded.employee_name,
            role = excluded.role,
            shift_close = excluded.shift_close,
            raw_json = excluded.raw_json,
            ingested_at = now()
        `,
        [
          dealerId,
          n.shiftId,
          n.employeeId,
          n.employeeName,
          n.role,
          n.openTime.toISOString(),
          n.closeTime?.toISOString() ?? null,
          JSON.stringify(n.raw),
        ],
      )
      if ((result.rowCount ?? 0) > 0) upserted++
    }
    return upserted
  })
  return { normalised, upsertedCount, skippedCount: skipped }
}
