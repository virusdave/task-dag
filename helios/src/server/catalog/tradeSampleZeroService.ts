import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { TradeSampleLocationSchema, TradeSampleZeroItem, TradeSampleZeroPreviewResponse } from '../../shared/contracts/index.js'
import { TRADE_SAMPLE_LOCATION_NAME, getHeliosPendingPurchaseSiteDealer } from '../../shared/contracts/index.js'
import { callSweedRpc } from '../../worker/sweed/rpc.js'
import { getServerEnv } from '../config/env.js'

const PAGE_SIZE = 100
const PREVIEW_TTL_MS = 15 * 60 * 1000
const NumberSchema = z.preprocess(
  (value) => typeof value === 'string' && value.trim() !== '' ? Number(value) : value,
  z.number().finite(),
)
const IntegerSchema = z.preprocess(
  (value) => typeof value === 'string' && value.trim() !== '' ? Number(value) : value,
  z.number().int(),
)
const ItemSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  inventoryItemId: z.union([z.string(), z.number()]).optional(),
  currentQty: NumberSchema.optional(),
  availableQty: NumberSchema.optional(),
  externalTrackCode: z.string().nullable().optional(),
  isTradeSample: z.boolean().nullable().optional(),
  stockLocation: z.object({ id: IntegerSchema.optional(), name: z.string().nullable().optional() }).nullable().optional(),
  stockType: z.object({ id: IntegerSchema.optional() }).nullable().optional(),
}).passthrough()
const RowSchema = z.object({ product: z.object({ id: z.coerce.number().int().optional(), name: z.string().nullable().optional(), sku: z.string().nullable().optional() }).optional(), items: z.array(ItemSchema) }).passthrough()
const GroupedSchema = z.object({ data: z.array(RowSchema), totalCount: IntegerSchema.pipe(z.number().nonnegative()) }).passthrough()
const LocationSchema = z.object({ id: IntegerSchema, name: z.string(), enabled: z.boolean().optional(), stockType: z.object({ id: IntegerSchema }).nullable().optional() }).passthrough()
const DetailSchema = ItemSchema.extend({ id: z.union([z.string(), z.number()]), currentQty: NumberSchema, availableQty: NumberSchema, externalTrackCode: z.string(), isTradeSample: z.boolean() })
type Location = z.infer<typeof TradeSampleLocationSchema>
export interface TradeSampleZeroDeps { rpc: typeof callSweedRpc; previewSecret?: string }
const deps = (): TradeSampleZeroDeps => ({ rpc: callSweedRpc })
export class TradeSampleZeroStaleError extends Error {}
export class TradeSampleZeroCandidateLimitError extends Error {}
export class TradeSampleTargetError extends Error {}

function requireSite(id: number): void { if (getHeliosPendingPurchaseSiteDealer(id) === null) throw new Error(`Unknown siteDealerId ${id}.`) }
function unwrap(raw: unknown): unknown { return raw && typeof raw === 'object' && 'result' in raw ? (raw as { result: unknown }).result : raw }
export async function resolveTradeSampleDestination(dealerId: number, d: TradeSampleZeroDeps = deps()): Promise<Location> {
  const raw = unwrap(await d.rpc(dealerId, 'store.stock.location.list', {}))
  const list = z.union([z.array(LocationSchema), z.object({ data: z.array(LocationSchema) }).transform(v => v.data)]).parse(raw)
  const matches = list.filter((location) =>
    location.enabled === true
    && !/^\s*(dead|deleted|retired)\b/i.test(location.name)
    && location.name.trim() === TRADE_SAMPLE_LOCATION_NAME
    && location.stockType?.id,
  )
  if (matches.length !== 1) throw new TradeSampleTargetError(`Expected exactly one enabled location named "${TRADE_SAMPLE_LOCATION_NAME}"; found ${matches.length}.`)
  return { id: matches[0]!.id, name: TRADE_SAMPLE_LOCATION_NAME, stockTypeId: matches[0]!.stockType!.id }
}

