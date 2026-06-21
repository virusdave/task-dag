import type { QueryResultRow } from 'pg'

import type {
  PurchaseLifecycleItem,
  PurchaseLifecyclePath,
  PurchaseLifecycleRun,
  PurchaseLifecycleState,
} from '../../shared/contracts/index.js'
import type { Queryable } from '../db/pool.js'

// ---------------------------------------------------------------------------
// DB access for the purchase inventory pricing-safety lifecycle (L1).
// All state mutations go through updateRunState() with an optimistic
// version predicate so concurrent route calls / a future advance job
// cannot stomp each other.
// ---------------------------------------------------------------------------

/**
 * True only once migration 095 has landed. Lets the routes degrade to a
 * clean 409 (and the panel to a "pending migration" note) instead of a
 * raw SQL error when the code has shipped ahead of the migration.
 */
export async function lifecycleTablesExist(db: Queryable): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `select to_regclass('public.purchase_inventory_lifecycle_runs') is not null as exists`,
  )
  return result.rows[0]?.exists === true
}

export interface LifecycleSchemaCaps {
  /** Migration 095 applied: the lifecycle tables exist. */
  runsTable: boolean
  /** Migration 096 applied: the L2 release columns exist. */
  releaseColumns: boolean
}

/**
 * Probe which lifecycle migrations are live so the service can keep L1
 * working when 095 is applied but the L2 release migration 096 is not yet
 * (the columns are selected conditionally — selecting a missing column
 * would raw-error). Cheap catalog lookups; the service caches the result.
 */
export async function getLifecycleSchemaCaps(db: Queryable): Promise<LifecycleSchemaCaps> {
  // Require a release column on BOTH the runs and items tables: getRunByPo
  // with includeRelease selects release columns from each, so a partial 096
  // apply (one table altered, the other not) must NOT be treated as ready.
  const result = await db.query<{ runs_table: boolean; release_columns: boolean }>(
    `select
       to_regclass('public.purchase_inventory_lifecycle_runs') is not null as runs_table,
       (
         exists (
           select 1 from information_schema.columns
           where table_name = 'purchase_inventory_lifecycle_runs'
             and column_name = 'release_attempt_id'
         )
         and exists (
           select 1 from information_schema.columns
           where table_name = 'purchase_inventory_lifecycle_items'
             and column_name = 'release_verified_at'
         )
       ) as release_columns`,
  )
  const row = result.rows[0]
  return {
    runsTable: row?.runs_table === true,
    releaseColumns: row?.release_columns === true,
  }
}

export interface ExpectedLotRow {
  lineId: string
  inventoryItemId: string
  sweedProductId: number
  metrcTag: string | null
  expectedQty: number | null
}

export interface PurchaseExpectedScope {
  /** Distinct, sorted product ids of positive-qty, product-mapped lines. */
  productIds: number[]
  /** One expected lot per matched inventory item (deduped). */
  lots: ExpectedLotRow[]
  /** Positive-qty product-mapped lines that have no matched lot. */
  productMappedLineCountWithoutLots: number
  /** Positive-qty lines that have no sweed_product_id at all. */
  unmappedPositiveLineCount: number
}

interface ExpectedLineRow extends QueryResultRow {
  line_id: string
  sweed_product_id: string | null
  metrc_tag: string | null
  ordered_units: string | number | null
  matched_inventory_item_ids: string[]
}

/**
 * Derive the lifecycle's expected product/lot scope from the purchase's
 * mirrored line items: positive-qty lines, their distinct mapped product
 * ids, and one lot row per matched inventory item.
 */
