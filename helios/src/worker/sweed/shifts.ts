import { z } from 'zod'

import { callSweedRpc } from './rpc.js'
import { parseSweedDate } from './sales.js'

// =====================================================================
// `store.sale.shift.list` wrapper — historical Sweed DRAWER /
// hardware-till shifts (NOT per-employee shifts; see the comment on
// `sweedDrawerShifts.sql` and the operator-confirmed Option A
// redesign on FreshlyBakedNYC/automation#27, 2026-05-26).
//
// Operator-confirmed RPC envelope:
//
//   { name: 'store.sale.shift.list',
//     params: { fromDate: "2026-04-26T00:00:00-04:00",
//               toDate:   "2026-05-26T23:59:59-04:00",
//               page: 1, pageSize: 50 } }
//
// `fromDate` / `toDate` are ET ISO-8601. The wrapper accepts JS
// `Date` instants and serialises them as UTC ISO (Z-suffixed); the
// sibling `store.sale.invoice.list` accepts either form and the
// shift call has done so in observation.
//
// Per-row schema (defensive — passthrough so the worker can keep
// `raw` for re-derivation of fields we did not normalise):
//
//   {
//     id: "9831" | 9831,                  // drawer-shift id
//     shiftNo: 14,
//     dealerShift: true,
//     dealerId: 210249,
//     storeId: 4011,
//     openDate:  "2026-05-26T13:00:00Z",
//     closeDate: "2026-05-26T21:00:00Z" | null,
//     openShiftCash, expectedCash, salesCount, actualCash,
//     confirmedCash, hardware: { id, name } | null,
//     closeUser:   { id, name } | null,
//     confirmUser: { id, name } | null,
//     sessions: [
//       { id, user: { id, name }, expectedSessionCash, ... }
//     ],
//     cashDistributions: [...]
//   }
// =====================================================================

export const SWEED_RPC_SALE_SHIFT_LIST = 'store.sale.shift.list'

const IdLike = z.union([z.string(), z.number()])

const UserBlockSchema = z
  .object({
    id: IdLike.nullable().optional(),
    name: z.string().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional()

const HardwareBlockSchema = z
  .object({
    id: IdLike.nullable().optional(),
    name: z.string().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional()

const SessionRowSchema = z
  .object({
    id: IdLike.optional(),
    user: UserBlockSchema,
    expectedSessionCash: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough()

const DrawerShiftRowSchema = z
  .object({
    id: IdLike.optional(),
    shiftNo: z.coerce.number().int().nullable().optional(),
    dealerId: z.coerce.number().int().nullable().optional(),
    hardware: HardwareBlockSchema,
    openDate: z.string().nullable().optional(),
    closeDate: z.string().nullable().optional(),
    salesCount: z.coerce.number().int().nullable().optional(),
    closeUser: UserBlockSchema,
    sessions: z.array(SessionRowSchema).optional().default([]),
  })
  .passthrough()

const ShiftListResponseSchema = z
  .object({
    data: z.array(DrawerShiftRowSchema).optional().default([]),
    totalCount: z.coerce.number().int().nullable().optional(),
  })
  .passthrough()

export interface SweedDrawerSessionRow {
  sessionId: string
  userId: number
  userName: string | null
  expectedSessionCash: number | null
  raw: unknown
}

export interface SweedDrawerShiftRow {
  shiftId: string | null
  shiftNo: number | null
  dealerId: number | null
  hardwareId: number | null
  hardwareName: string | null
  openDate: Date | null
  closeDate: Date | null
  salesCount: number | null
  closeUserId: number | null
  closeUserName: string | null
  sessions: SweedDrawerSessionRow[]
  raw: unknown
}

function coerceId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function coerceName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function coerceMoney(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function normaliseSession(raw: z.infer<typeof SessionRowSchema>): SweedDrawerSessionRow | null {
  const sessionId = raw.id !== undefined && raw.id !== null ? String(raw.id) : null
  const userId = coerceId(raw.user?.id ?? null)
  if (sessionId === null || userId === null) return null
  return {
    sessionId,
    userId,
    userName: coerceName(raw.user?.name ?? null),
    expectedSessionCash: coerceMoney(raw.expectedSessionCash ?? null),
    raw,
  }
}

function normaliseDrawerShift(raw: z.infer<typeof DrawerShiftRowSchema>): SweedDrawerShiftRow {
  const sessions: SweedDrawerSessionRow[] = []
  for (const s of raw.sessions ?? []) {
    const n = normaliseSession(s)
    if (n !== null) sessions.push(n)
  }
  return {
    shiftId: raw.id !== undefined && raw.id !== null ? String(raw.id) : null,
    shiftNo: raw.shiftNo ?? null,
    dealerId: raw.dealerId ?? null,
    hardwareId: coerceId(raw.hardware?.id ?? null),
    hardwareName: coerceName(raw.hardware?.name ?? null),
    openDate: parseSweedDate(raw.openDate ?? null),
    closeDate: parseSweedDate(raw.closeDate ?? null),
    salesCount: raw.salesCount ?? null,
    closeUserId: coerceId(raw.closeUser?.id ?? null),
    closeUserName: coerceName(raw.closeUser?.name ?? null),
    sessions,
    raw,
  }
}

// Page-size cap mirrors `store.sale.invoice.list` (operator-confirmed
// 50 is safe; values > 50 have been observed to fail). Total cap per
// call is a defensive ceiling so an accidentally huge window can't
// paginate forever.
const MAX_SWEED_SHIFT_PAGE_SIZE = 50
const MAX_SHIFTS_PER_LIST = 1000

/**
 * List Sweed drawer shifts for a dealer in a time window. Caller is
 * expected to be inside a `withSweedSession` block.
 */
export async function listSaleShifts(args: {
  dealerId: number
  fromDate: Date
  toDate: Date
  pageSize?: number
}): Promise<SweedDrawerShiftRow[]> {
  const pageSize = Math.min(
    args.pageSize ?? MAX_SWEED_SHIFT_PAGE_SIZE,
    MAX_SWEED_SHIFT_PAGE_SIZE,
  )
  const collected: SweedDrawerShiftRow[] = []
  let page = 1
  while (collected.length < MAX_SHIFTS_PER_LIST) {
    const raw = await callSweedRpc<unknown>(args.dealerId, SWEED_RPC_SALE_SHIFT_LIST, {
      page,
      pageSize,
      fromDate: args.fromDate.toISOString(),
      toDate: args.toDate.toISOString(),
    })
    const parsed = ShiftListResponseSchema.safeParse(raw)
    if (!parsed.success) break
    const rows = parsed.data.data ?? []
    for (const r of rows) collected.push(normaliseDrawerShift(r))
    if (rows.length < pageSize) break // last page
    page += 1
  }
  return collected
}
