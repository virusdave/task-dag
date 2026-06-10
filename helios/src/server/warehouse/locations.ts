import { z } from 'zod'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  WAREHOUSE_LOCATION_PREFIXES,
  isValidWarehouseLocationCode,
  type WarehouseAssignFailure,
  type WarehouseLocationAssignResponse,
  type WarehouseLocationsStateResponse,
  type WarehousePackage,
  type WarehouseScanCandidate,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { getPool, withClient, type Queryable } from '../db/pool.js'
import { callSweedRpc } from '../../worker/sweed/rpc.js'
import { withSweedSession } from '../../worker/sweed/session.js'

/**
 * Warehouse-locations service. Midtown only for now — the dealer id is
 * pinned here, NOT taken from the client, so a crafted request can never
 * write internalTrackCode against another store. (If/when this expands to
 * other sites, thread a validated siteKey through and resolve to a known
 * dealer from HELIOS_PENDING_PURCHASE_SITE_DEALERS.)
 */
const MIDTOWN = HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((s) => s.siteKey === 'midtown')
if (!MIDTOWN) {
  // Programmer error — the dealer registry must contain Midtown.
  throw new Error('warehouse/locations: Midtown dealer not found in HELIOS_PENDING_PURCHASE_SITE_DEALERS.')
}
const MIDTOWN_DEALER_ID = MIDTOWN.dealerId
const MIDTOWN_SITE_LABEL = MIDTOWN.siteLabel

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/* -------------------------------------------------------------------------- */
/*  Shared mirror row shape + mappers                                          */
/* -------------------------------------------------------------------------- */

interface MirrorRow {
  inventory_item_id: string
  product_name: string | null
  metrc_tag: string | null
  inventory_barcode: string | null
  available_qty: string | number | null
  stock_location: string | null
  internal_track_code: string | null
  observed_at_max: Date | string
  assigned_location_code: string | null
}

function toNumberOrNull(value: string | number | null): number | null {
  if (value === null) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/**
 * The location code currently believed to be on a package: Helios's own
 * fresh assignment wins (immediately consistent), otherwise the package's
 * Sweed internalTrackCode from the snapshot mirror — but only if that
 * mirror value actually parses as a warehouse location code (legacy junk
 * values like a lower-cased METRC tag are treated as "not located").
 */
function effectiveCode(row: MirrorRow): string | null {
  const assigned = row.assigned_location_code?.trim() ?? null
  if (assigned && isValidWarehouseLocationCode(assigned)) {
    return assigned
  }
  const mirror = row.internal_track_code?.trim() ?? null
  if (mirror && isValidWarehouseLocationCode(mirror)) {
    return mirror
  }
  return null
}

function mirrorRowToPackage(row: MirrorRow): WarehousePackage {
  return {
    inventoryItemId: row.inventory_item_id,
    productName: row.product_name,
    metrcTag: row.metrc_tag,
    inventoryBarcode: row.inventory_barcode,
    availableQty: toNumberOrNull(row.available_qty),
    stockLocation: row.stock_location,
    internalTrackCode: row.internal_track_code,
    assignedLocationCode: row.assigned_location_code,
    effectiveLocationCode: effectiveCode(row),
    observedAt: toIso(row.observed_at_max),
  }
}

/**
 * The in-stock FOR-SALE non-trade-sample filter, shared by every read so
 * the audit list, conflict checks, and scan resolution all agree on which
 * packages "exist" for the warehouse-locations flow.
 *
 * `$1` must be the dealer id. Selects from the distinct-on current view and
 * left-joins Helios's own assignment record.
 */
const BASE_PACKAGE_CTE = `
  with cur as (
    select
      c.inventory_item_id,
      c.product_name,
      c.metrc_tag,
      c.raw_json->>'inventoryBarcode' as inventory_barcode,
      c.available_qty,
      c.stock_location,
      c.internal_track_code,
      c.observed_at_max
    from sweed_package_current c
    where c.dealer_id = $1
      and c.is_on_stock = true
      and c.available_qty is not null
      and c.available_qty > 0
      and c.stock_location ilike 'FOR SALE%'
      and coalesce(lower(c.raw_json->>'isTradeSample') = 'true', false) = false
      and coalesce(lower(c.raw_json->>'isNotForSale') = 'true', false) = false
  )
  select
    cur.*,
    wla.location_code as assigned_location_code
  from cur
  left join warehouse_location_assignments wla
    on wla.dealer_id = $1 and wla.inventory_item_id = cur.inventory_item_id
`

/* -------------------------------------------------------------------------- */
/*  GET state                                                                  */
/* -------------------------------------------------------------------------- */

export async function loadWarehouseLocationsState(): Promise<WarehouseLocationsStateResponse> {
  const db = getPool()
  const result = await db.query<MirrorRow>(BASE_PACKAGE_CTE, [MIDTOWN_DEALER_ID])

  const auditPackages: WarehousePackage[] = []
  const occupied: WarehousePackage[] = []
  let snapshotObservedAt: string | null = null

  for (const row of result.rows) {
    const pkg = mirrorRowToPackage(row)
    if (snapshotObservedAt === null || pkg.observedAt > snapshotObservedAt) {
      snapshotObservedAt = pkg.observedAt
    }
    if (pkg.effectiveLocationCode === null) {
      auditPackages.push(pkg)
    } else {
      occupied.push(pkg)
    }
  }

  // Audit list: most-recently-observed first so freshly-received stock the
  // operator is most likely standing in front of bubbles up. Occupied list:
  // sorted by location code so it reads like a shelf map.
  auditPackages.sort((a, b) => b.observedAt.localeCompare(a.observedAt))
  occupied.sort((a, b) =>
    (a.effectiveLocationCode ?? '').localeCompare(b.effectiveLocationCode ?? '', undefined, {
      numeric: true,
    }),
  )

  return {
    meta: {
      dealerId: MIDTOWN_DEALER_ID,
      siteLabel: MIDTOWN_SITE_LABEL,
      snapshotObservedAt,
      prefixes: WAREHOUSE_LOCATION_PREFIXES.map((p) => ({ prefix: p.prefix, label: p.label })),
    },
    auditPackages,
    occupied,
  }
}

/* -------------------------------------------------------------------------- */
/*  Sweed item.get — loose parse                                               */
/* -------------------------------------------------------------------------- */

/**
 * Sweed `store.inventory.item.get` returns a per-package detail object. We
 * only need to (a) confirm the item still exists and (b) read its current
 * internalTrackCode for the "already located — confirm overwrite?" guard.
 * Everything is optional/passthrough so a shape drift never blocks a write.
 */
const SweedItemDetailSchema = z
  .object({
    id: z.union([z.coerce.string(), z.number()]).optional(),
    internalTrackCode: z.string().nullable().optional(),
    externalTrackCode: z.string().nullable().optional(),
  })
  .passthrough()

function extractRpcResult(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'result' in (raw as Record<string, unknown>)) {
    return (raw as { result: unknown }).result
  }
  return raw
}