export async function readLiveInventory(dealerId: number, destination: Location, d: TradeSampleZeroDeps = deps()): Promise<Array<TradeSampleZeroItem & { isTradeSample: boolean }>> {
  const byId = new Map<string, TradeSampleZeroItem & { isTradeSample: boolean }>()
  let total: number | null = null
  let read = 0
  for (let page = 1; page <= 10_000; page++) {
    const p = GroupedSchema.parse(unwrap(await d.rpc(dealerId, 'store.inventory.item.list.grouped', { page, pageSize: PAGE_SIZE, isOnStock: true })))
    total ??= p.totalCount; if (p.totalCount !== total) throw new TradeSampleZeroStaleError('Inventory changed during pagination.'); read += p.data.length
    for (const row of p.data) for (const x of row.items) {
      if (x.currentQty == null) throw new TradeSampleZeroStaleError('Live inventory has invalid package quantity metadata.')
      if (x.currentQty <= 0) continue
      if (!x.stockLocation?.id || !x.stockLocation.name) throw new TradeSampleZeroStaleError('Live inventory has invalid package location metadata.')
      if (x.isTradeSample == null) throw new TradeSampleZeroStaleError('Live inventory has unknown trade-sample classification.')
      const isTradeSample = x.isTradeSample
      if (!isTradeSample && x.stockLocation.id !== destination.id) continue
      const id = String(x.inventoryItemId ?? x.id ?? '').trim(), tag = x.externalTrackCode?.trim() ?? '', productId = row.product?.id
      if (!id || !tag || !productId || x.currentQty == null || x.availableQty == null || !x.stockType?.id) throw new TradeSampleZeroStaleError('Live inventory has invalid package/source metadata.')
      const item = { inventoryItemId: id, externalTrackCode: tag, currentQty: x.currentQty, availableQty: x.availableQty, isTradeSample,
        sourceLocationId: x.stockLocation.id, sourceLocationName: x.stockLocation.name, sourceStockTypeId: x.stockType.id,
        packageLabel: null, productId, productName: row.product?.name ?? null, productSku: row.product?.sku ?? null }
      const previous = byId.get(id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(item)) {
        throw new TradeSampleZeroStaleError(`Conflicting duplicate inventory ID ${id}.`)
      }
      byId.set(id, item)
    }
    if (read === total) return [...byId.values()]
    if (!p.data.length || read > total || p.data.length !== PAGE_SIZE) throw new TradeSampleZeroStaleError('Inventory pagination was incomplete.')
  }
  throw new TradeSampleZeroStaleError('Inventory pagination limit exceeded.')
}

export function assertTargetContents(all: Array<TradeSampleZeroItem & { isTradeSample: boolean }>, destination: Location, expected: TradeSampleZeroItem[] = []): void {
  const actual = all.filter(x => x.sourceLocationId === destination.id)
  if (actual.length !== expected.length) throw new TradeSampleTargetError(`"${TRADE_SAMPLE_LOCATION_NAME}" is occupied or contains an unexpected package.`)
  const byId = new Map(actual.map(x => [x.inventoryItemId, x]))
  for (const expectedItem of expected) {
    const actualItem = byId.get(expectedItem.inventoryItemId)
    if (
      !actualItem
      || !actualItem.isTradeSample
      || actualItem.externalTrackCode !== expectedItem.externalTrackCode
      || actualItem.currentQty !== expectedItem.currentQty
      || actualItem.availableQty !== expectedItem.currentQty
      || actualItem.sourceLocationName.trim() !== TRADE_SAMPLE_LOCATION_NAME
      || actualItem.sourceStockTypeId !== destination.stockTypeId
    ) {
      throw new TradeSampleTargetError('Dedicated location contents do not exactly match the staged trade samples.')
    }
  }
}

/**
 * Reconciles a reviewed source set with the fresh destination lots. Sweed may
 * replace package IDs and may merge or split lots that share a product and
 * Metrc tag during transfer, so IDs and per-lot quantities are not stable
 * across the physical-inspection handoff. Product/tag metadata and aggregate
 * quantity are stable and remain the fail-closed boundary.
 */
export function reconcileTargetContents(
  all: Array<TradeSampleZeroItem & { isTradeSample: boolean }>,
  destination: Location,
  reviewed: TradeSampleZeroItem[],
): TradeSampleZeroItem[] {
  const actual = all.filter((item) => item.sourceLocationId === destination.id)
  if (actual.some((item) =>
    !item.isTradeSample
    || item.availableQty !== item.currentQty
    || item.sourceLocationName.trim() !== TRADE_SAMPLE_LOCATION_NAME
    || item.sourceStockTypeId !== destination.stockTypeId
  )) {
    throw new TradeSampleTargetError('The dedicated location contains a non-sample, reserved, or incorrectly located package.')
  }

  const expectedTotals = aggregateTradeSampleQuantities(reviewed)
  const actualTotals = aggregateTradeSampleQuantities(actual)
  if (expectedTotals.size !== actualTotals.size) {
    throw new TradeSampleTargetError('The dedicated location does not contain the reviewed product/tag set.')
  }
  for (const [key, expectedQuantity] of expectedTotals) {
    if (actualTotals.get(key) !== expectedQuantity) {
      throw new TradeSampleTargetError('A reviewed product/tag has a different aggregate quantity in the dedicated location.')
    }
  }
  return actual.map(({ isTradeSample: _, ...item }) => item)
}

