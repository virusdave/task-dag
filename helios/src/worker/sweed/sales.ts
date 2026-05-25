import { z } from 'zod'

import { callSweedRpc } from './rpc.js'

// =====================================================================
// Customer-Sentiment Capture — `store.sale.invoice.list` wrapper.
//
// Used by the contact-less review-submission "candidate purchases"
// surface: when a customer submits a review with no phone / email,
// we look up the few retail invoices the dealer rang up in the
// minutes around the submission timestamp and surface them as
// candidate contacts the operator can attach + add to a segment.
//
// RPC envelope (operator-supplied):
//
//   { auth: <token>, name: 'store.sale.invoice.list', id: <uuid>,
//     params: { page, pageSize, fromDate: ISO, toDate: ISO } }
//
// Both `fromDate` and `toDate` are interpreted as UTC instants when
// Z-suffixed (confirmed against live Sweed staging on 2026-05-25);
// the typical "give me one ET-day of sales" call therefore sends
// the UTC instants that bracket that ET day. The submission times
// helios stores in review_submissions.created_at are already
// timestamptz, so we just send their UTC ISO directly.
//
// Per-row schema confirmed against live Sweed staging (see
// scripts probe history): each invoice carries
//
//   {
//     id: "6431136",                     // invoice id (string)
//     dealerId: 210705,                  // pinned dealer
//     customer: {                        // null/absent for guests
//       isGuest: boolean,
//       id: "6236464",                   // sweed client id
//       name: "VANESSA BAEZ",            // full name
//       firstName: "VANESSA",
//       lastName: <not always present>,
//     },
//     payTime: "2026-05-25T16:01:12Z",   // ticket-paid moment, UTC
//     statusTime: "2026-05-25T16:01:12Z",
//     createTime: "2026-05-25T16:05:54Z",
//     grandTotalAmount: 18.5,
//     totalAmount: 18.5,
//     ...
//   }
//
// Phone / email are NOT returned by store.sale.invoice.list;
// surfacing them would require a follow-up RPC per candidate. For
// now the candidate surface shows name + client-id only, which is
// enough for the operator to recognise the customer and for the
// segment-add path (which only needs the client id).
// =====================================================================

export const SWEED_RPC_SALE_INVOICE_LIST = 'store.sale.invoice.list'

// Process-wide timezone constant used to defensively interpret any
// date string Sweed hands us that lacks a Z suffix or explicit
// offset. Today's live responses are Z-suffixed; this fallback is
// defence-in-depth in case a different RPC variant ever returns
// naive strings.
const NY_TZ = 'America/New_York'

