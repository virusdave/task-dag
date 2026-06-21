import { z } from 'zod'

import { isRetiredRecordName } from '../../worker/jobs/screensCarouselHelpers.js'
import { callSweedRpc } from '../../worker/sweed/rpc.js'

// ---------------------------------------------------------------------------
// Shared Sweed stock-transfer primitives (automation#54, L2).
//
// Generalized from the catalog/maintenance.ts move-to-inspection RPC
// pattern for the new purchase pricing-safety lifecycle (quarantine repair
// + gated release). These are deliberately STRICTER / money-safe versions
// of that pattern: fully paginated + fail-closed lot reads, usable-location
// filtering (enabled + not retired + has a stock type), and a single-lot
// transfer call. The existing customer-facing move-to-inspection route in
// maintenance.ts intentionally REMAINS on its own legacy primitives
// (page-1-only lot read, name-substring room lookup, and a "drain every
// remaining lot" fallback) — migrating it to these stricter helpers would
// change live behavior, so it is left for a separate behavior-preserving
// refactor (with characterization tests) rather than folded into L2.
//
// This module owns ONLY low-level primitives — location/lot reads and one
// transfer call. All POLICY (which lots may move, the price/quarantine
// release gates, partial-failure recovery) stays in the callers; in
// particular this module deliberately does NOT carry the maintenance
// route's drain-all-lots fallback, which is unsafe for a release.
//
// The Sweed RPC chain is:
//   store.stock.location.list        → rooms (FOR SALE / NOT FOR SALE)
//   store.inventory.product.item.list → live lots for a product
//   store.inventory.item.transfer    → move one lot (one source bucket)
// ---------------------------------------------------------------------------

/** The canonical "Hold for Dave inspection" room name needle. */
export const INSPECTION_LOCATION_NAME_NEEDLE = 'hold for dave inspection'

/**
 * Reads page-1-only inventory lists are a money-safety footgun for the
 * quarantine/release gates (a sellable lot on page 2+ would look "gone"
 * and false-pass). Page until Sweed returns a short page, and fail
 * CLOSED (throw) if it never does within a generous bound — never pass a
 * gate on an incomplete lot list. Matches the L1 verifier discipline.
 */
const LIVE_LOT_PAGE_SIZE = 100
const LIVE_LOT_MAX_PAGES = 50

export class StockTransferError extends Error {}

export interface StockLocation {
  id: number
  name: string
  enabled: boolean
  stockTypeId: number | null
}

/** A live inventory lot, normalized with everything a transfer needs. */
export interface LiveInventoryLot {
  inventoryItemId: string
  externalTrackCode: string | null
  availableQty: number | null
  currentQty: number | null
  stockLocationId: number | null
  stockLocationName: string | null
  stockTypeId: number | null
  isTradeSample: boolean
}

