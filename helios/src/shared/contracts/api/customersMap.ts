// API contract for the /admin/customers/map page.
//
// Customers UX child epic FreshlyBakedNYC/automation#33, phase C4.
//
// v1 ships point-level data only — one feature per visitor_scan
// that has document-address coordinates (Data.Latitude/Longitude
// from the VeriScan envelope, persisted as
// visitor_scans.latitude/longitude). Grid aggregation, encoding
// panel, and timeline replay are deferred to follow-on slices of
// this same epic.

import { z } from 'zod'

// Comma-separated string in the query string ↔ string[] on the
// server. Mirrors the convention used by /api/visitors/scans so the
// future shared-filter wiring can hand the exact same query object
// to both endpoints.
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

export const CustomersMapQuerySchema = z.object({
  siteSlugs: CsvStringList.optional(),
  // ISO timestamp lower / upper bounds on `checked_in_at`
  // (coalesce(scanned_at, ingested_at)).
  checkedInAfter: z.string().min(1).optional(),
  checkedInBefore: z.string().min(1).optional(),
  // Hard cap on the number of points returned; the server uses this
  // both as the LIMIT and as a "too many" sentinel that the client
  // surfaces as "data clipped — narrow your filter" in the UI.
  // Default keeps a phone-friendly payload + render budget.
  maxPoints: z.coerce.number().int().min(1).max(10_000).default(2_500),
})
export type CustomersMapQuery = z.infer<typeof CustomersMapQuerySchema>

export const CustomersMapPointSchema = z.object({
  scanId: z.number().int(),
  siteSlug: z.string(),
  // `checked_in_at` per parent design §11 — coalesce(scanned_at,
  // ingested_at). Always present.
  checkedInAt: z.string(),
  // The customer's document-address coords (where they live, not
  // where they scanned). Filtered to non-null on the server.
  lat: z.number(),
  lng: z.number(),
  // Soft display fields so the popup doesn't need a second round trip.
  displayName: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  customerUrl: z.string(),
})
export type CustomersMapPoint = z.infer<typeof CustomersMapPointSchema>

export const CustomersMapSitePinSchema = z.object({
  siteSlug: z.string(),
  label: z.string(),
  lat: z.number(),
  lng: z.number(),
})
export type CustomersMapSitePin = z.infer<typeof CustomersMapSitePinSchema>

export const CustomersMapResponseSchema = z.object({
  points: z.array(CustomersMapPointSchema),
  sitePins: z.array(CustomersMapSitePinSchema),
  totalMatching: z.number().int().nonnegative(),
  // True when `points.length === query.maxPoints && totalMatching >
  // points.length` — the client uses this to render the "clipped"
  // banner per parent design §11.
  clipped: z.boolean(),
})
export type CustomersMapResponse = z.infer<typeof CustomersMapResponseSchema>