const CustomerSchema = z
  .object({
    isGuest: z.boolean().optional(),
    id: z.union([z.string(), z.number()]).nullable().optional(),
    name: z.string().nullable().optional(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    // Phone / email aren't returned by the list call today, but if
    // a future Sweed version starts emitting them we'll happily
    // surface them.
    phone: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional()

const InvoiceRowSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    dealerId: z.coerce.number().int().nullable().optional(),
    customer: CustomerSchema,
    // Sale-time candidate fields in preference order: payTime (when
    // the ticket actually closed), statusTime (status transition
    // moment, usually equal to payTime for paid invoices), and
    // createTime (ticket opened). We use the first non-null.
    payTime: z.string().nullable().optional(),
    statusTime: z.string().nullable().optional(),
    createTime: z.string().nullable().optional(),
    grandTotalAmount: z.coerce.number().nullable().optional(),
    totalAmount: z.coerce.number().nullable().optional(),
  })
  .passthrough()

const InvoiceListResponseSchema = z
  .object({
    data: z.array(InvoiceRowSchema).optional().default([]),
    totalCount: z.coerce.number().int().nullable().optional(),
  })
  .passthrough()

export interface SweedInvoiceRow {
  invoiceId: string | null
  saleTime: Date | null
  total: number | null
  clientId: number | null
  clientName: string | null
  clientPhone: string | null
  clientEmail: string | null
  raw: unknown
}

// ----- timezone-safe date parsing -----
//
// If the input string carries a Z suffix or an explicit ±HH:MM
// offset, plain `new Date(string)` returns the correct UTC instant.
// If it doesn't (a "naive" timestamp like "2026-05-25T12:01:12"),
// `new Date(string)` interprets it in the JS runtime's local zone,
// which on our helios server is UTC — so a 12:01 PM ET sale would
// land 4-5 hours in the future. We defensively re-interpret naive
// strings as NY-local time before converting to UTC.

const TZ_AWARE_SUFFIX = /(Z|[+\-]\d{2}:?\d{2})$/

function offsetMillisAt(instantUtc: Date): number {
  // Compute the America/New_York offset (in ms east of UTC) for a
  // given absolute instant. EDT in summer = -4h, EST in winter = -5h.
  // Uses Intl to avoid pulling in a tz database dependency.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instantUtc)
  const partMap: Record<string, string> = {}
  for (const p of parts) partMap[p.type] = p.value
  const asIfUtc = Date.UTC(
    Number(partMap.year),
    Number(partMap.month) - 1,
    Number(partMap.day),
    Number(partMap.hour === '24' ? '00' : partMap.hour),
    Number(partMap.minute),
    Number(partMap.second),
  )
  return asIfUtc - instantUtc.getTime()
}

export function parseSweedDate(raw: string | null | undefined): Date | null {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (TZ_AWARE_SUFFIX.test(trimmed)) {
    const d = new Date(trimmed)
    return Number.isNaN(d.getTime()) ? null : d
  }
  // Naive string — treat as NY local. Build a UTC Date with the
  // same y/m/d/h/m/s, then subtract the NY offset at that instant.
  const utcInterpretation = new Date(`${trimmed}Z`)
  if (Number.isNaN(utcInterpretation.getTime())) return null
  const offsetMs = offsetMillisAt(utcInterpretation)
  return new Date(utcInterpretation.getTime() - offsetMs)
}

function pickSaleTime(raw: z.infer<typeof InvoiceRowSchema>): Date | null {
  return (
    parseSweedDate(raw.payTime ?? null) ??
    parseSweedDate(raw.statusTime ?? null) ??
    parseSweedDate(raw.createTime ?? null)
  )
}

function pickClientName(c: z.infer<typeof CustomerSchema>): string | null {
  if (c === null || c === undefined) return null
  if (typeof c.name === 'string' && c.name.trim().length > 0) return c.name.trim()
  const first = typeof c.firstName === 'string' ? c.firstName.trim() : ''
  const last = typeof c.lastName === 'string' ? c.lastName.trim() : ''
  const combined = `${first} ${last}`.trim()
  return combined.length > 0 ? combined : null
}

function pickClientId(c: z.infer<typeof CustomerSchema>): number | null {
  if (c === null || c === undefined) return null
  if (c.isGuest === true) return null
  const id = c.id
  if (typeof id === 'number' && Number.isFinite(id)) return id
  if (typeof id === 'string') {
    const n = Number(id)
    if (Number.isFinite(n)) return n
  }
  return null
}

function normalizeInvoice(raw: z.infer<typeof InvoiceRowSchema>): SweedInvoiceRow {
  const c = raw.customer ?? null
  const total = raw.grandTotalAmount ?? raw.totalAmount ?? null
  return {
    invoiceId: raw.id !== undefined && raw.id !== null ? String(raw.id) : null,
    saleTime: pickSaleTime(raw),
    total: typeof total === 'number' && Number.isFinite(total) ? total : null,
    clientId: pickClientId(c),
    clientName: pickClientName(c),
    clientPhone:
      c !== null && c !== undefined && typeof c.phone === 'string' ? c.phone : null,
    clientEmail:
      c !== null && c !== undefined && typeof c.email === 'string' ? c.email : null,
    raw,
  }
}

// Sweed rejects oversized page sizes with 'Maximum page size
// exceeded'. The operator-confirmed safe size on
// store.sale.invoice.list is 50, which matches their canonical
// example RPC; values up to 100 have been observed to fail in
// practice, so we stay at 50.
const MAX_SWEED_INVOICE_PAGE_SIZE = 50
// Hard cap on rows fetched per dealer per call, so an accidentally
// huge time window can't paginate forever.
const MAX_INVOICES_PER_LIST = 1000

/**
 * List retail invoices for a dealer in a time window. The caller is
 * expected to be inside a `withSweedSession` block.
 *
 * Paginates internally up to `MAX_INVOICES_PER_LIST` rows total to
 * cover union windows across many submissions; each page request
 * respects Sweed's `pageSize` cap.
 */
export async function listSaleInvoices(args: {
  dealerId: number
  fromDate: Date
  toDate: Date
  pageSize?: number
}): Promise<SweedInvoiceRow[]> {
  const pageSize = Math.min(
    args.pageSize ?? MAX_SWEED_INVOICE_PAGE_SIZE,
    MAX_SWEED_INVOICE_PAGE_SIZE,
  )
  const collected: SweedInvoiceRow[] = []
  let page = 1
  while (collected.length < MAX_INVOICES_PER_LIST) {
    const raw = await callSweedRpc<unknown>(args.dealerId, SWEED_RPC_SALE_INVOICE_LIST, {
      page,
      pageSize,
      fromDate: args.fromDate.toISOString(),
      toDate: args.toDate.toISOString(),
    })
    const parsed = InvoiceListResponseSchema.safeParse(raw)
    if (!parsed.success) break
    const rows = parsed.data.data ?? []
    for (const r of rows) collected.push(normalizeInvoice(r))
    if (rows.length < pageSize) break // last page
    page += 1
  }
  return collected
}
