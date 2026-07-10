import {
  getHeliosPendingPurchaseSiteDealer,
  isValidWarehouseLocationCode,
} from '../../shared/contracts/index.js'
import { getPool } from '../db/pool.js'

export interface LowInventoryShelfLocation {
  kind: 'shelf'
  label: string
}

export interface LowInventoryStockRoomLocation {
  kind: 'stock-room'
  label: string
}

export type LowInventoryLocation = LowInventoryShelfLocation | LowInventoryStockRoomLocation

export interface LowInventoryPackage {
  availableQty: number
  currentQty: number | null
  holdQty: number | null
  internalTrackCode: string | null
  inventoryItemId: string
  metrcTag: string | null
  observedAt: string
  productId: number
  productName: string | null
  stockLocation: string
}

export interface LowInventorySku {
  combinedAvailableQty: number
  packages: LowInventoryPackage[]
  productIds: number[]
  productName: string | null
  productSku: string | null
}

export interface LowInventoryLocationGroup {
  location: LowInventoryLocation
  skus: LowInventorySku[]
}

export interface LowInventoryReadModel {
  dealerId: number
  locationGroups: LowInventoryLocationGroup[]
  snapshotObservedAt: string | null
  threshold: number
}

interface LowInventoryRow {
  available_qty: number | string
  current_qty: number | string | null
  hold_qty: number | string | null
  internal_track_code: string | null
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
    nullif(btrim(product->>'name'), '') as product_name,
    nullif(btrim(product->>'sku'), '') as product_sku,
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
  product_id: number | string
  product_name: string | null
  product_sku: string | null
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
    productId: number
    productKey: string
    productName: string | null
    productSku: string | null
    row: LowInventoryRow
  }> = []
  const combinedAvailableByProduct = new Map<string, number>()

  for (const row of args.rows) {
    const catalogProduct = catalogProducts.get(String(row.product_id))
    if (catalogProduct?.active === false) {
      continue
    }
    const productId = positiveInteger(row.product_id, 'product_id')
    const productSku = row.product_sku ?? catalogProduct?.product_sku ?? null
    const productKey = productSku === null ? `product-id:${productId}` : `sku:${productSku}`
    const productName = row.product_name ?? catalogProduct?.product_name ?? null
    const availableQty = numeric(row.available_qty, 'available_qty')
    combinedAvailableByProduct.set(
      productKey,
      (combinedAvailableByProduct.get(productKey) ?? 0) + availableQty,
    )
    resolvedRows.push({ productId, productKey, productName, productSku, row })
  }

  for (const { productId, productKey, productName, productSku, row } of resolvedRows) {
    const combinedAvailableQty = combinedAvailableByProduct.get(productKey)
    if (
      combinedAvailableQty === undefined ||
      combinedAvailableQty < 1 ||
      combinedAvailableQty > args.threshold
    ) {
      continue
    }
    const location = locationForRow(row)
    const key = locationKey(location)
    let group = groupsByLocation.get(key)
    if (group === undefined) {
      group = { location, skus: new Map() }
      groupsByLocation.set(key, group)
    }

    let sku = group.skus.get(productKey)
    if (sku === undefined) {
      sku = {
        combinedAvailableQty,
        packages: [],
        productIds: [productId],
        productName,
        productSku,
      }
      group.skus.set(productKey, sku)
    } else if (!sku.productIds.includes(productId)) {
      sku.productIds.push(productId)
    }

    const observedAt = isoTimestamp(row.observed_at_max)
    if (snapshotObservedAt === null || observedAt > snapshotObservedAt) {
      snapshotObservedAt = observedAt
    }
    sku.packages.push({
      availableQty: numeric(row.available_qty, 'available_qty'),
      currentQty: nullableNumeric(row.current_qty, 'current_qty'),
      holdQty: nullableNumeric(row.hold_qty, 'hold_qty'),
      internalTrackCode: row.internal_track_code,
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
  if (!Number.isInteger(args.threshold) || args.threshold < 1) {
    throw new Error('Low-inventory threshold must be a positive integer.')
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
    rows: result.rows,
  })
}