/* -------------------------------------------------------------------------- */
/*  Assign                                                                     */
/* -------------------------------------------------------------------------- */

export interface AssignWarehouseLocationInput {
  locationCode: string
  source: 'shelf-scan' | 'audit'
  scannedCode?: string
  inventoryItemId?: string
  allowReassign?: boolean
  requestedByUserId: number | null
}

/** Advisory-lock namespace for per-package serialization. Different packages
 *  hash to different keys, so a shelf run stays parallel across packages. */
const LOCK_NS_PACKAGE = `wh-pkg:${MIDTOWN_DEALER_ID}`

/**
 * Assign a warehouse location to the package(s) a scan resolves to.
 *
 * Locations are 1-to-MANY with packages: a single shelf bin commonly holds
 * several packages of the same product (e.g. a 4-pack and a 1-pack), and a
 * scanned barcode/METRC tag can therefore resolve to several in-stock
 * packages. ALL of them are assigned to `locationCode` by default. The only
 * thing that blocks a package is a genuine conflict — it is already sitting at
 * a DIFFERENT valid location — which is surfaced (not silently overwritten)
 * unless the operator confirms the move with `allowReassign`.
 *
 * An audit-card tap targets exactly one package (`inventoryItemId`).
 */
export async function assignWarehouseLocation(
  input: AssignWarehouseLocationInput,
): Promise<WarehouseLocationAssignResponse> {
  const locationCode = input.locationCode.trim()
  if (!isValidWarehouseLocationCode(locationCode)) {
    throw new HttpError(400, `Invalid location code "${locationCode}".`)
  }

  const db = getPool()

  // 1. Resolve the scan to the set of in-stock FOR-SALE packages it matches
  //    (0..n). Done on the pool BEFORE we take the lock client. A 404 is
  //    thrown when nothing matches.
  const targets = await resolveTargetPackages(db, input)
  // Sort by package id so every request acquires the per-package locks below in
  // the same global order — that's what keeps two overlapping scans of an
  // overlapping package set deadlock-free. It also keeps output stable.
  targets.sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId))

  // The Sweed session is established OUTSIDE `withClient`: claiming a Sweed
  // token itself checks a client out of the same pool, so nesting it under a
  // held lock client could exhaust the pool and self-deadlock (pool max 10).
  // Every DB statement below runs on the one checked-out client.
  //
  // ALL target packages are advisory-locked up front, in the sorted order
  // above, then processed, then released in reverse. Sorting gives a single
  // global acquisition order so two overlapping scans of the same multi-package
  // barcode can't interleave and split the group across two locations — the
  // whole matched set moves together. Distinct packages hash to distinct keys,
  // so unrelated shelf runs still proceed in parallel.
  return withSweedSession(() =>
    withClient(async (client) => {
      const locked: string[] = []
      try {
        for (const target of targets) {
          await client.query('select pg_advisory_lock(hashtext($1), hashtext($2))', [
            LOCK_NS_PACKAGE,
            target.inventoryItemId,
          ])
          locked.push(target.inventoryItemId)
        }

        const assigned: WarehousePackage[] = []
        const conflicts: WarehouseScanCandidate[] = []
        const failures: { failure: WarehouseAssignFailure; error: HttpError }[] = []
        for (const target of targets) {
          const outcome = await assignOnePackage(client, input, locationCode, target)
          if (outcome.kind === 'assigned') {
            assigned.push(outcome.package)
          } else if (outcome.kind === 'conflict') {
            conflicts.push(outcome.conflict)
          } else {
            failures.push({ failure: outcome.failure, error: outcome.error })
          }
        }

        // If nothing succeeded and nothing is a (recoverable) conflict, surface
        // the first error as the whole-request failure — this preserves the
        // single-scan / audit-card behaviour (e.g. a 404 when the one package
        // the operator targeted has gone). Otherwise return 200 with whatever
        // assigned plus the per-package failures so successes are never lost.
        if (assigned.length === 0 && conflicts.length === 0 && failures.length > 0) {
          throw failures[0]!.error
        }

        return {
          status: 'assigned',
          locationCode,
          packages: assigned,
          conflicts,
          failures: failures.map((f) => f.failure),
        }
      } finally {
        for (const inventoryItemId of [...locked].reverse()) {
          await releaseLock(client, LOCK_NS_PACKAGE, inventoryItemId)
        }
      }
    }),
  )
}