export async function getPurchaseExpectedScope(
  db: Queryable,
  dealerId: number,
  poId: string,
): Promise<PurchaseExpectedScope> {
  const result = await db.query<ExpectedLineRow>(
    `
      select
        line_id,
        sweed_product_id,
        metrc_tag,
        ordered_units,
        matched_inventory_item_ids
      from sweed_purchase_line_items
      where dealer_id = $1
        and po_id = $2
        and coalesce(ordered_units, 0) > 0
      order by line_index asc
    `,
    [dealerId, poId],
  )

  const productIdSet = new Set<number>()
  const lots: ExpectedLotRow[] = []
  const seenInventoryItemIds = new Set<string>()
  let productMappedLineCountWithoutLots = 0
  let unmappedPositiveLineCount = 0

  for (const row of result.rows) {
    const productId = row.sweed_product_id === null ? null : Number(row.sweed_product_id)
    if (productId === null || !Number.isFinite(productId)) {
      unmappedPositiveLineCount += 1
      continue
    }
    productIdSet.add(productId)

    const matched = (row.matched_inventory_item_ids ?? []).filter((id) => id.length > 0)
    if (matched.length === 0) {
      productMappedLineCountWithoutLots += 1
      continue
    }
    const expectedQty = row.ordered_units === null ? null : Number(row.ordered_units)
    for (const inventoryItemId of matched) {
      if (seenInventoryItemIds.has(inventoryItemId)) continue
      seenInventoryItemIds.add(inventoryItemId)
      lots.push({
        lineId: row.line_id,
        inventoryItemId,
        sweedProductId: productId,
        metrcTag: row.metrc_tag,
        expectedQty: Number.isFinite(expectedQty as number) ? (expectedQty as number) : null,
      })
    }
  }

  return {
    productIds: [...productIdSet].sort((a, b) => a - b),
    lots,
    productMappedLineCountWithoutLots,
    unmappedPositiveLineCount,
  }
}

interface RunRow extends QueryResultRow {
  id: string
  dealer_id: string
  po_id: string
  site_key: string
  path: PurchaseLifecyclePath
  state: PurchaseLifecycleState
  blocked_reason: string | null
  market_requested_at: Date | null
  pricing_batch_id: string | null
  expected_product_ids: string[]
  version: number
  created_by_user_id: string | null
  notes: string | null
  created_at: Date
  updated_at: Date
  // L2 release fields — only present when migration 096 is applied AND
  // the column set was selected (getRunByPo includeRelease=true).
  release_target_location_id?: string | null
  release_target_location_name?: string | null
  release_target_stock_type_id?: string | null
  release_requested_at?: Date | null
  released_at?: Date | null
  release_attempt_id?: string | null
  release_lease_expires_at?: Date | null
  release_last_error?: string | null
}

interface ItemRow extends QueryResultRow {
  id: string
  line_id: string
  inventory_item_id: string
  sweed_product_id: string
  metrc_tag: string | null
  expected_qty: string | null
  quarantine_verified_at: Date | null
  quarantine_stock_location: string | null
  quarantine_current_qty: string | null
  market_observation_id: string | null
  market_observation_captured_at: Date | null
  market_ready_at: Date | null
  price_applied_verified_at: Date | null
  approved_price_dollars: string | null
  live_price_dollars: string | null
  notes: string | null
  // L2 release fields — only present when migration 096 is applied AND
  // selected (includeRelease=true).
  release_transfer_attempted_at?: Date | null
  release_transferred_at?: Date | null
  release_verified_at?: Date | null
  release_stock_location?: string | null
  release_stock_location_id?: string | null
  release_stock_type_id?: string | null
  release_current_qty?: string | null
  release_last_error?: string | null
}

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function iso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString()
}

function mapItemRow(row: ItemRow): PurchaseLifecycleItem {
  return {
    id: Number(row.id),
    lineId: row.line_id,
    inventoryItemId: row.inventory_item_id,
    sweedProductId: Number(row.sweed_product_id),
    metrcTag: row.metrc_tag,
    expectedQty: num(row.expected_qty),
    quarantineVerifiedAt: iso(row.quarantine_verified_at),
    quarantineStockLocation: row.quarantine_stock_location,
    quarantineCurrentQty: num(row.quarantine_current_qty),
    marketObservationCapturedAt: iso(row.market_observation_captured_at),
    marketReadyAt: iso(row.market_ready_at),
    priceAppliedVerifiedAt: iso(row.price_applied_verified_at),
    approvedPriceDollars: num(row.approved_price_dollars),
    livePriceDollars: num(row.live_price_dollars),
    releaseTransferAttemptedAt: iso(row.release_transfer_attempted_at),
    releaseTransferredAt: iso(row.release_transferred_at),
    releaseVerifiedAt: iso(row.release_verified_at),
    releaseStockLocation: row.release_stock_location ?? null,
    releaseCurrentQty: num(row.release_current_qty),
    releaseLastError: row.release_last_error ?? null,
    notes: row.notes,
  }
}

