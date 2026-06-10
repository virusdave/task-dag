import { z } from 'zod'

/* -------------------------------------------------------------------------- */
/*  Warehouse locations — packing-by-shelf-location page.                       */
/*                                                                            */
/*  Operators walk the Midtown floor category-by-category, column-by-column,   */
/*  row-by-row, scan the barcode of the package living in each physical        */
/*  location, and Helios writes that location string into the package's        */
/*  Sweed `internalTrackCode`. A second "audit / backfill" mode lists every    */
/*  in-stock FOR-SALE package whose internal tracking code does NOT yet match  */
/*  the location format so the operator can assign one.                        */
/*                                                                            */
/*  Midtown-only initially (dealerId 210705 — hardcoded server-side).          */
/* -------------------------------------------------------------------------- */

/**
 * Fixed enum of 3-letter category prefixes (operator-defined; one per
 * Sweed category). The UI renders these as the prefix chips and the
 * server validates assigned codes against this exact set — a code whose
 * prefix isn't here is rejected (assign) / treated as "not yet located"
 * (audit classification).
 */
export const WAREHOUSE_LOCATION_PREFIXES = [
  { prefix: 'EDI', label: 'Edibles' },
  { prefix: 'PRE', label: 'Pre-rolls' },
  { prefix: 'FLO', label: 'Flower' },
  { prefix: 'BEV', label: 'Beverages' },
  { prefix: 'VAP', label: 'Vapes' },
  { prefix: 'CON', label: 'Concentrates' },
  { prefix: 'TOP', label: 'Topicals' },
  { prefix: 'TIN', label: 'Tinctures' },
  { prefix: 'ACC', label: 'Accessories' },
] as const

export type WarehouseLocationPrefix = (typeof WAREHOUSE_LOCATION_PREFIXES)[number]['prefix']

export const WAREHOUSE_LOCATION_PREFIX_VALUES = WAREHOUSE_LOCATION_PREFIXES.map(
  (entry) => entry.prefix,
) as readonly WarehouseLocationPrefix[]

const PREFIX_ALTERNATION = WAREHOUSE_LOCATION_PREFIX_VALUES.join('|')

/**
 * Location code grammar: `PREFIX-COLUMN-ROW[-split]`
 *   - PREFIX : one of the fixed category prefixes above
 *   - COLUMN : a single uppercase letter A–Z
 *   - ROW    : a positive integer with no leading zeros
 *   - split  : optional single lowercase "bin split" letter (a–z)
 *
 * Examples: EDI-A-4 · PRE-C-1 · PRE-A-3-b · FLO-B-8 · VAP-C-1-a
 *
 * NOTE: kept as a single source of truth so the client validation, the
 * server validation, and the SQL classification predicate (which mirrors
 * this in `^...$` POSIX form) can never drift. If you change this, update
 * `WAREHOUSE_LOCATION_CODE_SQL_REGEX` below too.
 */
export const WAREHOUSE_LOCATION_CODE_REGEX = new RegExp(
  `^(?:${PREFIX_ALTERNATION})-[A-Z]-[1-9][0-9]*(?:-[a-z])?$`,
)

/**
 * POSIX form of the same grammar for use in Postgres `~` matches. Postgres
 * regex doesn't need the JS non-capturing `(?:...)` markers but accepts
 * `(...)`; we anchor with ^...$ and reuse the same prefix alternation so
 * the DB classification matches the app classification exactly.
 */
export const WAREHOUSE_LOCATION_CODE_SQL_REGEX = `^(${PREFIX_ALTERNATION})-[A-Z]-[1-9][0-9]*(-[a-z])?$`

export function isValidWarehouseLocationCode(value: string): boolean {
  return WAREHOUSE_LOCATION_CODE_REGEX.test(value.trim())
}

export const WarehouseLocationCodeSchema = z
  .string()
  .trim()
  .max(32)
  .refine((value) => WAREHOUSE_LOCATION_CODE_REGEX.test(value), {
    message:
      'Location must look like PREFIX-COLUMN-ROW with an optional -split (e.g. PRE-A-3 or PRE-A-3-b).',
  })

/* -------------------------------------------------------------------------- */
/*  GET /api/warehouse-locations/state                                         */
/* -------------------------------------------------------------------------- */

/**
 * One package (Sweed inventory.item) the operator may act on. `effectiveCode`
 * is the location currently believed to be assigned: Helios's own freshly
 * recorded assignment if present (immediately consistent), else the package's
 * Sweed `internalTrackCode` from the 5-minute snapshot mirror.
 */
export const WarehousePackageSchema = z.object({
  inventoryItemId: z.string(),
  productName: z.string().nullable(),
  metrcTag: z.string().nullable(),
  inventoryBarcode: z.string().nullable(),
  availableQty: z.number().nullable(),
  stockLocation: z.string().nullable(),
  /** Current internal tracking code in Sweed (from the snapshot mirror). */
  internalTrackCode: z.string().nullable(),
  /** Helios-recorded warehouse location, if one was assigned. */
  assignedLocationCode: z.string().nullable(),
  /** assignedLocationCode ?? (internalTrackCode if it matches the format). */
  effectiveLocationCode: z.string().nullable(),
  observedAt: z.string(),
})
export type WarehousePackage = z.infer<typeof WarehousePackageSchema>