const StockLocationListEntrySchema = z
  .object({
    id: z.coerce.number().int(),
    name: z.string().nullable().optional(),
    enabled: z.boolean().nullable().optional(),
    stockType: z
      .object({
        id: z.coerce.number().int(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

const StockLocationListResponseSchema = z.union([
  z.array(StockLocationListEntrySchema),
  z
    .object({ data: z.array(StockLocationListEntrySchema).default([]) })
    .passthrough()
    .transform((v) => v.data),
  z
    .object({ result: z.object({ data: z.array(StockLocationListEntrySchema).default([]) }).passthrough() })
    .passthrough()
    .transform((v) => v.result.data),
])

const InventoryProductItemSchema = z
  .object({
    id: z.union([z.coerce.number().int(), z.string().trim().min(1)]),
    externalTrackCode: z.string().nullable().optional(),
    availableQty: z.coerce.number().nullable().optional(),
    currentQty: z.coerce.number().nullable().optional(),
    isTradeSample: z.boolean().nullable().optional(),
    stockLocation: z
      .object({
        id: z.coerce.number().int().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    stockType: z
      .object({
        id: z.coerce.number().int().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

const InventoryProductItemListResponseSchema = z
  .object({
    result: z
      .object({
        data: z.array(InventoryProductItemSchema).default([]),
        totalCount: z.coerce.number().int().min(0).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    data: z.array(InventoryProductItemSchema).optional(),
  })
  .passthrough()
  .transform((value) => value.result?.data ?? value.data ?? [])

/** Sweed sometimes wraps payloads in `{ result, id, version }`. */
function extractRpcResult(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object' && 'result' in raw) {
    return (raw as { result: unknown }).result
  }
  return raw
}

/** List ALL stock locations for a dealer (enabled and disabled). */
export async function listStockLocations(dealerId: number): Promise<StockLocation[]> {
  const raw = await callSweedRpc<unknown>(dealerId, 'store.stock.location.list', {})
  const parsed = StockLocationListResponseSchema.parse(extractRpcResult(raw))
  const out: StockLocation[] = []
  for (const loc of parsed) {
    if (typeof loc.name !== 'string') continue
    out.push({
      id: loc.id,
      name: loc.name,
      enabled: loc.enabled !== false,
      stockTypeId: loc.stockType?.id ?? null,
    })
  }
  return out
}

/** A location is usable as a transfer target only if live + not retired. */
export function isUsableLocation(loc: StockLocation): boolean {
  return loc.enabled && !isRetiredRecordName(loc.name) && loc.stockTypeId !== null
}

/** Find the NOT-FOR-SALE "Hold for Dave inspection" room, or throw. */
export function findInspectionLocation(locations: StockLocation[]): StockLocation {
  const target = locations.find(
    (loc) =>
      isUsableLocation(loc) &&
      loc.name.trim().toLowerCase().includes(INSPECTION_LOCATION_NAME_NEEDLE),
  )
  if (!target) {
    throw new StockTransferError(
      `No usable stock location matching "${INSPECTION_LOCATION_NAME_NEEDLE}". ` +
        `Found ${locations.length} location(s): ${locations.map((l) => l.name).join(', ')}.`,
    )
  }
  return target
}

/** A location is "for sale" iff its name starts with "for sale". */
export function isForSaleLocationName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false
  return name.trim().toLowerCase().startsWith('for sale')
}

/** All usable FOR SALE rooms (release-target candidates), sorted by name. */
export function findForSaleLocations(locations: StockLocation[]): StockLocation[] {
  return locations
    .filter((loc) => isUsableLocation(loc) && isForSaleLocationName(loc.name))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve a client-chosen target location id LIVE: it must still be a
 * usable, enabled, non-retired FOR SALE room. Never trust the id blindly.
 */
export function resolveForSaleTargetById(
  locations: StockLocation[],
  targetLocationId: number,
): StockLocation {
  const found = locations.find((loc) => loc.id === targetLocationId)
  if (!found) {
    throw new StockTransferError(`Stock location ${targetLocationId} no longer exists for this dealer.`)
  }
  if (!isUsableLocation(found)) {
    throw new StockTransferError(`Stock location "${found.name}" is disabled or retired; pick another room.`)
  }
  if (!isForSaleLocationName(found.name)) {
    throw new StockTransferError(`Stock location "${found.name}" is not a FOR SALE room.`)
  }
  return found
}

function lotQty(item: z.infer<typeof InventoryProductItemSchema>): {
  availableQty: number | null
  currentQty: number | null
} {
  return {
    availableQty: typeof item.availableQty === 'number' ? item.availableQty : null,
    currentQty: typeof item.currentQty === 'number' ? item.currentQty : null,
  }
}

/**
 * List ALL live, on-stock lots for a product, fully paginated and
 * fail-closed. Throws if Sweed never returns a short page within the
 * bound — refusing to feed a gate an incomplete lot list.
 */
export async function listLiveLotsForProduct(
  dealerId: number,
  productId: number,
): Promise<LiveInventoryLot[]> {
  const out: LiveInventoryLot[] = []
  for (let page = 1; page <= LIVE_LOT_MAX_PAGES; page += 1) {
    const raw = await callSweedRpc<unknown>(dealerId, 'store.inventory.product.item.list', {
      productId: String(productId),
      page,
      pageSize: LIVE_LOT_PAGE_SIZE,
      isOnStock: true,
    })
    const items = InventoryProductItemListResponseSchema.parse(raw)
    for (const item of items) {
      const { availableQty, currentQty } = lotQty(item)
      out.push({
        inventoryItemId: String(item.id),
        externalTrackCode: item.externalTrackCode ?? null,
        availableQty,
        currentQty,
        stockLocationId: item.stockLocation?.id ?? null,
        stockLocationName: item.stockLocation?.name ?? null,
        stockTypeId: item.stockType?.id ?? null,
        isTradeSample: item.isTradeSample === true,
      })
    }
    if (items.length < LIVE_LOT_PAGE_SIZE) {
      return out
    }
  }
  throw new StockTransferError(
    `Could not list live lots for product ${productId}: Sweed returned more than ` +
      `${LIVE_LOT_MAX_PAGES * LIVE_LOT_PAGE_SIZE} lots. Refusing to act on an incomplete list.`,
  )
}

export interface TransferLotInput {
  dealerId: number
  lot: LiveInventoryLot
  targetLocationId: number
  targetStockTypeId: number
}

export interface TransferLotResult {
  itemId: string
  externalTrackCode: string | null
  movedQty: number
  fromStockLocationId: number
  fromStockLocationName: string
  fromStockTypeId: number
  toStockLocationId: number
  toStockTypeId: number
  /** True when availableQty < currentQty, so reserved units stayed put. */
  reservedHeldBack: boolean
}

/**
 * Move ONE live lot into the target (location, stock type). Returns null
 * when there is nothing to move (zero/negative qty or a missing source
 * bucket) or the lot is already at the target. We send the lot's
 * `availableQty` (falling back to `currentQty`) so reserved units that
 * belong to in-flight orders are never silently relocated
 * (transferReservedItems: false).
 */
export async function transferLot(input: TransferLotInput): Promise<TransferLotResult | null> {
  const { lot, dealerId, targetLocationId, targetStockTypeId } = input
  const fromLocationId = lot.stockLocationId
  const fromStockTypeId = lot.stockTypeId
  const fromLocationName = lot.stockLocationName ?? null
  const movableQty = lot.availableQty ?? lot.currentQty ?? 0
  if (movableQty <= 0 || fromLocationId === null || fromStockTypeId === null) {
    return null
  }
  if (fromLocationId === targetLocationId && fromStockTypeId === targetStockTypeId) {
    // Already at the target — no-op so a re-run is idempotent.
    return null
  }
  const reservedHeldBack =
    lot.availableQty !== null && lot.currentQty !== null && lot.availableQty < lot.currentQty
  await callSweedRpc(dealerId, 'store.inventory.item.transfer', {
    stockTypeFrom: fromStockTypeId,
    stockLocationFrom: fromLocationId,
    stockTypeTo: targetStockTypeId,
    stockLocationTo: targetLocationId,
    transferReservedItems: false,
    items: [
      {
        id: String(lot.inventoryItemId),
        qty: movableQty,
        externalTrackCode: lot.externalTrackCode ?? null,
      },
    ],
  })
  return {
    itemId: String(lot.inventoryItemId),
    externalTrackCode: lot.externalTrackCode ?? null,
    movedQty: movableQty,
    fromStockLocationId: fromLocationId,
    fromStockLocationName: fromLocationName ?? `#${fromLocationId}`,
    fromStockTypeId,
    toStockLocationId: targetLocationId,
    toStockTypeId: targetStockTypeId,
    reservedHeldBack,
  }
}
