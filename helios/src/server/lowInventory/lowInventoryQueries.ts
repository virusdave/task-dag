import {
  getHeliosPendingPurchaseSiteDealer,
  isCannabisCategory,
  isValidWarehouseLocationCode,
  LOW_INVENTORY_STALE_AFTER_MINUTES,
  LowInventoryThresholdSchema,
  type LowInventoryLocation,
  type LowInventoryLocationGroup,
  type LowInventoryReadModel,
  type LowInventorySku,
  LowInventoryAuditResultSchema,
  LowInventoryCountBodySchema,
  LowInventoryPackageSchema,
  type LowInventoryAuditResult,
  type LowInventoryCountBody,
  type LowInventoryPackage,
} from '../../shared/contracts/index.js'
import type { Queryable } from '../db/pool.js'
import { getPool } from '../db/pool.js'

interface LowInventoryRow {
  available_qty: number | string
  current_qty: number | string | null
  hold_qty: number | string | null
  internal_track_code: string | null
  inventory_barcode: string | null
  inventory_item_id: string
  metrc_tag: string | null
  observed_at_max: Date | string
  product_id: number | string
  product_name: string | null
  product_sku: string | null
  stock_location: string
}

const LOW_INVENTORY_SQL = `
  select
    c.inventory_item_id,
    c.product_id,
    c.product_name,
    nullif(btrim(c.product_sku), '') as product_sku,
    c.current_qty,
    c.hold_qty,
    c.available_qty,
    c.metrc_tag,
    nullif(btrim(c.raw_json->>'inventoryBarcode'), '') as inventory_barcode,
    c.internal_track_code,
    c.stock_location,
    c.observed_at_max
  from sweed_package_current c
  where c.dealer_id = $1
    and c.is_on_stock = true
    and c.product_id is not null
    and c.available_qty is not null
    and c.stock_location ilike 'FOR SALE%'
    and coalesce(lower(c.raw_json->>'enabled') = 'false', false) = false
    and coalesce(lower(c.raw_json->>'isTradeSample') = 'true', false) = false
    and coalesce(lower(c.raw_json->>'isNotForSale') = 'true', false) = false
    and coalesce(c.product_name, '') !~* '^\\s*(DEAD|DELETED|RETIRED)\\b'
    and coalesce(c.product_sku, '') !~* '^\\s*(DEAD|DELETED|RETIRED)\\b'
    and coalesce(c.brand_name, '') !~* '^\\s*(DEAD|DELETED|RETIRED)\\b'
  order by c.product_id, c.inventory_item_id
`

const LOW_INVENTORY_CATALOG_PRODUCTS_SQL = `
  select distinct on ((product->>'productId')::bigint)
    (product->>'productId')::bigint as product_id,
    nullif(btrim(cg.category_name), '') as category_name,
    nullif(btrim(product->>'imageUrl'), '') as image_url,
    nullif(btrim(product->>'name'), '') as product_name,
    nullif(btrim(product->>'sku'), '') as product_sku,
    nullif(btrim(cg.subcategory_name), '') as subcategory_name,
    (
      cg.deleted_at is null
      and coalesce(lower(product->>'enabled') = 'false', false) = false
      and coalesce(product->>'name', '') !~* '^\\s*(DEAD|DELETED|RETIRED)\\b'
      and coalesce(product->>'sku', '') !~* '^\\s*(DEAD|DELETED|RETIRED)\\b'
      and coalesce(cg.brand_name, '') !~* '^\\s*(DEAD|DELETED|RETIRED)\\b'
    ) as active
  from catalog_groups cg
  cross join lateral jsonb_array_elements(cg.live_state_json->'products') product
  where (product->>'productId') ~ '^[0-9]+$'
    and (product->>'productId')::bigint = any($1::bigint[])
  order by
    (product->>'productId')::bigint,
    active desc,
    cg.updated_at desc nulls last
`

interface LowInventoryCatalogProductRow {
  active: boolean
  category_name: string | null
  image_url: string | null
  product_id: number | string
  product_name: string | null
  product_sku: string | null
  subcategory_name: string | null
}

