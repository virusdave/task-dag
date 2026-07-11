import {
  LOW_INVENTORY_STALE_AFTER_MINUTES,
  LowInventoryCountRecordSchema,
  type LowInventoryCountClassification,
  type LowInventoryCountRecord,
  type SessionUser,
} from '../../shared/contracts/index.js'
import { getPool, type Queryable } from '../db/pool.js'

interface CapturedCountRow {
  id: string
  request_id: string
  dealer_id: number | string
  inventory_item_id: string
  product_id: number | string
  product_sku: string | null
  product_name: string | null
  physical_qty: number | string
  classification: LowInventoryCountClassification
  resolution_status: 'not-needed' | 'pending'
  actor_user_id: number | string
  actor_email: string
  actor_name: string
  captured_at: Date | string
  sweed_current_qty: number | string
  sweed_hold_qty: number | string | null
  sweed_available_qty: number | string | null
  sweed_stock_location: string
  sweed_internal_track_code: string | null
  sweed_metrc_tag: string | null
  sweed_observed_at: Date | string
}

export class LowInventoryCountCaptureError extends Error {
  constructor(
    readonly statusCode: 404 | 409,
    message: string,
  ) {
    super(message)
    this.name = 'LowInventoryCountCaptureError'
  }
}

export function classifyLowInventoryCount(args: {
  physicalQty: number
  currentQty: number
  holdQty: number | null
}): LowInventoryCountClassification {
  if (args.physicalQty === args.currentQty) return 'equal'
  if (args.physicalQty === 0 && (args.holdQty ?? 0) > 0) return 'zero-held'
  if (args.physicalQty === 0) return 'zero'
  if (args.physicalQty < args.currentQty) return 'short'
  return 'over'
}

const CAPTURE_COUNT_SQL = `
  with capture_input as (
    select $3::numeric(12, 3) as physical_qty
  ), package_snapshot as (
    select
      c.dealer_id,
      c.inventory_item_id,
      c.product_id,
      nullif(btrim(c.product_sku), '') as product_sku,
      c.product_name,
      c.current_qty,
      c.hold_qty,
      c.available_qty,
      c.stock_location,
      c.internal_track_code,
      c.metrc_tag,
      c.observed_at_max
    from sweed_package_current c
    where c.dealer_id = $1
      and c.inventory_item_id = $2
      and c.observed_at_max >= now() - make_interval(mins => $8)
      and c.product_id is not null
      and c.current_qty is not null
      and c.is_on_stock = true
      and c.stock_location ilike 'FOR SALE%'
      and coalesce(lower(c.raw_json->>'enabled') = 'false', false) = false
      and coalesce(lower(c.raw_json->>'isTradeSample') = 'true', false) = false
      and coalesce(lower(c.raw_json->>'isNotForSale') = 'true', false) = false
      and coalesce(c.product_name, '') !~* '^\\s*(DEAD|DELETED|RETIRED)\\b'
      and coalesce(c.product_sku, '') !~* '^\\s*(DEAD|DELETED|RETIRED)\\b'
      and coalesce(c.brand_name, '') !~* '^\\s*(DEAD|DELETED|RETIRED)\\b'
  ), inserted as (
    insert into low_inventory_physical_counts (
      request_id,
      dealer_id,
      inventory_item_id,
      product_id,
      product_sku,
      product_name,
      physical_qty,
      classification,
      resolution_status,
      actor_user_id,
      actor_email,
      actor_name,
      sweed_current_qty,
      sweed_hold_qty,
      sweed_available_qty,
      sweed_stock_location,
      sweed_internal_track_code,
      sweed_metrc_tag,
      sweed_observed_at
    )
    select
      $4,
      p.dealer_id,
      p.inventory_item_id,
      p.product_id,
      p.product_sku,
      p.product_name,
      i.physical_qty,
      case
        when i.physical_qty = p.current_qty then 'equal'
        when i.physical_qty = 0 and coalesce(p.hold_qty, 0) > 0 then 'zero-held'
        when i.physical_qty = 0 then 'zero'
        when i.physical_qty < p.current_qty then 'short'
        else 'over'
      end,
      case when i.physical_qty = p.current_qty then 'not-needed' else 'pending' end,
      $5,
      $6,
      $7,
      p.current_qty,
      p.hold_qty,
      p.available_qty,
      p.stock_location,
      p.internal_track_code,
      p.metrc_tag,
      p.observed_at_max
    from package_snapshot p
    cross join capture_input i
    on conflict (request_id) do nothing
    returning *
  )
  select * from inserted
`