async function releaseLock(client: Queryable, namespace: string, key: string): Promise<void> {
  try {
    await client.query('select pg_advisory_unlock(hashtext($1), hashtext($2))', [namespace, key])
  } catch (error) {
    console.error('warehouse/locations: advisory unlock failed', error)
  }
}

type PackageOutcome =
  | { kind: 'assigned'; package: WarehousePackage }
  | { kind: 'conflict'; conflict: WarehouseScanCandidate }
  | { kind: 'failed'; failure: WarehouseAssignFailure; error: HttpError }

/** The columns we need to restore a prior assignment if a Sweed write fails. */
interface PriorAssignmentRow {
  location_code: string
  metrc_tag: string | null
  product_name: string | null
  assigned_by_user_id: string | number | null
  assigned_at: Date | string
}

function packageFailure(target: WarehousePackage, reason: string): WarehouseAssignFailure {
  return {
    inventoryItemId: target.inventoryItemId,
    productName: target.productName,
    metrcTag: target.metrcTag,
    reason,
  }
}

/**
 * Assign one package to `locationCode`, run on the single client that holds
 * that package's advisory lock (and inside the ambient Sweed session).
 *
 * Steps:
 *   1. live-verify the package + read its current internalTrackCode,
 *   2. conflict guard: a package already at a DIFFERENT valid location is left
 *      untouched and returned as a conflict unless `allowReassign`,
 *   3. RESERVE the code in Helios's own table (immediately consistent),
 *   4. write Sweed — on failure, RESTORE the package's prior assignment row so
 *      a reassign that fails never erases the package's old valid location,
 *   5. best-effort audit (must not undo a completed assignment).
 * Reserving before the Sweed write means there is no post-write window where
 * Helios reads the package as unlocated.
 *
 * Per-package errors are returned as `{ kind: 'failed' }` rather than thrown,
 * so one bad package in a multi-package scan never discards the packages that
 * assigned cleanly; the caller decides whether an all-failed batch becomes a
 * whole-request error.
 */