function numeric(value: number | string, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${field} in low-inventory snapshot row.`)
  }
  return parsed
}

function positiveInteger(value: number | string, field: string): number {
  const parsed = numeric(value, field)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${field} in low-inventory snapshot row.`)
  }
  return parsed
}

function nullableNumeric(value: number | string | null, field: string): number | null {
  return value === null ? null : numeric(value, field)
}

function isoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid observed_at_max in low-inventory snapshot row.')
  }
  return date.toISOString()
}

function locationForRow(row: LowInventoryRow): LowInventoryLocation {
  const shelfCode = row.internal_track_code?.trim() ?? null
  if (shelfCode !== null && isValidWarehouseLocationCode(shelfCode)) {
    return { kind: 'shelf', label: shelfCode }
  }
  return { kind: 'stock-room', label: row.stock_location }
}

function locationKey(location: LowInventoryLocation): string {
  return `${location.kind}:${location.label}`
}

function compareLabels(left: string, right: string): number {
  return left.localeCompare(right, 'en-US', { numeric: true })
}

export function buildLowInventoryReadModel(args: {
  catalogProducts?: readonly LowInventoryCatalogProductRow[]
  dealerId: number
  now?: Date
  rows: readonly LowInventoryRow[]
  threshold: number
}): LowInventoryReadModel {
  const catalogProducts = new Map(
    (args.catalogProducts ?? []).map((product) => [String(product.product_id), product]),
  )
  const groupsByLocation = new Map<
    string,
    { location: LowInventoryLocation; skus: Map<string, LowInventorySku> }
  >()
  let snapshotObservedAt: string | null = null
  const resolvedRows: Array<{
    observedAt: string
    productId: number
    productKey: string
    productName: string | null
    productSku: string | null
    row: LowInventoryRow
  }> = []
  const combinedAvailableByProduct = new Map<string, number>()
  const staleProducts = new Set<string>()

  for (const row of args.rows) {
    const catalogProduct = catalogProducts.get(String(row.product_id))
    if (catalogProduct?.active === false) {
      continue
    }
    const observedAt = isoTimestamp(row.observed_at_max)
    if (snapshotObservedAt === null || observedAt > snapshotObservedAt) {
      snapshotObservedAt = observedAt
    }
    const productId = positiveInteger(row.product_id, 'product_id')
    const productSku = row.product_sku ?? catalogProduct?.product_sku ?? null
    const productKey = productSku === null ? `product-id:${productId}` : `sku:${productSku}`
    const productName = row.product_name ?? catalogProduct?.product_name ?? null
    const availableQty = numeric(row.available_qty, 'available_qty')
    if (
      args.now !== undefined &&
      args.now.getTime() - new Date(observedAt).getTime() > LOW_INVENTORY_STALE_AFTER_MINUTES * 60_000
    ) {
      staleProducts.add(productKey)
    }
    combinedAvailableByProduct.set(
      productKey,
      (combinedAvailableByProduct.get(productKey) ?? 0) + availableQty,
    )
    resolvedRows.push({ observedAt, productId, productKey, productName, productSku, row })
  }

  for (const { observedAt, productId, productKey, productName, productSku, row } of resolvedRows) {
    const combinedAvailableQty = combinedAvailableByProduct.get(productKey)
    if (
      combinedAvailableQty === undefined ||
      staleProducts.has(productKey) ||
      combinedAvailableQty < 1 ||
      combinedAvailableQty > args.threshold
    ) {
      continue
    }
    const catalogProduct = catalogProducts.get(String(productId))
    const location = locationForRow(row)
    const key = locationKey(location)
    let group = groupsByLocation.get(key)
    if (group === undefined) {
      group = { location, skus: new Map() }
      groupsByLocation.set(key, group)
    }

    let sku = group.skus.get(productKey)
    if (sku === undefined) {
      const categoryName = catalogProduct?.category_name ?? null
      sku = {
        categoryName,
        combinedAvailableQty,
        imageUrl: catalogProduct?.image_url ?? null,
        isCannabis: isCannabisCategory(categoryName),
        packages: [],
        productIds: [productId],
        productName,
        productSku,
        subcategoryName: catalogProduct?.subcategory_name ?? null,
      }
      group.skus.set(productKey, sku)
    } else if (!sku.productIds.includes(productId)) {
      sku.productIds.push(productId)
    }

    sku.packages.push({
      availableQty: numeric(row.available_qty, 'available_qty'),
      currentQty: nullableNumeric(row.current_qty, 'current_qty'),
      holdQty: nullableNumeric(row.hold_qty, 'hold_qty'),
      internalTrackCode: row.internal_track_code,
      inventoryBarcode: row.inventory_barcode,
      inventoryItemId: row.inventory_item_id,
      metrcTag: row.metrc_tag,
      observedAt,
      productId,
      productName,
      stockLocation: row.stock_location,
    })
  }

  const locationGroups = [...groupsByLocation.values()]
    .map((group): LowInventoryLocationGroup => ({
      location: group.location,
      skus: [...group.skus.values()]
        .map((sku) => ({
          ...sku,
          packages: sku.packages.sort((left, right) =>
            compareLabels(left.inventoryItemId, right.inventoryItemId),
          ),
          productIds: sku.productIds.sort((left, right) => left - right),
        }))
        .sort((left, right) =>
          compareLabels(
            left.productName ?? left.productSku ?? String(left.productIds[0]),
            right.productName ?? right.productSku ?? String(right.productIds[0]),
          ),
        ),
    }))
    .sort((left, right) => {
      if (left.location.kind !== right.location.kind) {
        return left.location.kind === 'shelf' ? -1 : 1
      }
      return compareLabels(left.location.label, right.location.label)
    })

  return {
    dealerId: args.dealerId,
    locationGroups,
    snapshotObservedAt,
    threshold: args.threshold,
  }
}

