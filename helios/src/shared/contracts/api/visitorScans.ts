// API contracts for the /admin/visitors/scans operator page.
// virusdave/top-level#9 / FreshlyBakedNYC/automation#31, phase A3.

import { z } from 'zod'

// Comma-separated string in the query string ↔ string[] on the
// server. Supports `?siteSlugs=bx,mh` and `?siteSlugs=bx&siteSlugs=mh`
// equally.
const CsvStringList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => {
    const flat = Array.isArray(value) ? value : [value]
    return flat
      .flatMap((entry) => entry.split(','))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  })
  .pipe(z.array(z.string().min(1)))

export const VisitorScansQuerySchema = z.object({
  siteSlugs: CsvStringList.optional(),
  ingestSources: CsvStringList.optional(),
  states: CsvStringList.optional(),
  postalPrefix: z.string().trim().min(1).max(10).optional(),
  documentType: z.string().trim().min(1).max(64).optional(),
  authenticationStatus: z.string().trim().min(1).max(64).optional(),
  scanStatus: z.string().trim().min(1).max(64).optional(),
  // ISO timestamp lower / upper bounds on Data.Scanned.
  scannedAfter: z.string().min(1).optional(),
  scannedBefore: z.string().min(1).optional(),
  // Forward-only `id < beforeId` cursor for paging older rows.
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})
export type VisitorScansQuery = z.infer<typeof VisitorScansQuerySchema>

export const VisitorScanLinkStatusSchema = z.enum([
  'pending',
  'ambiguous',
  'linked',
  'no_match',
  'failed',
  'rejected',
  'insufficient_data',
])
export type VisitorScanLinkStatus = z.infer<typeof VisitorScanLinkStatusSchema>

export const VisitorScanIdentitySchema = z.object({
  personKey: z.string().nullable(),
  // Strict, id_num-anchored "first scan" indicator. The
  // /admin/visitors/scans pill labelled "First scan" reads from
  // `isFirstScanByIdNum`.
  priorIdNumScanCount: z.number().int().nonnegative(),
  isFirstScanByIdNum: z.boolean(),
  // Looser, person_key-based grouping (name+DOB+state+zip5),
  // useful on the details page for the missing-id_num edge case.
  priorLocalScanCount: z.number().int().nonnegative(),
  firstLocalScanAt: z.string().nullable(),
  latestLocalScanAt: z.string().nullable(),
  isFirstLocalScan: z.boolean(),
})
export type VisitorScanIdentity = z.infer<typeof VisitorScanIdentitySchema>

export const VisitorScanSweedLinkSchema = z.object({
  dealerId: z.number().int(),
  customerId: z.number().int().nullable(),
  status: VisitorScanLinkStatusSchema,
  method: z.string().nullable(),
  confidence: z.number().nullable(),
  linkedAt: z.string().nullable(),
  lastProbedAt: z.string().nullable(),
  nextProbeAt: z.string().nullable(),
  candidateCount: z.number().int().nonnegative(),
})
export type VisitorScanSweedLink = z.infer<typeof VisitorScanSweedLinkSchema>

export const VisitorScanSweedPurchaseSummarySchema = z.object({
  priorPurchaseCount: z.number().int().nonnegative(),
  totalPurchaseCount: z.number().int().nonnegative(),
  firstPurchaseAt: z.string().nullable(),
  firstPurchaseTotalDollars: z.number().nullable(),
  latestPurchaseAt: z.string().nullable(),
  lifetimeSpendDollars: z.number(),
  hasPriorPurchaseBeforeScan: z.boolean(),
})
export type VisitorScanSweedPurchaseSummary = z.infer<
  typeof VisitorScanSweedPurchaseSummarySchema
>

export const VisitorScanMiniMarkerSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  source: z.enum(['document_address', 'scan_location']),
})
export type VisitorScanMiniMarker = z.infer<typeof VisitorScanMiniMarkerSchema>