async function assignOnePackage(
  client: Queryable,
  input: AssignWarehouseLocationInput,
  locationCode: string,
  target: WarehousePackage,
): Promise<PackageOutcome> {
  const inventoryItemId = target.inventoryItemId

  // 1. Live-verify the package and read its current internalTrackCode (the
  //    Sweed session is already open around this whole call).
  let detailRaw: unknown
  try {
    detailRaw = await callSweedRpc<unknown>(MIDTOWN_DEALER_ID, 'store.inventory.item.get', {
      inventoryItemId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      kind: 'failed',
      failure: packageFailure(
        target,
        `could not be loaded from Sweed (it may have been sold or moved)`,
      ),
      error: new HttpError(
        404,
        `Package ${inventoryItemId} could not be loaded from Sweed (it may have been sold or moved): ${message}`,
      ),
    }
  }
  const detail = SweedItemDetailSchema.parse(extractRpcResult(detailRaw))
  const previousInternalTrackCode = detail.internalTrackCode?.trim() ?? null

  // 2. Conflict guard. A package already at a DIFFERENT valid location is a
  //    real conflict (co-located packages sharing this code are NOT — that's
  //    the whole point of 1-to-many). Surface it for confirmation rather than
  //    silently moving it, unless the operator already confirmed the move.
  //    Checked before any write/reservation, so the skip leaves state untouched.
  if (
    !input.allowReassign &&
    previousInternalTrackCode !== null &&
    previousInternalTrackCode !== locationCode &&
    isValidWarehouseLocationCode(previousInternalTrackCode)
  ) {
    return {
      kind: 'conflict',
      conflict: {
        inventoryItemId,
        productName: target.productName,
        metrcTag: target.metrcTag,
        availableQty: target.availableQty,
        stockLocation: target.stockLocation,
        currentInternalTrackCode: previousInternalTrackCode,
      },
    }
  }

  // 3. Reserve the code in Helios's own table FIRST (immediately consistent).
  //    A package holds at most one location, so this upserts on the package
  //    key (1-to-1 package→location); many packages may share a location.
  //    Capture any prior row first so a failed Sweed write can restore it.
  const priorRow = await loadPriorAssignment(client, inventoryItemId)
  await reserveAssignment(client, input, locationCode, target, inventoryItemId)

  // 4. Write Sweed. Skip the RPC when the code is already exactly this
  //    (idempotent re-scan). On failure, restore the prior reservation so we
  //    never leave the package claiming a location Sweed never accepted.
  if (previousInternalTrackCode !== locationCode) {
    try {
      await callSweedRpc(MIDTOWN_DEALER_ID, 'store.inventory.item.update.internaltrackcode', {
        internalTrackCode: locationCode,
        inventoryItemId,
      })
    } catch (error) {
      await restoreAssignment(client, inventoryItemId, locationCode, priorRow)
      const message = error instanceof Error ? error.message : String(error)
      return {
        kind: 'failed',
        failure: packageFailure(target, `Sweed rejected the location write`),
        error: new HttpError(
          502,
          `Failed to write location ${locationCode} to Sweed for package ${inventoryItemId}: ${message}`,
        ),
      }
    }
  }

  // 5. Audit is best-effort: the assignment (Sweed + reservation) is already
  //    durable, so a failure to record the audit row must not undo it.
  try {
    await appendAuditEvent(client, {
      actorType: 'user',
      actorUserId: input.requestedByUserId,
      entityId: inventoryItemId,
      entityType: 'catalog_item',
      eventType: 'catalog.warehouse_location.assigned',
      module: 'catalog',
      payload: {
        dealerId: MIDTOWN_DEALER_ID,
        inventoryItemId,
        locationCode,
        metrcTag: target.metrcTag,
        productName: target.productName,
        previousInternalTrackCode,
        source: input.source,
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  } catch (error) {
    console.error(
      'warehouse/locations: audit append failed (assignment is still recorded)',
      error,
    )
  }

  return {
    kind: 'assigned',
    package: {
      ...target,
      internalTrackCode: locationCode,
      assignedLocationCode: locationCode,
      effectiveLocationCode: locationCode,
    },
  }
}

/** Read the package's current assignment row (if any), under its held lock,
 *  so a failed Sweed write can put it back exactly as it was. */
async function loadPriorAssignment(
  client: Queryable,
  inventoryItemId: string,
): Promise<PriorAssignmentRow | null> {
  const result = await client.query<PriorAssignmentRow>(
    `select location_code, metrc_tag, product_name, assigned_by_user_id, assigned_at
       from warehouse_location_assignments
      where dealer_id = $1 and inventory_item_id = $2`,
    [MIDTOWN_DEALER_ID, inventoryItemId],
  )
  return result.rows[0] ?? null
}

/** Undo a reservation after a failed Sweed write: restore the package's prior
 *  row verbatim if it had one, else delete the row we just inserted (guarded by
 *  the code we attempted, so we never touch a row a concurrent run re-created).
 *  Best-effort — the original Sweed error is what the caller surfaces. */
async function restoreAssignment(
  client: Queryable,
  inventoryItemId: string,
  attemptedCode: string,
  prior: PriorAssignmentRow | null,
): Promise<void> {
  try {
    if (prior) {
      await client.query(
        `insert into warehouse_location_assignments
           (dealer_id, location_code, inventory_item_id, metrc_tag, product_name, assigned_by_user_id, assigned_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (dealer_id, inventory_item_id) do update set
           location_code = excluded.location_code,
           metrc_tag = excluded.metrc_tag,
           product_name = excluded.product_name,
           assigned_by_user_id = excluded.assigned_by_user_id,
           assigned_at = excluded.assigned_at`,
        [
          MIDTOWN_DEALER_ID,
          prior.location_code,
          inventoryItemId,
          prior.metrc_tag,
          prior.product_name,
          prior.assigned_by_user_id,
          prior.assigned_at,
        ],
      )
    } else {
      await client.query(
        `delete from warehouse_location_assignments
          where dealer_id = $1 and inventory_item_id = $2 and location_code = $3`,
        [MIDTOWN_DEALER_ID, inventoryItemId, attemptedCode],
      )
    }
  } catch (cleanupError) {
    console.error(
      'warehouse/locations: failed to roll back reservation after Sweed write error',
      cleanupError,
    )
  }
}

/** Upsert the package's assignment to `locationCode` (1-to-1 on the package
 *  key; a location may hold many packages), in one tx on the locked client. */
async function reserveAssignment(
  client: Queryable,
  input: AssignWarehouseLocationInput,
  locationCode: string,
  target: WarehousePackage,
  inventoryItemId: string,
): Promise<void> {
  await client.query('begin')
  try {
    await client.query(
      `insert into warehouse_location_assignments
         (dealer_id, location_code, inventory_item_id, metrc_tag, product_name, assigned_by_user_id, assigned_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (dealer_id, inventory_item_id) do update set
         location_code = excluded.location_code,
         metrc_tag = excluded.metrc_tag,
         product_name = excluded.product_name,
         assigned_by_user_id = excluded.assigned_by_user_id,
         assigned_at = now()`,
      [
        MIDTOWN_DEALER_ID,
        locationCode,
        inventoryItemId,
        target.metrcTag,
        target.productName,
        input.requestedByUserId,
      ],
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => {
      /* the original error is what matters */
    })
    throw error
  }
}

/**
 * Resolve the request to the set of in-stock FOR-SALE Midtown packages it
 * targets. An audit-card tap (`inventoryItemId`) resolves to exactly that one
 * package; a `scannedCode` resolves to EVERY package whose METRC tag or
 * package barcode matches (0..n — 1-to-many co-located packages). Throws a 404
 * when nothing matches.
 */
async function resolveTargetPackages(
  db: Queryable,
  input: AssignWarehouseLocationInput,
): Promise<WarehousePackage[]> {
  if (input.inventoryItemId) {
    const itemId = input.inventoryItemId.trim()
    const result = await db.query<MirrorRow>(
      `${BASE_PACKAGE_CTE} where cur.inventory_item_id = $2`,
      [MIDTOWN_DEALER_ID, itemId],
    )
    const row = result.rows[0]
    if (!row) {
      throw new HttpError(
        404,
        `Package ${itemId} is not an in-stock FOR-SALE Midtown package (it may have sold out, moved, or been marked not-for-sale).`,
      )
    }
    return [mirrorRowToPackage(row)]
  }

  const scanned = (input.scannedCode ?? '').trim()
  if (scanned.length === 0) {
    throw new HttpError(400, 'A scanned barcode or inventoryItemId is required.')
  }
  // Match the scan against EITHER the METRC tag or the package barcode,
  // case-insensitively (METRC tags are upper-cased on labels; inventory
  // barcodes are sometimes stored lower-cased).
  const result = await db.query<MirrorRow>(
    `${BASE_PACKAGE_CTE}
       where upper(trim(coalesce(cur.metrc_tag, ''))) = upper($2)
          or upper(trim(coalesce(cur.inventory_barcode, ''))) = upper($2)`,
    [MIDTOWN_DEALER_ID, scanned],
  )
  if (result.rows.length === 0) {
    throw new HttpError(
      404,
      `No in-stock FOR-SALE Midtown package matches the scanned code "${scanned}".`,
    )
  }
  return result.rows.map(mirrorRowToPackage)
}
