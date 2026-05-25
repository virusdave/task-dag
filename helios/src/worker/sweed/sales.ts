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
// Sweed's RPC contract documented (operator-supplied):
//
//   { auth: <token>, name: 'store.sale.invoice.list', id: <uuid>,
//     params: { page, pageSize, fromDate: ISO, toDate: ISO } }
//
// Response shape across Sweed `*.list` endpoints uniformly carries
// `{ data: Row[], totalCount }`. The per-row shape on
// `store.sale.invoice.list` was not handed to us in writing, so the
// zod schema here is defensive: every field is .optional() /
// .nullable() and pass-through is enabled. Concrete field names
// (`closedAt`, `createdAt`, `client.id`, `client.phone`,
// `client.email`, `client.name`) are inferred from sibling Sweed
// RPCs we already integrate against and confirmed at runtime by
// the candidate-purchases route.
// =====================================================================

export const SWEED_RPC_SALE_INVOICE_LIST = 'store.sale.invoice.list'

const InvoiceClientSchema = z
  .object({
    id: z.coerce.number().int().nullable().optional(),
    phone: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional()

const InvoiceRowSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    // Sweed's invoice rows carry a sale-time field under one of these
    // names depending on the endpoint variant. We try them in order.
    closedAt: z.string().nullable().optional(),
    finishedAt: z.string().nullable().optional(),
    completedAt: z.string().nullable().optional(),
    createdAt: z.string().nullable().optional(),
    saleAt: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    // Total may surface under several names; we just pass it through.
    total: z.coerce.number().nullable().optional(),
    grandTotal: z.coerce.number().nullable().optional(),
    // Client subdocument shape.
    client: InvoiceClientSchema,
    // Older Sweed variants flatten the client onto the invoice row.
    clientId: z.coerce.number().int().nullable().optional(),
    clientPhone: z.string().nullable().optional(),
    clientEmail: z.string().nullable().optional(),
    clientName: z.string().nullable().optional(),
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

function pickSaleTime(raw: z.infer<typeof InvoiceRowSchema>): Date | null {
  const candidates = [
    raw.closedAt,
    raw.finishedAt,
    raw.completedAt,
    raw.saleAt,
    raw.date,
    raw.createdAt,
  ]
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue
    const d = new Date(candidate)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

function pickClientName(raw: z.infer<typeof InvoiceRowSchema>): string | null {
  const c = raw.client ?? null
  if (c !== null) {
    if (typeof c.name === 'string' && c.name.trim().length > 0) return c.name.trim()
    const first = typeof c.firstName === 'string' ? c.firstName.trim() : ''
    const last = typeof c.lastName === 'string' ? c.lastName.trim() : ''
    const combined = `${first} ${last}`.trim()
    if (combined.length > 0) return combined
  }
  if (typeof raw.clientName === 'string' && raw.clientName.trim().length > 0) {
    return raw.clientName.trim()
  }
  return null
}

function normalizeInvoice(raw: z.infer<typeof InvoiceRowSchema>): SweedInvoiceRow {
  const c = raw.client ?? null
  const total = raw.total ?? raw.grandTotal ?? null
  return {
    invoiceId: raw.id !== undefined && raw.id !== null ? String(raw.id) : null,
    saleTime: pickSaleTime(raw),
    total: typeof total === 'number' && Number.isFinite(total) ? total : null,
    clientId:
      typeof c?.id === 'number'
        ? c.id
        : typeof raw.clientId === 'number'
          ? raw.clientId
          : null,
    clientName: pickClientName(raw),
    clientPhone:
      (typeof c?.phone === 'string' ? c.phone : null) ??
      (typeof raw.clientPhone === 'string' ? raw.clientPhone : null),
    clientEmail:
      (typeof c?.email === 'string' ? c.email : null) ??
      (typeof raw.clientEmail === 'string' ? raw.clientEmail : null),
    raw,
  }
}

/**
 * List retail invoices for a dealer in a time window. The caller is
 * expected to be inside a `withSweedSession` block.
 *
 * Pagination is single-shot at `pageSize` rows — the candidate
 * surface only needs the few invoices nearest the review-submit
 * moment, so 50 is plenty even for a busy dispensary.
 */
export async function listSaleInvoices(args: {
  dealerId: number
  fromDate: Date
  toDate: Date
  pageSize?: number
}): Promise<SweedInvoiceRow[]> {
  const raw = await callSweedRpc<unknown>(args.dealerId, SWEED_RPC_SALE_INVOICE_LIST, {
    page: 1,
    pageSize: args.pageSize ?? 50,
    fromDate: args.fromDate.toISOString(),
    toDate: args.toDate.toISOString(),
  })
  const parsed = InvoiceListResponseSchema.safeParse(raw)
  if (!parsed.success) return []
  return (parsed.data.data ?? []).map(normalizeInvoice)
}