function mapRunRow(row: RunRow, items: PurchaseLifecycleItem[]): PurchaseLifecycleRun {
  return {
    id: Number(row.id),
    dealerId: Number(row.dealer_id),
    poId: row.po_id,
    siteKey: row.site_key,
    path: row.path,
    state: row.state,
    blockedReason: row.blocked_reason,
    marketRequestedAt: iso(row.market_requested_at),
    pricingBatchId: row.pricing_batch_id === null ? null : Number(row.pricing_batch_id),
    expectedProductIds: (row.expected_product_ids ?? []).map((id) => Number(id)),
    version: row.version,
    createdByUserId: row.created_by_user_id === null ? null : Number(row.created_by_user_id),
    notes: row.notes,
    releaseTargetLocationId: num(row.release_target_location_id),
    releaseTargetLocationName: row.release_target_location_name ?? null,
    releaseRequestedAt: iso(row.release_requested_at),
    releasedAt: iso(row.released_at),
    releaseLastError: row.release_last_error ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    items,
  }
}

const RUN_COLUMNS_BASE = `
  id, dealer_id, po_id, site_key, path, state, blocked_reason,
  market_requested_at, pricing_batch_id, expected_product_ids, version,
  created_by_user_id, notes, created_at, updated_at
`

// L2 release columns (migration 096). Selected only when includeRelease,
// so L1 keeps working in the "095 applied, 096 pending" window.
const RUN_COLUMNS_RELEASE = `
  , release_target_location_id, release_target_location_name,
  release_target_stock_type_id, release_requested_at, released_at,
  release_attempt_id, release_lease_expires_at, release_last_error
`

const ITEM_COLUMNS_BASE = `
  id, line_id, inventory_item_id, sweed_product_id, metrc_tag, expected_qty,
  quarantine_verified_at, quarantine_stock_location, quarantine_current_qty,
  market_observation_id, market_observation_captured_at, market_ready_at,
  price_applied_verified_at, approved_price_dollars, live_price_dollars, notes
`

const ITEM_COLUMNS_RELEASE = `
  , release_transfer_attempted_at, release_transferred_at, release_verified_at,
  release_stock_location, release_stock_location_id, release_stock_type_id,
  release_current_qty, release_last_error
`

function runColumns(includeRelease: boolean): string {
  return includeRelease ? `${RUN_COLUMNS_BASE}${RUN_COLUMNS_RELEASE}` : RUN_COLUMNS_BASE
}

function itemColumns(includeRelease: boolean): string {
  return includeRelease ? `${ITEM_COLUMNS_BASE}${ITEM_COLUMNS_RELEASE}` : ITEM_COLUMNS_BASE
}

export async function getRunItems(
  db: Queryable,
  runId: number,
  includeRelease: boolean,
): Promise<PurchaseLifecycleItem[]> {
  const result = await db.query<ItemRow>(
    `select ${itemColumns(includeRelease)} from purchase_inventory_lifecycle_items
      where run_id = $1 order by id asc`,
    [runId],
  )
  return result.rows.map(mapItemRow)
}

export async function getRunByPo(
  db: Queryable,
  dealerId: number,
  poId: string,
  includeRelease: boolean,
): Promise<PurchaseLifecycleRun | null> {
  const result = await db.query<RunRow>(
    `select ${runColumns(includeRelease)} from purchase_inventory_lifecycle_runs
      where dealer_id = $1 and po_id = $2`,
    [dealerId, poId],
  )
  const row = result.rows[0]
  if (!row) return null
  const items = await getRunItems(db, Number(row.id), includeRelease)
  return mapRunRow(row, items)
}

/**
 * Lock the run row FOR UPDATE inside a transaction and assert the
 * caller's expected version. Returns null when the run is missing or the
 * version has moved on (the route maps that to a 409). Returns the raw
 * row so the caller can read current fields without remapping.
 */
export interface LockedRun {
  id: number
  version: number
  state: PurchaseLifecycleState
  path: PurchaseLifecyclePath
  pricingBatchId: number | null
  expectedProductIds: number[]
  marketRequestedAt: Date | null
  releaseAttemptId: string | null
  releaseLeaseExpiresAt: Date | null
  releaseTargetLocationId: number | null
  releaseTargetStockTypeId: number | null
  releaseTargetLocationName: string | null
}