export async function queryLowInventoryReadModel(args: {
  dealerId: number
  threshold: number
}): Promise<LowInventoryReadModel> {
  if (getHeliosPendingPurchaseSiteDealer(args.dealerId) === null) {
    throw new Error(`Unknown Helios dealer id ${args.dealerId}.`)
  }
  if (!LowInventoryThresholdSchema.safeParse(args.threshold).success) {
    throw new Error('Low-inventory threshold must be an integer from 1 through 100.')
  }

  const db = getPool()
  const result = await db.query<LowInventoryRow>(LOW_INVENTORY_SQL, [args.dealerId])
  // The package mirror's SKU column is currently empty in production, while
  // several Sweed product ids can represent one catalog SKU. Resolve only the
  // product ids present at this site, then combine by the resolved SKU in the
  // typed mapper. Keeping this as two narrow reads avoids repeatedly expanding
  // the catalog JSON inside the package-view query, which exceeds the 125 ms
  // interaction budget.
  const productIds = [...new Set(result.rows.map((row) => String(row.product_id)))]
  const catalogResult =
    productIds.length === 0
      ? { rows: [] }
      : await db.query<LowInventoryCatalogProductRow>(LOW_INVENTORY_CATALOG_PRODUCTS_SQL, [
          productIds,
        ])
  return buildLowInventoryReadModel({
    ...args,
    catalogProducts: catalogResult.rows,
    now: new Date(),
    rows: result.rows,
  })
}

