import { z } from 'zod'

import { callSweedRpc } from './rpc.js'
import { parseSweedDate } from './sales.js'

// =====================================================================
// `store.sale.shift.list` wrapper — historical Sweed cashier /
// employee shifts (clock-in / clock-out events per role per dealer).
//
// Operator-confirmed RPC envelope (2026-05-26, FreshlyBakedNYC/
// automation#27):
//
//   { name: 'store.sale.shift.list',
//     params: { fromDate: "2026-04-26T00:00:00-04:00",
//               toDate:   "2026-05-26T23:59:59-04:00",
//               page: 1, pageSize: 50 } }
//
// `fromDate` / `toDate` are ET ISO-8601. The wrapper accepts JS
// `Date` instants and serialises them as the equivalent UTC ISO
// (Z-suffixed). Sweed has been observed to accept either form in
// the sibling `store.sale.invoice.list` call; if the shift variant
// is stricter about ET-vs-Z we'll see it in early staging runs and
// can swap to ET formatting here without a contract change.
//
// Per-row schema (defensive — we passthrough everything via Zod so
// the worker can keep `raw` for re-derivation):
//
//   {
//     id: "9831" | 9831,                  // shift id
//     dealerId: 210249,
//     user: { id: "1402", name: "Jane D", firstName: "Jane",
//             lastName: "D" },            // or `cashier`, `employee`
//     role: { id: 7, name: "Cashier" } | "Cashier",
//     openTime:  "2026-05-26T13:00:00Z",  // canonical clock-in
//     closeTime: "2026-05-26T21:00:00Z",  // null while open
//     ...
//   }
//
// The exact field names on the Sweed envelope have NOT been spelled
// out to us; we accept several common shapes (`user` / `employee` /
// `cashier`; `openTime` / `startTime`; `closeTime` / `endTime` /
// `finishTime`) and the worker logs any row we cannot normalise so
// the operator can paste a sample envelope and we'll tighten the
// schema in a follow-up.
// =====================================================================

export const SWEED_RPC_SALE_SHIFT_LIST = 'store.sale.shift.list'

const NameOnlySchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    name: z.string().nullable().optional(),
  })
  .passthrough()

const EmployeeBlockSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    name: z.string().nullable().optional(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    role: z.union([z.string(), NameOnlySchema]).nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional()

const ShiftRowSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    dealerId: z.coerce.number().int().nullable().optional(),

    // The employee/cashier block can land under several names.
    user: EmployeeBlockSchema,
    employee: EmployeeBlockSchema,
    cashier: EmployeeBlockSchema,

    // Role can be a top-level field or live inside the employee
    // block. Free string or { name } object.
    role: z.union([z.string(), NameOnlySchema]).nullable().optional(),

    // Time field aliases.
    openTime: z.string().nullable().optional(),
    startTime: z.string().nullable().optional(),
    shiftOpenTime: z.string().nullable().optional(),

    closeTime: z.string().nullable().optional(),
    endTime: z.string().nullable().optional(),
    finishTime: z.string().nullable().optional(),
    shiftCloseTime: z.string().nullable().optional(),
  })
  .passthrough()

const ShiftListResponseSchema = z
  .object({
    data: z.array(ShiftRowSchema).optional().default([]),
    totalCount: z.coerce.number().int().nullable().optional(),
  })
  .passthrough()

export interface SweedShiftRow {
  shiftId: string | null
  employeeId: number | null
  employeeName: string | null
  role: string | null
  openTime: Date | null
  closeTime: Date | null
  raw: unknown
}

function pickEmployee(
  raw: z.infer<typeof ShiftRowSchema>,
): z.infer<typeof EmployeeBlockSchema> {
  return raw.user ?? raw.employee ?? raw.cashier ?? null
}

function pickRole(raw: z.infer<typeof ShiftRowSchema>): string | null {
  const candidates: Array<string | z.infer<typeof NameOnlySchema> | null | undefined> = [
    raw.role,
    pickEmployee(raw)?.role,
  ]
  for (const c of candidates) {
    if (typeof c === 'string') {
      const trimmed = c.trim()
      if (trimmed.length > 0) return trimmed
      continue
    }
    if (c && typeof c === 'object') {
      const n = c.name
      if (typeof n === 'string' && n.trim().length > 0) return n.trim()
    }
  }
  return null
}

function pickEmployeeId(raw: z.infer<typeof ShiftRowSchema>): number | null {
  const block = pickEmployee(raw)
  if (!block) return null
  const id = block.id
  if (typeof id === 'number' && Number.isFinite(id)) return id
  if (typeof id === 'string') {
    const n = Number(id)
    if (Number.isFinite(n)) return n
  }
  return null
}

function pickEmployeeName(raw: z.infer<typeof ShiftRowSchema>): string | null {
  const block = pickEmployee(raw)
  if (!block) return null
  if (typeof block.name === 'string' && block.name.trim().length > 0) {
    return block.name.trim()
  }
  const first = typeof block.firstName === 'string' ? block.firstName.trim() : ''
  const last = typeof block.lastName === 'string' ? block.lastName.trim() : ''
  const combined = `${first} ${last}`.trim()
  return combined.length > 0 ? combined : null
}

function pickOpenTime(raw: z.infer<typeof ShiftRowSchema>): Date | null {
  return (
    parseSweedDate(raw.openTime ?? null) ??
    parseSweedDate(raw.startTime ?? null) ??
    parseSweedDate(raw.shiftOpenTime ?? null)
  )
}

function pickCloseTime(raw: z.infer<typeof ShiftRowSchema>): Date | null {
  return (
    parseSweedDate(raw.closeTime ?? null) ??
    parseSweedDate(raw.endTime ?? null) ??
    parseSweedDate(raw.finishTime ?? null) ??
    parseSweedDate(raw.shiftCloseTime ?? null)
  )
}

function normalizeShift(raw: z.infer<typeof ShiftRowSchema>): SweedShiftRow {
  return {
    shiftId: raw.id !== undefined && raw.id !== null ? String(raw.id) : null,
    employeeId: pickEmployeeId(raw),
    employeeName: pickEmployeeName(raw),
    role: pickRole(raw),
    openTime: pickOpenTime(raw),
    closeTime: pickCloseTime(raw),
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
 * List Sweed shifts for a dealer in a time window. Caller is
 * expected to be inside a `withSweedSession` block.
 */
export async function listSaleShifts(args: {
  dealerId: number
  fromDate: Date
  toDate: Date
  pageSize?: number
}): Promise<SweedShiftRow[]> {
  const pageSize = Math.min(
    args.pageSize ?? MAX_SWEED_SHIFT_PAGE_SIZE,
    MAX_SWEED_SHIFT_PAGE_SIZE,
  )
  const collected: SweedShiftRow[] = []
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
    for (const r of rows) collected.push(normalizeShift(r))
    if (rows.length < pageSize) break // last page
    page += 1
  }
  return collected
}