export const VisitorScanItemSchema = z.object({
  id: z.coerce.number().int(),
  ingestedAt: z.string(),
  ingestSource: z.string(),
  siteSlug: z.string(),
  provider: z.string(),
  scannedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  webhookType: z.string().nullable(),
  hashId: z.string(),
  firstName: z.string().nullable(),
  middleName: z.string().nullable(),
  lastName: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  city: z.string().nullable(),
  address: z.string().nullable(),
  country: z.string().nullable(),
  documentType: z.string().nullable(),
  authenticationStatus: z.string().nullable(),
  scanStatus: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  scanLatitude: z.number().nullable(),
  scanLongitude: z.number().nullable(),
  rawEnvelope: z.unknown(),
  // ---- A4 enrichment (FreshlyBakedNYC/automation#31) ----
  customerUrl: z.string(),
  identity: VisitorScanIdentitySchema,
  sweedLink: VisitorScanSweedLinkSchema.nullable(),
  sweedPurchaseSummary: VisitorScanSweedPurchaseSummarySchema.nullable(),
  miniMarker: VisitorScanMiniMarkerSchema.nullable(),
})
export type VisitorScanItem = z.infer<typeof VisitorScanItemSchema>

export const VisitorScansResponseSchema = z.object({
  items: z.array(VisitorScanItemSchema),
  hasMore: z.boolean(),
})
export type VisitorScansResponse = z.infer<typeof VisitorScansResponseSchema>

// ---------------------------------------------------------------------
// Cashier-tablet "live check-ins" surface
// (virusdave/top-level#12 / FreshlyBakedNYC/automation#40, phase D1).
//
// A privacy-redacted variant of the operator check-ins feed for the
// at-counter cashier display. Deliberately a NARROWER schema (no
// state/postal/city/address/document/coords/raw_envelope) so that a
// cashier-account session cannot use the endpoint to dump PII.
//
// `displayName` is server-computed as "First L." (first name + last
// initial). The full name never crosses the network on this surface.
// ---------------------------------------------------------------------

export const CashierVisitorScanItemSchema = z.object({
  id: z.coerce.number().int(),
  scannedAt: z.string().nullable(),
  ingestedAt: z.string(),
  siteSlug: z.string(),
  // Server-redacted name: "First L." (or just "First" if no last
  // name on file, or "—" if no name at all).
  displayName: z.string(),
  // Strong id_num-based "first visit ever?" indicator, driven off
  // the visitor_scans (provider, id_num) index. Mirrors what the
  // operator page calls `isFirstScanByIdNum`.
  isFirstVisit: z.boolean(),
  // Total scans EVER on this id_num INCLUDING this scan. Operator
  // semantic: a returning visitor's 4th visit shows 4× scanned.
  totalScans: z.number().int().nonnegative(),
  // Last-visit timestamp before this scan (null when first visit).
  lastVisitAt: z.string().nullable(),
  // Sweed-link status. The cashier UI only needs to know whether
  // we have a CRM customer linked (true) vs. still pending / no_match
  // (false). The numeric customerId is intentionally NOT exposed on
  // this surface — the cashier display doesn't deep-link into
  // customer details.
  isCrmLinked: z.boolean(),
  // Compact Sweed-purchase summary when the customer is CRM-linked
  // and has at least one historical order. null otherwise.
  sweedSummary: z
    .object({
      purchaseCount: z.number().int().nonnegative(),
      lifetimeSpendDollars: z.number(),
      averagePurchaseDollars: z.number().nullable(),
      latestPurchaseAt: z.string().nullable(),
      favoriteCategoryName: z.string().nullable(),
      favoriteProductName: z.string().nullable(),
    })
    .nullable(),
})
export type CashierVisitorScanItem = z.infer<typeof CashierVisitorScanItemSchema>

export const CashierVisitorScansResponseSchema = z.object({
  items: z.array(CashierVisitorScanItemSchema),
  // Echoed back so the client can store it as the "seen" highwater
  // mark and gate subsequent polls.
  maxScanId: z.number().int().nullable(),
})
export type CashierVisitorScansResponse = z.infer<typeof CashierVisitorScansResponseSchema>

// Cheap highwater probe response. Single MAX(visitor_scans.id) on
// the server (sub-millisecond). Drives live-update polling on
// both the cashier and operator check-ins pages.
export const VisitorScansHighwaterResponseSchema = z.object({
  maxScanId: z.number().int().nullable(),
})
export type VisitorScansHighwaterResponse = z.infer<
  typeof VisitorScansHighwaterResponseSchema
>