export async function getLowInventoryPackageSnapshot(args: {
  db: Queryable
  dealerId: number
  inventoryItemId: string
  productId: number
  snapshotObservedAt: string
}): Promise<LowInventoryPackage | null> {
  const result = await args.db.query<LowInventoryRow>(
    `select c.inventory_item_id, c.product_id, c.product_name, c.current_qty, c.hold_qty,
            c.available_qty, c.metrc_tag, c.internal_track_code, c.stock_location, c.observed_at_max,
            nullif(btrim(c.product_sku), '') as product_sku
       from sweed_package_current c
      where c.dealer_id = $1
        and c.inventory_item_id = $2
        and c.product_id = $3
        and c.observed_at_max = $4::timestamptz
        and c.is_on_stock = true
        and c.current_qty is not null
        and c.available_qty is not null
        and c.stock_location ilike 'FOR SALE%'
        and coalesce(lower(c.raw_json->>'enabled') = 'false', false) = false
        and coalesce(lower(c.raw_json->>'isTradeSample') = 'true', false) = false
        and coalesce(lower(c.raw_json->>'isNotForSale') = 'true', false) = false
        and not exists (
          select 1 from audit_events te
           where te.event_type = 'low_inventory.package_transfer.completed'
             and (te.payload_json->>'dealerId')::bigint = c.dealer_id
             and te.payload_json->>'inventoryItemId' = c.inventory_item_id
             and te.created_at >= c.observed_at_min
        )`,
    [args.dealerId, args.inventoryItemId, args.productId, args.snapshotObservedAt],
  )
  const row = result.rows[0]
  if (row === undefined) return null
  return LowInventoryPackageSchema.parse({
    availableQty: numeric(row.available_qty, 'available_qty'),
    currentQty: nullableNumeric(row.current_qty, 'current_qty'),
    holdQty: nullableNumeric(row.hold_qty, 'hold_qty'),
    internalTrackCode: row.internal_track_code,
    inventoryItemId: row.inventory_item_id,
    metrcTag: row.metrc_tag,
    observedAt: isoTimestamp(row.observed_at_max),
    productId: positiveInteger(row.product_id, 'product_id'),
    productName: row.product_name,
    stockLocation: row.stock_location,
  })
}

interface CountAuditRow {
  actor_label: string
  created_at: Date | string
  id: number
  payload_json: unknown
  transfer_audit_id: number | null
}

export async function listLowInventoryCountAudits(
  db: Queryable,
  dealerId: number,
  limit: number,
): Promise<LowInventoryAuditResult[]> {
  const result = await db.query<CountAuditRow>(
    `select ae.id, ae.created_at, ae.payload_json,
            coalesce(u.name, ae.actor_type) as actor_label,
            (select min(te.id) from audit_events te
             where te.entity_type = 'low_inventory_package_transfer'
               and te.event_type = 'low_inventory.package_transfer.completed'
               and te.entity_id = ae.id::text) as transfer_audit_id
       from audit_events ae
       left join users u on u.id = ae.actor_user_id
      where ae.event_type = 'low_inventory.package_count.recorded'
        and (ae.payload_json->>'dealerId')::bigint = $1
      order by ae.created_at desc, ae.id desc
      limit $2`,
    [dealerId, limit],
  )
  return result.rows.map((row) => {
    const count = LowInventoryCountBodySchema.parse(row.payload_json)
    return LowInventoryAuditResultSchema.parse({
      ...count,
      auditId: row.id,
      actorLabel: row.actor_label,
      createdAt: isoTimestamp(row.created_at),
      transferAuditId: row.transfer_audit_id,
      transferStatus:
        count.classification !== 'short' && count.classification !== 'zero'
          ? 'not_applicable'
          : row.transfer_audit_id === null
            ? 'pending'
            : 'resolved',
    })
  })
}

export async function getPendingLowInventoryCountAudit(
  db: Queryable,
  auditId: number,
  dealerId: number,
): Promise<LowInventoryCountBody | null> {
  const result = await db.query<{ payload_json: unknown }>(
    `select ae.payload_json
       from audit_events ae
      where ae.id = $1
        and ae.event_type = 'low_inventory.package_count.recorded'
        and (ae.payload_json->>'dealerId')::bigint = $2
        and ae.payload_json->>'classification' in ('short', 'zero')
        and not exists (
          select 1 from audit_events newer
           where newer.event_type = 'low_inventory.package_count.recorded'
             and newer.entity_id = ae.entity_id
             and newer.id > ae.id
        )
        and not exists (
          select 1 from audit_events te
           where te.entity_type = 'low_inventory_package_transfer'
             and te.event_type = 'low_inventory.package_transfer.completed'
             and te.entity_id = ae.id::text
        )`,
    [auditId, dealerId],
  )
  return result.rows[0] ? LowInventoryCountBodySchema.parse(result.rows[0].payload_json) : null
}