function aggregateTradeSampleQuantities(items: readonly TradeSampleZeroItem[]): Map<string, bigint> {
  const totals = new Map<string, bigint>()
  for (const item of items) {
    const key = JSON.stringify([
      item.productId,
      item.externalTrackCode,
      item.productName,
      item.productSku,
      item.packageLabel,
    ])
    totals.set(key, (totals.get(key) ?? 0n) + tradeSampleQuantityUnits(item.currentQty))
  }
  return totals
}

// Sweed quantities are accepted to six decimal places, which is finer than
// the package quantities observed in this workflow. Integer units avoid both
// floating-point false mismatches (0.1 + 0.2) and unsafe large-number sums.
export function tradeSampleQuantityUnits(quantity: number): bigint {
  const scaled = quantity * 1_000_000
  if (!Number.isSafeInteger(scaled) || scaled <= 0 || scaled / 1_000_000 !== quantity) {
    throw new TradeSampleTargetError('A package quantity is outside the supported six-decimal safe range.')
  }
  return BigInt(scaled)
}

export function tradeSampleZeroDigest(
  dealerId: number,
  items: readonly TradeSampleZeroItem[],
  destination?: Location,
): string {
  const canonicalItems = [...items]
    .sort((left, right) => left.inventoryItemId.localeCompare(right.inventoryItemId))
    .map((item) => [
      item.inventoryItemId,
      item.externalTrackCode,
      item.currentQty,
      item.availableQty,
      item.productId,
      item.productName,
      item.productSku,
      item.packageLabel,
      item.sourceLocationId,
      item.sourceLocationName,
      item.sourceStockTypeId,
    ])
  const canonicalDestination = destination
    ? [destination.id, destination.name, destination.stockTypeId]
    : null
  return createHash('sha256')
    .update(JSON.stringify([dealerId, canonicalDestination, canonicalItems]))
    .digest('hex')
}
export async function previewTradeSampleZero(dealerId: number, d: TradeSampleZeroDeps = deps()): Promise<TradeSampleZeroPreviewResponse> {
  requireSite(dealerId); const destination = await resolveTradeSampleDestination(dealerId, d); const all = await readLiveInventory(dealerId, destination, d); assertTargetContents(all, destination)
  const items = all.filter(x => x.isTradeSample).map(({ isTradeSample: _, ...x }) => x)
  if (items.some(x => x.availableQty !== x.currentQty)) throw new TradeSampleZeroStaleError('A trade sample has reservations; available quantity must equal current quantity.')
  if (items.length > 500) throw new TradeSampleZeroCandidateLimitError('More than 500 trade samples require staging.')
  const digest = tradeSampleZeroDigest(dealerId, items, destination), previewId = randomUUID(), capability = { digest, destination, expiresAt: Date.now() + PREVIEW_TTL_MS, previewId, siteDealerId: dealerId }
  const encoded = Buffer.from(JSON.stringify(capability)).toString('base64url'), secret = d.previewSecret ?? getServerEnv().sessionCookieSecret
  return { digest, destination, items, previewId, siteDealerId: dealerId, previewToken: `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}` }
}
export function verifyTradeSampleZeroPreview(input: TradeSampleZeroPreviewResponse, secret = getServerEnv().sessionCookieSecret, now = Date.now()): boolean {
  const [encoded, sig, extra] = input.previewToken.split('.'); if (!encoded || !sig || extra) return false
  try { const expected = createHmac('sha256', secret).update(encoded).digest(), supplied = Buffer.from(sig, 'base64url'); const p = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { digest:string; destination:Location; expiresAt:number; previewId:string; siteDealerId:number }
    return supplied.length === expected.length && timingSafeEqual(supplied, expected) && p.expiresAt >= now && p.expiresAt <= now + PREVIEW_TTL_MS && p.previewId === input.previewId && p.siteDealerId === input.siteDealerId && p.digest === input.digest && JSON.stringify(p.destination) === JSON.stringify(input.destination) && tradeSampleZeroDigest(input.siteDealerId, input.items, input.destination) === input.digest
  } catch { return false }
}
export async function readExactItem(dealerId: number, expected: TradeSampleZeroItem, d: TradeSampleZeroDeps = deps()): Promise<z.infer<typeof DetailSchema>> { const x = DetailSchema.parse(unwrap(await d.rpc(dealerId, 'store.inventory.item.get', { inventoryItemId: expected.inventoryItemId }))); if (String(x.id) !== expected.inventoryItemId || x.externalTrackCode !== expected.externalTrackCode) throw new TradeSampleZeroStaleError('Package identity changed.'); return x }
