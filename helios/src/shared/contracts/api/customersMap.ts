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

// First-time vs returning is computed against the full person_key
// history on visitor_scans, NOT against the date window — i.e. a
// returning customer who first appeared 18 months ago is still
// classified as "returning" even when the slider only covers
// yesterday. `unknown` covers scans with no person_key (no
// name/birthdate to dedupe on).
export const VisitTypeSchema = z.enum(['first', 'returning', 'unknown'])
export type VisitType = z.infer<typeof VisitTypeSchema>

// Pre-rolled age buckets (computed at scan time from birth_date).
// `unknown` matches rows missing a usable birth_date.
export const AgeBandSchema = z.enum([
  '21-24',
  '25-34',
  '35-44',
  '45-54',
  '55-plus',
  'unknown',
])
export type AgeBand = z.infer<typeof AgeBandSchema>

// Headline home-state buckets. `other` = any non-null state outside
// the three named ones; `missing` = NULL/empty state column.
export const HomeStateSchema = z.enum(['NY', 'NJ', 'CT', 'other', 'missing'])
export type HomeStateBucket = z.infer<typeof HomeStateSchema>

// CRM-link rollup. Multi-valued so the UI can collapse adjacent
// statuses into reviewer-friendly groupings (e.g. "needs review"
// = ambiguous + rejected).
export const LinkStatusSchema = z.enum([
  'pending',
  'ambiguous',
  'linked',
  'no_match',
  'failed',
  'rejected',
  'insufficient_data',
])
export type LinkStatus = z.infer<typeof LinkStatusSchema>

// Which coordinate the dot is plotted at. `document` = the
// customer's home address; `scan` = the kiosk-reported scan
// location (used as a fallback when the document address has no
// coords). `all` is the default and matches the v1 behaviour.
export const CoordSourceFilterSchema = z.enum(['document', 'scan', 'all'])
export type CoordSourceFilter = z.infer<typeof CoordSourceFilterSchema>

export const CustomersMapQuerySchema = z.object({
  siteSlugs: CsvStringList.optional(),
  // ISO timestamp lower / upper bounds on `checked_in_at`
  // (coalesce(scanned_at, ingested_at)).
  checkedInAfter: z.string().min(1).optional(),
  checkedInBefore: z.string().min(1).optional(),
  // Dimensional filters. All optional; absent = "no filter on this
  // dimension". Each is applied server-side as part of the WHERE
  // clause BEFORE the LIMIT, so totalMatching/clipped stay truthful.
  visitType: VisitTypeSchema.optional(),
  ageBand: AgeBandSchema.optional(),
  homeState: HomeStateSchema.optional(),
  // ZIP prefix, e.g. "10" / "104" / "11209". Matched as
  // postal_code LIKE prefix || '%' so the operator can scope by
  // borough / region without typing a full list of ZIPs.
  postalPrefix: z
    .string()
    .trim()
    .max(10)
    .regex(/^[0-9]*$/, 'postalPrefix must be digits only')
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  linkStatus: z
    .union([z.string(), z.array(z.string())])
    .transform((value) => {
      const flat = Array.isArray(value) ? value : [value]
      return flat
        .flatMap((entry) => entry.split(','))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    })
    .pipe(z.array(LinkStatusSchema))
    .optional(),
  coordSource: CoordSourceFilterSchema.optional(),
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
  // Coordinates we'll plot the dot at. Prefer the customer's
  // document-address coords; fall back to the scan-time coords from
  // the kiosk when the doc address has no usable coordinate. The
  // `coordSource` field tells the client which one it got so the
  // marker can be styled differently and the popup can disclose it.
  lat: z.number(),
  lng: z.number(),
  coordSource: z.enum(['document', 'scan']),
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