function mapLockedRun(row: RunRow): LockedRun {
  return {
    id: Number(row.id),
    version: row.version,
    state: row.state,
    path: row.path,
    pricingBatchId: row.pricing_batch_id === null ? null : Number(row.pricing_batch_id),
    expectedProductIds: (row.expected_product_ids ?? []).map((id) => Number(id)),
    marketRequestedAt: row.market_requested_at,
    releaseAttemptId: row.release_attempt_id ?? null,
    releaseLeaseExpiresAt: row.release_lease_expires_at ?? null,
    releaseTargetLocationId: num(row.release_target_location_id),
    releaseTargetStockTypeId: num(row.release_target_stock_type_id),
    releaseTargetLocationName: row.release_target_location_name ?? null,
  }
}

export async function lockRunForUpdate(
  db: Queryable,
  dealerId: number,
  poId: string,
  expectedVersion: number,
  includeRelease = false,
): Promise<LockedRun | null> {
  const result = await db.query<RunRow>(
    `select ${runColumns(includeRelease)} from purchase_inventory_lifecycle_runs
      where dealer_id = $1 and po_id = $2 for update`,
    [dealerId, poId],
  )
  const row = result.rows[0]
  if (!row || row.version !== expectedVersion) return null
  return mapLockedRun(row)
}

/**
 * Like lockRunForUpdate but WITHOUT a version predicate — used to finalize
 * a release attempt, which keys on the release_attempt_id (not the stale
 * UI version, which the claim step already bumped). Always selects the
 * release columns. Returns null only when the run row is missing.
 */
export async function lockRunForRelease(
  db: Queryable,
  dealerId: number,
  poId: string,
): Promise<LockedRun | null> {
  const result = await db.query<RunRow>(
    `select ${runColumns(true)} from purchase_inventory_lifecycle_runs
      where dealer_id = $1 and po_id = $2 for update`,
    [dealerId, poId],
  )
  const row = result.rows[0]
  if (!row) return null
  return mapLockedRun(row)
}

export interface CreateRunInput {
  dealerId: number
  poId: string
  siteKey: string
  path: PurchaseLifecyclePath
  state: PurchaseLifecycleState
  expectedProductIds: number[]
  lots: ExpectedLotRow[]
  createdByUserId: number | null
  notes: string | null
}

/** Insert a new run + its expected lot rows. Caller wraps in a tx. */
export async function createRun(db: Queryable, input: CreateRunInput): Promise<number> {
  const runResult = await db.query<{ id: string }>(
    `
      insert into purchase_inventory_lifecycle_runs
        (dealer_id, po_id, site_key, path, state, expected_product_ids,
         created_by_user_id, notes)
      values ($1, $2, $3, $4, $5, $6::bigint[], $7, $8)
      returning id
    `,
    [
      input.dealerId,
      input.poId,
      input.siteKey,
      input.path,
      input.state,
      input.expectedProductIds,
      input.createdByUserId,
      input.notes,
    ],
  )
  const runId = Number(runResult.rows[0]!.id)

  for (const lot of input.lots) {
    await db.query(
      `
        insert into purchase_inventory_lifecycle_items
          (run_id, dealer_id, po_id, line_id, inventory_item_id,
           sweed_product_id, metrc_tag, expected_qty)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (run_id, inventory_item_id) do nothing
      `,
      [
        runId,
        input.dealerId,
        input.poId,
        lot.lineId,
        lot.inventoryItemId,
        lot.sweedProductId,
        lot.metrcTag,
        lot.expectedQty,
      ],
    )
  }

  return runId
}

export interface UpdateRunStateInput {
  runId: number
  expectedVersion: number
  state: PurchaseLifecycleState
  blockedReason?: string | null
  marketRequestedAt?: Date | null
  pricingBatchId?: number | null
}

/**
 * Optimistic-concurrency state transition: bumps version and updates
 * updated_at only when the row still carries expectedVersion. Returns
 * true on success, false when the version moved (stale → 409). Only the
 * fields explicitly provided are written.
 */