export const WarehouseLocationsStateMetaSchema = z.object({
  dealerId: z.number().int(),
  siteLabel: z.string(),
  /** Freshness of the package snapshot mirror this read came from. */
  snapshotObservedAt: z.string().nullable(),
  prefixes: z.array(
    z.object({ prefix: z.string(), label: z.string() }),
  ),
})
export type WarehouseLocationsStateMeta = z.infer<typeof WarehouseLocationsStateMetaSchema>

export const WarehouseLocationsStateResponseSchema = z.object({
  meta: WarehouseLocationsStateMetaSchema,
  /** In-stock FOR-SALE packages whose effective code does NOT match the format. */
  auditPackages: z.array(WarehousePackageSchema),
  /** Packages already located (effective code matches the format). */
  occupied: z.array(WarehousePackageSchema),
})
export type WarehouseLocationsStateResponse = z.infer<
  typeof WarehouseLocationsStateResponseSchema
>

/* -------------------------------------------------------------------------- */
/*  POST /api/warehouse-locations/assign                                       */
/* -------------------------------------------------------------------------- */

export const WarehouseLocationAssignRequestSchema = z
  .object({
    locationCode: WarehouseLocationCodeSchema,
    /**
     * Where the request originated — for the audit trail only.
     *  - `shelf-scan`: the Warehouse Locations packing flow (scan → assign).
     *  - `audit`: the Warehouse Locations audit list (tap an unlocated package).
     *  - `images-page`: the per-package "Set shelf" action on Images & Barcodes.
     */
    source: z.enum(['shelf-scan', 'audit', 'images-page']),
    /** A scanned barcode (METRC tag or package barcode) to resolve to package(s). */
    scannedCode: z.string().trim().min(1).max(128).optional(),
    /** A specific package to act on (audit-card tap). */
    inventoryItemId: z.string().trim().min(1).max(64).optional(),
    /**
     * Operator confirmed MOVING matched packages that are currently at a
     * different valid location into this one (the "conflict" case).
     */
    allowReassign: z.boolean().optional(),
  })
  .refine((body) => Boolean(body.scannedCode) !== Boolean(body.inventoryItemId), {
    message: 'Provide exactly one of scannedCode or inventoryItemId.',
  })
export type WarehouseLocationAssignRequest = z.infer<
  typeof WarehouseLocationAssignRequestSchema
>

/**
 * A matched package that was NOT assigned because it is already at a
 * different valid location. Surfaced so the operator can confirm moving it
 * (locations are 1-to-many, so co-located packages are assigned by default —
 * only a package sitting at another location is treated as a conflict).
 */
export const WarehouseScanCandidateSchema = z.object({
  inventoryItemId: z.string(),
  productName: z.string().nullable(),
  metrcTag: z.string().nullable(),
  availableQty: z.number().nullable(),
  stockLocation: z.string().nullable(),
  currentInternalTrackCode: z.string().nullable(),
})
export type WarehouseScanCandidate = z.infer<typeof WarehouseScanCandidateSchema>

/**
 * A matched package that could NOT be assigned because of a per-package error
 * (it vanished from Sweed mid-run, or the Sweed write failed). Surfaced
 * per-package so a failure on one package in a multi-package scan never throws
 * away the packages that DID assign.
 */
export const WarehouseAssignFailureSchema = z.object({
  inventoryItemId: z.string(),
  productName: z.string().nullable(),
  metrcTag: z.string().nullable(),
  reason: z.string(),
})
export type WarehouseAssignFailure = z.infer<typeof WarehouseAssignFailureSchema>

/**
 * Assign outcome (always HTTP 200). A single scan may resolve to MANY
 * co-located packages (e.g. a product split across a 4-pack and a 1-pack in
 * one shelf bin); all of them are assigned by default. Any matched package
 * already sitting at a *different* valid location is left untouched and
 * reported in `conflicts` for the operator to confirm moving (re-submit with
 * allowReassign). Per-package errors (a package that sold mid-run, a Sweed
 * write failure) land in `failures` so the rest of the batch still succeeds.
 * Whole-request failures (bad input, NO matching package, every package
 * failing) use HTTP 4xx/5xx + `{ error }`.
 *
 * `packages` = newly assigned (or already at this code, idempotent).
 * `conflicts` = matched packages skipped because they're located elsewhere.
 * `failures`  = matched packages that errored individually.
 * At least one of the three is non-empty (an empty match is a 404, and an
 * all-failed batch is surfaced as the first error).
 */
export const WarehouseLocationAssignResponseSchema = z
  .object({
    status: z.literal('assigned'),
    locationCode: z.string(),
    packages: z.array(WarehousePackageSchema),
    conflicts: z.array(WarehouseScanCandidateSchema),
    failures: z.array(WarehouseAssignFailureSchema),
  })
  .refine((r) => r.packages.length + r.conflicts.length + r.failures.length > 0, {
    message: 'An assign response must report at least one package, conflict, or failure.',
  })
export type WarehouseLocationAssignResponse = z.infer<
  typeof WarehouseLocationAssignResponseSchema
>
