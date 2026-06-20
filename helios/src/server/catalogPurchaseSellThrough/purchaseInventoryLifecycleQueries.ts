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
}

function num(value: string | number | null): number | null {
  if (value === null) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
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
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    items,
  }
}

const RUN_COLUMNS = `
  id, dealer_id, po_id, site_key, path, state, blocked_reason,
  market_requested_at, pricing_batch_id, expected_product_ids, version,
  created_by_user_id, notes, created_at, updated_at
`

const ITEM_COLUMNS = `
  id, line_id, inventory_item_id, sweed_product_id, metrc_tag, expected_qty,
  quarantine_verified_at, quarantine_stock_location, quarantine_current_qty,
  market_observation_id, market_observation_captured_at, market_ready_at,
  price_applied_verified_at, approved_price_dollars, live_price_dollars, notes
`

export async function getRunItems(db: Queryable, runId: number): Promise<PurchaseLifecycleItem[]> {
  const result = await db.query<ItemRow>(
    `select ${ITEM_COLUMNS} from purchase_inventory_lifecycle_items
      where run_id = $1 order by id asc`,
    [runId],
  )
  return result.rows.map(mapItemRow)
}

export async function getRunByPo(
  db: Queryable,
  dealerId: number,
  poId: string,
): Promise<PurchaseLifecycleRun | null> {
  const result = await db.query<RunRow>(
    `select ${RUN_COLUMNS} from purchase_inventory_lifecycle_runs
      where dealer_id = $1 and po_id = $2`,
    [dealerId, poId],
  )
  const row = result.rows[0]
  if (!row) return null
  const items = await getRunItems(db, Number(row.id))
  return mapRunRow(row, items)
}

/**
 * Lock the run row FOR UPDATE inside a transaction and assert the
 * caller's expected version. Returns null when the run is missing or the
 * version has moved on (the route maps that to a 409). Returns the raw
 * row so the caller can read current fields without remapping.
 */
export async function lockRunForUpdate(
  db: Queryable,
  dealerId: number,
  poId: string,
  expectedVersion: number,
): Promise<{ id: number; version: number; state: PurchaseLifecycleState; path: PurchaseLifecyclePath; pricingBatchId: number | null; expectedProductIds: number[]; marketRequestedAt: Date | null } | null> {
  const result = await db.query<RunRow>(
    `select ${RUN_COLUMNS} from purchase_inventory_lifecycle_runs
      where dealer_id = $1 and po_id = $2 for update`,
    [dealerId, poId],
  )
  const row = result.rows[0]
  if (!row || row.version !== expectedVersion) return null
  return {
    id: Number(row.id),
    version: row.version,
    state: row.state,
    path: row.path,
    pricingBatchId: row.pricing_batch_id === null ? null : Number(row.pricing_batch_id),
    expectedProductIds: (row.expected_product_ids ?? []).map((id) => Number(id)),
    marketRequestedAt: row.market_requested_at,
  }
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