export async function updateRunState(db: Queryable, input: UpdateRunStateInput): Promise<boolean> {
  const sets: string[] = ['state = $3', 'version = version + 1', 'updated_at = now()']
  const params: unknown[] = [input.runId, input.expectedVersion, input.state]
  let next = 4

  // blocked_reason must be cleared when leaving 'blocked' and set when
  // entering it; always write it from the provided value (defaulting to
  // null for non-blocked states) so the check constraint holds.
  sets.push(`blocked_reason = $${next}`)
  params.push(input.state === 'blocked' ? (input.blockedReason ?? 'blocked') : null)
  next += 1

  if (input.marketRequestedAt !== undefined) {
    sets.push(`market_requested_at = $${next}`)
    params.push(input.marketRequestedAt)
    next += 1
  }
  if (input.pricingBatchId !== undefined) {
    sets.push(`pricing_batch_id = $${next}`)
    params.push(input.pricingBatchId)
    next += 1
  }

  const result = await db.query(
    `update purchase_inventory_lifecycle_runs
        set ${sets.join(', ')}
      where id = $1 and version = $2`,
    params,
  )
  return (result.rowCount ?? 0) > 0
}

export interface QuarantineItemUpdate {
  itemId: number
  verifiedAt: Date | null
  stockLocation: string | null
  currentQty: number | null
}

export async function updateItemQuarantine(
  db: Queryable,
  update: QuarantineItemUpdate,
): Promise<void> {
  await db.query(
    `update purchase_inventory_lifecycle_items
        set quarantine_verified_at = $2,
            quarantine_stock_location = $3,
            quarantine_current_qty = $4,
            updated_at = now()
      where id = $1`,
    [update.itemId, update.verifiedAt, update.stockLocation, update.currentQty],
  )
}

export interface MarketItemUpdate {
  itemId: number
  observationId: number | null
  capturedAt: Date | null
  readyAt: Date | null
}

export async function updateItemMarket(db: Queryable, update: MarketItemUpdate): Promise<void> {
  await db.query(
    `update purchase_inventory_lifecycle_items
        set market_observation_id = $2,
            market_observation_captured_at = $3,
            market_ready_at = $4,
            updated_at = now()
      where id = $1`,
    [update.itemId, update.observationId, update.capturedAt, update.readyAt],
  )
}

export interface PriceItemUpdate {
  itemId: number
  verifiedAt: Date | null
  approvedPriceDollars: number | null
  livePriceDollars: number | null
}

export async function updateItemPrice(db: Queryable, update: PriceItemUpdate): Promise<void> {
  await db.query(
    `update purchase_inventory_lifecycle_items
        set price_applied_verified_at = $2,
            approved_price_dollars = $3,
            live_price_dollars = $4,
            updated_at = now()
      where id = $1`,
    [update.itemId, update.verifiedAt, update.approvedPriceDollars, update.livePriceDollars],
  )
}

// ----------------------------- Release (L2) --------------------------------

export interface ClaimReleaseInput {
  runId: number
  expectedVersion: number
  attemptId: string
  leaseExpiresAt: Date
  targetLocationId: number
  targetLocationName: string
  targetStockTypeId: number
}

/**
 * Claim a release attempt: move the run to release_in_progress, stamp the
 * chosen FOR SALE target, mint a new attempt id + lease, and bump version
 * (so the operator's stale tab can't re-submit). Optimistic on
 * expectedVersion; returns false if the version moved (stale → 409).
 */
