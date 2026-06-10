import { z } from 'zod'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  WAREHOUSE_LOCATION_PREFIXES,
  WAREHOUSE_LOCATION_CODE_SQL_REGEX,
  isValidWarehouseLocationCode,
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

function mirrorRowToCandidate(row: MirrorRow): WarehouseScanCandidate {
  return {
    inventoryItemId: row.inventory_item_id,
    productName: row.product_name,
    metrcTag: row.metrc_tag,
    availableQty: toNumberOrNull(row.available_qty),
    stockLocation: row.stock_location,
    currentInternalTrackCode: row.assigned_location_code ?? row.internal_track_code,
  }
}

/**
 * The in-stock FOR-SALE non-trade-sample filter, shared by every read so
 * the audit list, occupancy checks, and scan resolution all agree on which
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

/** First key of each advisory-lock namespace. Distinct first keys keep the
 *  location and package lock spaces from ever colliding with each other. */
const LOCK_NS_LOCATION = `wh-loc:${MIDTOWN_DEALER_ID}`
const LOCK_NS_PACKAGE = `wh-pkg:${MIDTOWN_DEALER_ID}`

export async function assignWarehouseLocation(
  input: AssignWarehouseLocationInput,
): Promise<WarehouseLocationAssignResponse> {
  const locationCode = input.locationCode.trim()
  if (!isValidWarehouseLocationCode(locationCode)) {
    throw new HttpError(400, `Invalid location code "${locationCode}".`)
  }

  const db = getPool()

  // 1. Resolve the target package (returns a structured "ambiguous" outcome
  //    rather than throwing when a scan matches more than one package). Done
  //    on the pool BEFORE we take the lock client.
  const resolution = await resolveTargetPackage(db, input)
  if (resolution.kind === 'ambiguous') {
    return { status: 'ambiguous', candidates: resolution.candidates }
  }
  const target = resolution.row
  const inventoryItemId = target.inventoryItemId

  // The critical section is serialized with two Postgres session advisory
  // locks held on a SINGLE dedicated client:
  //   * per (dealer, location code) — so two operators can't both claim the
  //     same code for different packages (breaking 1-to-1 in Sweed), and
  //   * per (dealer, package)       — so two operators can't assign the same
  //     package to two different codes and leave Helios disagreeing with Sweed.
  // Always location-first then package-second: a single global acquisition
  // order makes the pair deadlock-free. Different codes / packages hash to
  // different keys, so a shelf run stays parallel across distinct shelves.
  //
  // The Sweed session is established OUTSIDE `withClient`: claiming a Sweed
  // token itself checks a client out of the same pool, so nesting it under a
  // held lock client could exhaust the pool and self-deadlock (pool max 10).
  // Every other DB statement below runs on the one locked client.
  return withSweedSession(() =>
    withClient(async (client) => {
      await client.query('select pg_advisory_lock(hashtext($1), hashtext($2))', [
        LOCK_NS_LOCATION,
        locationCode,
      ])
      await client.query('select pg_advisory_lock(hashtext($1), hashtext($2))', [
        LOCK_NS_PACKAGE,
        inventoryItemId,
      ])
      try {
        return await assignUnderLock(client, input, locationCode, target, inventoryItemId)
      } finally {
        await releaseLock(client, LOCK_NS_PACKAGE, inventoryItemId)
        await releaseLock(client, LOCK_NS_LOCATION, locationCode)
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

/**
 * The location-claiming critical section, run on the single client that holds
 * the per-location and per-package advisory locks (and inside the ambient
 * Sweed session). Every step is serialized against any other assignment that
 * touches the same location code or the same package.
 *
 * Ordering is "reserve locally, then write Sweed, compensating on failure":
 *   2. occupancy guard (1-to-1 codes),
 *   3. live-verify the package + read its current code (already-located guard),
 *   4. RESERVE the code in Helios's own table (immediately consistent),
 *   5. write Sweed — on failure, drop the reservation so the code never looks
 *      claimed for a package whose Sweed code we never changed,
 *   6. best-effort audit (must not undo a completed assignment).
 * Reserving before the Sweed write means there is no post-write window where
 * the code reads as free, which is what made a duplicate possible.
 */
async function assignUnderLock(
  client: Queryable,
  input: AssignWarehouseLocationInput,
  locationCode: string,
  target: WarehousePackage,
  inventoryItemId: string,
): Promise<WarehouseLocationAssignResponse> {
  // 2. Location-occupancy guard (1-to-1 codes). Authoritative under the lock:
  //    if another in-stock package already holds this exact code, the operator
  //    must pick a different bin-split suffix.
  const occupant = await findLocationOccupant(client, locationCode, inventoryItemId)
  if (occupant) {
    return { status: 'location-occupied', locationCode, occupant }
  }

  // 3. Live-verify the package and read its current internalTrackCode (the
  //    Sweed session is already open around this whole call).
  let detailRaw: unknown
  try {
    detailRaw = await callSweedRpc<unknown>(MIDTOWN_DEALER_ID, 'store.inventory.item.get', {
      inventoryItemId,
    })
  } catch (error) {
    throw new HttpError(
      404,
      `Package ${inventoryItemId} could not be loaded from Sweed (it may have been sold or moved): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const detail = SweedItemDetailSchema.parse(extractRpcResult(detailRaw))
  const previousInternalTrackCode = detail.internalTrackCode?.trim() ?? null

  // Already-located guard: refuse to silently clobber an existing valid
  // location code unless the operator confirmed the reassignment. Checked
  // before any write or reservation, so the abort leaves all state untouched.
  if (
    !input.allowReassign &&
    previousInternalTrackCode !== null &&
    previousInternalTrackCode !== locationCode &&
    isValidWarehouseLocationCode(previousInternalTrackCode)
  ) {
    return {
      status: 'already-assigned',
      currentLocationCode: previousInternalTrackCode,
      candidate: mirrorRowToCandidate(targetMirrorRow(target)),
    }
  }

  // 4. Reserve the code in Helios's own table FIRST (immediately consistent).
  //    A package holds at most one location, so drop its prior row before
  //    inserting. The `on conflict (dealer, location)` branch only ever fires
  //    for a STALE row left by a package that has since left stock (the
  //    occupancy guard above already ruled out any in-stock holder), so
  //    reclaiming it is correct.
  await reserveAssignment(client, input, locationCode, target, inventoryItemId)

  // 5. Write Sweed. Skip the RPC when the code is already exactly this
  //    (idempotent re-scan). On failure, drop the reservation we just made.
  if (previousInternalTrackCode !== locationCode) {
    try {
      await callSweedRpc(MIDTOWN_DEALER_ID, 'store.inventory.item.update.internaltrackcode', {
        internalTrackCode: locationCode,
        inventoryItemId,
      })
    } catch (error) {
      await client
        .query(
          `delete from warehouse_location_assignments
            where dealer_id = $1 and location_code = $2 and inventory_item_id = $3`,
          [MIDTOWN_DEALER_ID, locationCode, inventoryItemId],
        )
        .catch((cleanupError: unknown) => {
          console.error(
            'warehouse/locations: failed to roll back reservation after Sweed write error',
            cleanupError,
          )
        })
      throw new HttpError(
        502,
        `Failed to write location ${locationCode} to Sweed for package ${inventoryItemId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  // 6. Audit is best-effort: the assignment (Sweed + reservation) is already
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

  const assignedPackage: WarehousePackage = {
    ...target,
    internalTrackCode: locationCode,
    assignedLocationCode: locationCode,
    effectiveLocationCode: locationCode,
  }

  return {
    status: 'assigned',
    locationCode,
    package: assignedPackage,
    previousInternalTrackCode,
  }
}

/** Drop the package's prior assignment then claim `locationCode`, in one tx on
 *  the locked client. */
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
      `delete from warehouse_location_assignments
        where dealer_id = $1 and inventory_item_id = $2`,
      [MIDTOWN_DEALER_ID, inventoryItemId],
    )
    await client.query(
      `insert into warehouse_location_assignments
         (dealer_id, location_code, inventory_item_id, metrc_tag, product_name, assigned_by_user_id, assigned_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (dealer_id, location_code) do update set
         inventory_item_id = excluded.inventory_item_id,
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

function targetMirrorRow(pkg: WarehousePackage): MirrorRow {
  return {
    inventory_item_id: pkg.inventoryItemId,
    product_name: pkg.productName,
    metrc_tag: pkg.metrcTag,
    inventory_barcode: pkg.inventoryBarcode,
    available_qty: pkg.availableQty,
    stock_location: pkg.stockLocation,
    internal_track_code: pkg.internalTrackCode,
    observed_at_max: pkg.observedAt,
    assigned_location_code: pkg.assignedLocationCode,
  }
}

type Resolution =
  | { kind: 'single'; row: WarehousePackage }
  | { kind: 'ambiguous'; candidates: WarehouseScanCandidate[] }

async function resolveTargetPackage(
  db: Queryable,
  input: AssignWarehouseLocationInput,
): Promise<Resolution> {
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
    return { kind: 'single', row: mirrorRowToPackage(row) }
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
  if (result.rows.length === 1) {
    return { kind: 'single', row: mirrorRowToPackage(result.rows[0]!) }
  }
  return { kind: 'ambiguous', candidates: result.rows.map(mirrorRowToCandidate) }
}

/**
 * Find an *in-stock* package OTHER than `excludeItemId` whose EFFECTIVE
 * location code is exactly `locationCode`.
 *
 * Both the fresh source (Helios's own assignment record, joined in by
 * BASE_PACKAGE_CTE) and the eventual source (the snapshot mirror's
 * format-valid `internal_track_code`) are considered, via the same
 * `coalesce(assignment, internalTrackCode)` precedence used everywhere else.
 *
 * Crucially this is scoped to BASE_PACKAGE_CTE (in-stock, FOR-SALE,
 * non-trade-sample), so a stale assignment row that points at a package which
 * has since sold out or moved does NOT report the code as occupied — that code
 * is genuinely free for reuse. The SQL regex must stay in lockstep with the JS
 * WAREHOUSE_LOCATION_CODE_REGEX.
 */
async function findLocationOccupant(
  db: Queryable,
  locationCode: string,
  excludeItemId: string,
): Promise<WarehouseScanCandidate | null> {
  // `trim()` mirrors the JS validity check (which trims), so a Sweed value
  // like 'EDI-A-3 ' is recognised as occupying EDI-A-3 rather than read as free.
  const result = await db.query<MirrorRow>(
    `${BASE_PACKAGE_CTE}
       where cur.inventory_item_id <> $2
         and coalesce(wla.location_code, case
               when trim(coalesce(cur.internal_track_code, '')) ~ $3
               then trim(cur.internal_track_code)
               else null end) = $4
       limit 1`,
    [MIDTOWN_DEALER_ID, excludeItemId, WAREHOUSE_LOCATION_CODE_SQL_REGEX, locationCode],
  )
  if (result.rows[0]) {
    return mirrorRowToCandidate(result.rows[0])
  }
  return null
}
