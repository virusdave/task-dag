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
  // ----------------- Encoding axes (color / size) -----------------
  // Per-point dimensions the operator can map to color and size on
  // the front-end. All optional from the server's perspective (the
  // map degrades gracefully on missing values).
  //
  // first-vs-returning is computed against the FULL person_key
  // history on visitor_scans, NOT the date window — so the saturation
  // boost for first-timers reflects whether THIS is the customer's
  // very first scan ever, even when the slider only covers yesterday.
  visitType: VisitTypeSchema,
  // Age in whole years at the moment of scan. NULL when birth_date
  // is missing.
  ageYears: z.number().int().nullable(),
  // Raw VeriScan-reported sex marker ("M" / "F" / "X" / …). NULL
  // when missing or blank. We deliberately do not coerce to a fixed
  // enum here — government-document gender markers vary by issuing
  // jurisdiction and we want the dot to reflect what we got.
  gender: z.string().nullable(),
  // Lifetime visits = total visitor_scans rows sharing the same
  // (provider, person_key) cohort, regardless of date. 1 when
  // person_key is NULL (we treat this single anonymous scan as a
  // lifetime-of-one for ranking purposes).
  lifetimeVisitCount: z.number().int().nonnegative(),
  // "Current" lifetime spend / order count from the linked Sweed
  // CRM customer. NULL when the scan is NOT linked to a Sweed
  // customer; 0 when linked but no mirrored orders. NOT
  // as-of-scan-time — these reflect today's running total, so a
  // 2022 first scan can be colored by a 2024 purchase. Labelled
  // accordingly in the legend.
  lifetimeSpendDollars: z.number().nullable(),
  lifetimeOrderCount: z.number().int().nullable(),
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
  // Scans matching the current filter (time range, site, dimensional
  // filters) that have NO usable home geocode — i.e. we cannot
  // place a dot for them. Surfaced in the UI as a small "Unknown: N"
  // badge. We deliberately do NOT fall back to plotting these at the
  // store kiosk location.
  unknownCount: z.number().int().nonnegative(),
  // True when `points.length === query.maxPoints && totalMatching >
  // points.length` — the client uses this to render the "clipped"
  // banner per parent design §11.
  clipped: z.boolean(),
  // Highest visitor_scans.id observed at response-build time,
  // across ALL scans (not just rows matching the current filter).
  // The SPA stores this and polls /api/admin/customers/map/highwater
  // every few seconds; when the polled value exceeds the stored
  // value the client triggers a single full refetch. This converts
  // the page from "stale until you change a filter" to "near-live"
  // while keeping the polling cost to one indexed primary-key MAX
  // per poll. `null` means no scans exist yet.
  maxScanId: z.number().int().nonnegative().nullable(),
})
export type CustomersMapResponse = z.infer<typeof CustomersMapResponseSchema>

/**
 * Earliest-record meta endpoint for the customer-origin map.
 *
 * Returns the timestamp of the earliest visitor_scan (so the SPA's
 * replay slider can span all of history rather than a hard-coded
 * rolling 30-day window). `null` means "no scans at all yet".
 */
export const CustomersMapEarliestResponseSchema = z.object({
  earliestCheckedInAt: z.string().nullable(),
})
export type CustomersMapEarliestResponse = z.infer<typeof CustomersMapEarliestResponseSchema>

/**
 * Highwater-mark probe for the customer-origin map.
 *
 * Returns the current MAX(visitor_scans.id). The SPA polls this
 * every few seconds while the page is visible; when the polled
 * value exceeds the last value it stored from the full map fetch
 * (CustomersMapResponse.maxScanId), it triggers a single full
 * refetch. Polling cost is one indexed primary-key MAX per call
 * — Postgres serves it from the rightmost leaf of the pkey
 * b-tree, which is effectively free.
 *
 * `null` means no scans exist yet.
 */
export const CustomersMapHighwaterResponseSchema = z.object({
  maxScanId: z.number().int().nonnegative().nullable(),
})
export type CustomersMapHighwaterResponse = z.infer<typeof CustomersMapHighwaterResponseSchema>