export async function claimReleaseAttempt(db: Queryable, input: ClaimReleaseInput): Promise<boolean> {
  const result = await db.query(
    `update purchase_inventory_lifecycle_runs
        set state = 'release_in_progress',
            blocked_reason = null,
            release_target_location_id = $3,
            release_target_location_name = $4,
            release_target_stock_type_id = $5,
            release_attempt_id = $6,
            release_lease_expires_at = $7,
            release_requested_at = coalesce(release_requested_at, now()),
            release_last_error = null,
            version = version + 1,
            updated_at = now()
      where id = $1 and version = $2`,
    [
      input.runId,
      input.expectedVersion,
      input.targetLocationId,
      input.targetLocationName,
      input.targetStockTypeId,
      input.attemptId,
      input.leaseExpiresAt,
    ],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Heartbeat: extend the lease, but ONLY while this attempt still owns the
 * run (release_attempt_id matches and state is still release_in_progress).
 * Returns false if another attempt took over (the loop must then abort).
 */
export async function extendReleaseLease(
  db: Queryable,
  runId: number,
  attemptId: string,
  leaseExpiresAt: Date,
): Promise<boolean> {
  const result = await db.query(
    `update purchase_inventory_lifecycle_runs
        set release_lease_expires_at = $3, updated_at = now()
      where id = $1
        and release_attempt_id = $2
        and state = 'release_in_progress'`,
    [runId, attemptId, leaseExpiresAt],
  )
  return (result.rowCount ?? 0) > 0
}

export interface FinalizeReleaseInput {
  runId: number
  attemptId: string
  state: PurchaseLifecycleState
  blockedReason?: string | null
  releasedAt?: Date | null
  releaseLastError?: string | null
}

/**
 * Finalize a release attempt. Keys on release_attempt_id (NOT version):
 * the claim bumped version, and a zombie attempt whose lease expired and
 * was taken over must NOT be able to finalize. Single-use: it also
 * requires the run to still be release_in_progress and CLEARS the attempt
 * id, so a second finalize for the same attempt is a no-op (no duplicate
 * version bump). Returns false if this attempt no longer owns the run.
 */
export async function finalizeReleaseRun(db: Queryable, input: FinalizeReleaseInput): Promise<boolean> {
  const blockedReason = input.state === 'blocked' ? (input.blockedReason ?? 'blocked') : null
  const result = await db.query(
    `update purchase_inventory_lifecycle_runs
        set state = $3,
            blocked_reason = $4,
            released_at = $5,
            release_last_error = $6,
            release_attempt_id = null,
            release_lease_expires_at = null,
            version = version + 1,
            updated_at = now()
      where id = $1 and release_attempt_id = $2 and state = 'release_in_progress'`,
    [
      input.runId,
      input.attemptId,
      input.state,
      blockedReason,
      input.releasedAt ?? null,
      input.releaseLastError ?? null,
    ],
  )
  return (result.rowCount ?? 0) > 0
}

export interface ReleaseItemUpdate {
  itemId: number
  /**
   * The attempt that owns this write. The update only applies while the
   * item's run is still release_in_progress under this exact attempt id,
   * so a zombie attempt whose lease expired (and was taken over) can never
   * clobber the live attempt's per-lot evidence. Returns false on a lost
   * write so the caller can abort.
   */
  attemptId: string
  transferAttemptedAt: Date | null
  transferredAt: Date | null
  verifiedAt: Date | null
  stockLocation: string | null
  stockLocationId: number | null
  stockTypeId: number | null
  currentQty: number | null
  lastError: string | null
}

export async function updateItemRelease(db: Queryable, update: ReleaseItemUpdate): Promise<boolean> {
  const result = await db.query(
    `update purchase_inventory_lifecycle_items i
        set release_transfer_attempted_at = $2,
            release_transferred_at = $3,
            release_verified_at = $4,
            release_stock_location = $5,
            release_stock_location_id = $6,
            release_stock_type_id = $7,
            release_current_qty = $8,
            release_last_error = $9,
            updated_at = now()
      where i.id = $1
        and exists (
          select 1 from purchase_inventory_lifecycle_runs r
           where r.id = i.run_id
             and r.release_attempt_id = $10
             and r.state = 'release_in_progress'
        )`,
    [
      update.itemId,
      update.transferAttemptedAt,
      update.transferredAt,
      update.verifiedAt,
      update.stockLocation,
      update.stockLocationId,
      update.stockTypeId,
      update.currentQty,
      update.lastError,
      update.attemptId,
    ],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Claim a ROLLBACK before any physical move-back. Like the release claim
 * it CAS-bumps version (so a concurrent "continue release" can no longer
 * win its own optimistic claim) and stamps a fresh attempt id + lease, but
 * it deliberately leaves `state` untouched (released / blocked) — there is
 * no dedicated rollback-in-progress state in the schema. The final
 * `resetReleaseRun` keys on this attempt id, so the slow Sweed move-back
 * cannot race a concurrent continue/rollback into an inconsistent run.
 */
export async function claimRollbackAttempt(
  db: Queryable,
  input: { runId: number; expectedVersion: number; attemptId: string; leaseExpiresAt: Date },
): Promise<boolean> {
  const result = await db.query(
    `update purchase_inventory_lifecycle_runs
        set release_attempt_id = $3,
            release_lease_expires_at = $4,
            version = version + 1,
            updated_at = now()
      where id = $1 and version = $2`,
    [input.runId, input.expectedVersion, input.attemptId, input.leaseExpiresAt],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Roll a run back out of a (partial/failed) release: reset the run to a
 * pre-release state and clear ALL release evidence on the run and its
 * items, so a fresh release attempt starts clean. Keys on the rollback
 * attempt id stamped by `claimRollbackAttempt` (NOT version, which the
 * claim already bumped), so it is single-use and cannot be applied by a
 * stale caller.
 */
export async function resetReleaseRun(
  db: Queryable,
  input: { runId: number; attemptId: string; state: PurchaseLifecycleState; blockedReason?: string | null },
): Promise<boolean> {
  const blockedReason = input.state === 'blocked' ? (input.blockedReason ?? 'blocked') : null
  const result = await db.query(
    `update purchase_inventory_lifecycle_runs
        set state = $3,
            blocked_reason = $4,
            release_attempt_id = null,
            release_lease_expires_at = null,
            release_requested_at = null,
            released_at = null,
            release_target_location_id = null,
            release_target_location_name = null,
            release_target_stock_type_id = null,
            release_last_error = null,
            version = version + 1,
            updated_at = now()
      where id = $1 and release_attempt_id = $2`,
    [input.runId, input.attemptId, input.state, blockedReason],
  )
  if ((result.rowCount ?? 0) === 0) return false
  await db.query(
    `update purchase_inventory_lifecycle_items
        set release_transfer_attempted_at = null,
            release_transferred_at = null,
            release_verified_at = null,
            release_stock_location = null,
            release_stock_location_id = null,
            release_stock_type_id = null,
            release_current_qty = null,
            release_last_error = null,
            updated_at = now()
      where run_id = $1`,
    [input.runId],
  )
  return true
}

export interface SucceededObservation {
  observationId: number
  capturedAt: Date
}

/**
 * For each product id, the most recent SUCCEEDED competitor observation
 * captured strictly after the cutoff (the market-ready gate). Products
 * without one are simply absent from the map.
 */
export async function getSucceededObservationsAfter(
  db: Queryable,
  productIds: number[],
  cutoff: Date,
): Promise<Map<number, SucceededObservation>> {
  const out = new Map<number, SucceededObservation>()
  if (productIds.length === 0) return out
  const result = await db.query<{ product_id: string; observation_id: string; captured_at: Date }>(
    `
      select distinct on (o.product_id)
        o.product_id,
        o.id as observation_id,
        o.captured_at
      from litalerts_competitor_observations o
      where o.product_id = any($1::bigint[])
        and o.status = 'succeeded'
        and o.captured_at > $2
      order by o.product_id, o.captured_at desc, o.id desc
    `,
    [productIds, cutoff],
  )
  for (const row of result.rows) {
    out.set(Number(row.product_id), {
      observationId: Number(row.observation_id),
      capturedAt: row.captured_at,
    })
  }
  return out
}

export type ProposalBatchStatus = 'draft' | 'failed' | 'ready' | 'superseded'

/**
 * The lifecycle's linked pricing batch status, so the reprice leg can tell
 * "still generating" (draft) apart from "proposals ready to approve"
 * (ready) and a generation failure (failed/superseded). Null when the
 * batch row is gone (it FKs `on delete set null`, but we read it before
 * that nulls the link).
 */
export async function getProposalBatchStatus(
  db: Queryable,
  batchId: number,
): Promise<ProposalBatchStatus | null> {
  const result = await db.query<{ status: ProposalBatchStatus }>(
    `select status from proposal_batches where id = $1`,
    [batchId],
  )
  return result.rows[0]?.status ?? null
}

/**
 * The approved desired price per product for a pricing batch: the
 * effective value of every approved catalog_product `products.price`
 * line. Products with no approved price line are absent.
 */
export async function getApprovedPricesForBatch(
  db: Queryable,
  pricingBatchId: number,
): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const result = await db.query<{ product_id: string; effective_value_json: unknown }>(
    `
      select
        pli.target_entity_id as product_id,
        pli.effective_value_json
      from proposal_line_items pli
      join proposal_rows pr on pr.id = pli.proposal_row_id
      where pr.proposal_batch_id = $1
        and pli.target_entity_type = 'catalog_product'
        and pli.field_path = 'products.price'
        and pli.approval_status = 'approved'
    `,
    [pricingBatchId],
  )
  for (const row of result.rows) {
    const price = typeof row.effective_value_json === 'number'
      ? row.effective_value_json
      : Number(row.effective_value_json)
    if (Number.isFinite(price)) {
      out.set(Number(row.product_id), price)
    }
  }
  return out
}

export { mapRunRow }