const FIND_REPLAY_SQL = `
  select *
  from low_inventory_physical_counts
  where request_id = $1
    and actor_user_id = $2
    and dealer_id = $3
    and inventory_item_id = $4
    and physical_qty = $5::numeric(12, 3)
`

const REQUEST_ID_EXISTS_SQL = `
  select exists(
    select 1 from low_inventory_physical_counts where request_id = $1
  ) as exists
`

function numberValue(value: number | string, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field} in captured count.`)
  return parsed
}

function nullableNumber(value: number | string | null, field: string): number | null {
  return value === null ? null : numberValue(value, field)
}

function isoTimestamp(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ${field} in captured count.`)
  return parsed.toISOString()
}

function mapCapturedCount(row: CapturedCountRow): LowInventoryCountRecord {
  return LowInventoryCountRecordSchema.parse({
    id: row.id,
    requestId: row.request_id,
    dealerId: numberValue(row.dealer_id, 'dealer_id'),
    inventoryItemId: row.inventory_item_id,
    productId: numberValue(row.product_id, 'product_id'),
    productSku: row.product_sku,
    productName: row.product_name,
    physicalQty: numberValue(row.physical_qty, 'physical_qty'),
    classification: row.classification,
    resolutionStatus: row.resolution_status,
    actor: {
      userId: numberValue(row.actor_user_id, 'actor_user_id'),
      email: row.actor_email,
      name: row.actor_name,
    },
    capturedAt: isoTimestamp(row.captured_at, 'captured_at'),
    sweedSnapshot: {
      currentQty: numberValue(row.sweed_current_qty, 'sweed_current_qty'),
      holdQty: nullableNumber(row.sweed_hold_qty, 'sweed_hold_qty'),
      availableQty: nullableNumber(row.sweed_available_qty, 'sweed_available_qty'),
      stockLocation: row.sweed_stock_location,
      internalTrackCode: row.sweed_internal_track_code,
      metrcTag: row.sweed_metrc_tag,
      observedAt: isoTimestamp(row.sweed_observed_at, 'sweed_observed_at'),
    },
  })
}

export async function captureLowInventoryCount(args: {
  actor: SessionUser
  dealerId: number
  inventoryItemId: string
  physicalQty: number
  requestId: string
  db?: Queryable
}): Promise<LowInventoryCountRecord> {
  const db = args.db ?? getPool()
  const result = await db.query<CapturedCountRow>(CAPTURE_COUNT_SQL, [
    args.dealerId,
    args.inventoryItemId,
    args.physicalQty,
    args.requestId,
    args.actor.id,
    args.actor.email,
    args.actor.name,
    LOW_INVENTORY_STALE_AFTER_MINUTES,
  ])
  const row = result.rows[0]
  if (row !== undefined) return mapCapturedCount(row)

  // ON CONFLICT may have waited on a concurrent identical request. A second
  // statement gets a fresh Read Committed snapshot and can now see the winner.
  // Bind every request-defining field so UUID reuse can never leak another
  // actor's count or falsely claim a changed payload was recorded.
  const replay = await db.query<CapturedCountRow>(FIND_REPLAY_SQL, [
    args.requestId,
    args.actor.id,
    args.dealerId,
    args.inventoryItemId,
    args.physicalQty,
  ])
  if (replay.rows[0] !== undefined) return mapCapturedCount(replay.rows[0])

  const requestIdExists = await db.query<{ exists: boolean }>(REQUEST_ID_EXISTS_SQL, [args.requestId])
  if (requestIdExists.rows[0]?.exists === true) {
    throw new LowInventoryCountCaptureError(
      409,
      'That count request identifier was already used for different count details. Start a new count.',
    )
  }
  throw new LowInventoryCountCaptureError(
    404,
    'That package is no longer an in-stock, for-sale package with a current Sweed quantity. Reload the queue before recording a count.',
  )
}
