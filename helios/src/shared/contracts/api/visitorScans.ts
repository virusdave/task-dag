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
})
export type VisitorScanItem = z.infer<typeof VisitorScanItemSchema>

export const VisitorScansResponseSchema = z.object({
  items: z.array(VisitorScanItemSchema),
  hasMore: z.boolean(),
})
export type VisitorScansResponse = z.infer<typeof VisitorScansResponseSchema>
