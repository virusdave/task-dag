import { createHash } from 'node:crypto'

import { z } from 'zod'

import type { TradeSampleZeroApplyResponse, TradeSampleZeroItem, TradeSampleZeroPreviewResponse } from '../../shared/contracts/index.js'
import { getHeliosPendingPurchaseSiteDealer } from '../../shared/contracts/index.js'
import { callSweedRpc } from '../../worker/sweed/rpc.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { getPool, withClient, type Queryable } from '../db/pool.js'

const PAGE_SIZE = 100
const MAX_CANDIDATES = 500
const LOCK_NAMESPACE = 'trade_sample_zero_apply'
const StrictFiniteNumberSchema = z.preprocess(
  (value) => typeof value === 'string' && value.trim() !== '' ? Number(value) : value,
  z.number().finite(),
)

const GroupedItemSchema = z.object({
  id: z.union([z.coerce.string(), z.number()]).optional(),
  inventoryItemId: z.union([z.coerce.string(), z.number()]).optional(),
  currentQty: StrictFiniteNumberSchema.nullable().optional(),
  externalTrackCode: z.string().nullable().optional(),
  isTradeSample: z.boolean().nullable().optional(),
}).passthrough()
const GroupedRowSchema = z.object({
  product: z.object({
    id: z.coerce.number().int().optional(),
    name: z.string().nullable().optional(),
    sku: z.string().nullable().optional(),
  }).passthrough().optional(),
  items: z.array(GroupedItemSchema),
}).passthrough()
const GroupedResponseSchema = z.object({
  data: z.array(GroupedRowSchema),
  totalCount: z.coerce.number().int().nonnegative(),
}).passthrough()
const ItemDetailSchema = z.object({
  id: z.union([z.coerce.string(), z.number()]),
  currentQty: StrictFiniteNumberSchema,
  externalTrackCode: z.string(),
  isTradeSample: z.boolean(),
}).passthrough()

export type TradeSampleZeroLockRunner = <T>(dealerId: number, run: () => Promise<T>) => Promise<T>
export interface TradeSampleZeroDeps {
  audit: typeof appendAuditEvent
  db: Queryable
  rpc: typeof callSweedRpc
  withLock: TradeSampleZeroLockRunner
}

async function postgresLock<T>(dealerId: number, run: () => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    const result = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock(hashtext($1), hashtext($2)) as locked',
      [LOCK_NAMESPACE, String(dealerId)],
    )
    if (!result.rows[0]?.locked) throw new TradeSampleZeroBusyError('Another trade-sample adjustment is already running for this site.')
    try {
      return await run()
    } finally {
      try {
        await client.query('select pg_advisory_unlock(hashtext($1), hashtext($2))', [LOCK_NAMESPACE, String(dealerId)])
      } catch (error) {
        console.error('[trade-sample-zero] advisory unlock failed', error)
      }
    }
  })
}

const defaultDeps = (): TradeSampleZeroDeps => ({ audit: appendAuditEvent, db: getPool(), rpc: callSweedRpc, withLock: postgresLock })

function requireSite(dealerId: number): void {
  if (getHeliosPendingPurchaseSiteDealer(dealerId) === null) throw new Error(`Unknown siteDealerId ${dealerId}.`)
}

export function tradeSampleZeroDigest(dealerId: number, items: readonly TradeSampleZeroItem[]): string {
  const identities = items.map((item) => [item.productId, item.inventoryItemId, item.externalTrackCode, item.currentQty] as const)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return createHash('sha256').update(JSON.stringify([dealerId, identities])).digest('hex')
}

async function liveItems(dealerId: number, deps: TradeSampleZeroDeps): Promise<TradeSampleZeroItem[]> {
  const byId = new Map<string, TradeSampleZeroItem>()
  const seen = new Map<string, string>()
  let expectedTotal: number | null = null
  let rowsRead = 0
  for (let page = 1; page <= 10_000; page += 1) {
    const parsed = GroupedResponseSchema.parse(await deps.rpc(dealerId, 'store.inventory.item.list.grouped', { page, pageSize: PAGE_SIZE, isOnStock: false }))
    if (expectedTotal === null) expectedTotal = parsed.totalCount
    if (parsed.totalCount !== expectedTotal) throw new Error('Grouped inventory total changed during pagination.')
    if (parsed.data.length === 0 && rowsRead < expectedTotal) throw new Error('Grouped inventory pagination ended before totalCount.')
    rowsRead += parsed.data.length
    if (rowsRead > expectedTotal) throw new Error('Grouped inventory pagination exceeded totalCount.')
    for (const row of parsed.data) {
      for (const raw of row.items) {
        if (raw.isTradeSample !== true) continue
        if (raw.currentQty === null || raw.currentQty === undefined) {
          throw new Error('Grouped inventory returned a trade sample without a valid quantity.')
        }
        if (raw.currentQty <= 0) continue
        const productId = row.product?.id
        const inventoryItemId = String(raw.inventoryItemId ?? raw.id ?? '').trim()
        const tag = raw.externalTrackCode?.trim() ?? ''
        if (
          productId === undefined ||
          productId < 1 ||
          !Number.isFinite(raw.currentQty) ||
          inventoryItemId === '' ||
          tag === ''
        ) {
          throw new Error('Grouped inventory returned a malformed positive trade sample.')
        }
        const candidate: TradeSampleZeroItem = { currentQty: raw.currentQty, externalTrackCode: tag, inventoryItemId,
          packageLabel: null, productId, productName: row.product?.name ?? null, productSku: row.product?.sku ?? null }
        const identity = JSON.stringify([candidate, raw.isTradeSample])
        const prior = seen.get(inventoryItemId)
        if (prior !== undefined && prior !== identity) throw new Error(`Conflicting duplicate inventory item ${inventoryItemId}.`)
        seen.set(inventoryItemId, identity)
        byId.set(inventoryItemId, candidate)
      }
    }
    if (rowsRead === expectedTotal) break
    if (parsed.data.length !== PAGE_SIZE) throw new Error('Grouped inventory returned incomplete pagination.')
  }
  if (expectedTotal === null || rowsRead !== expectedTotal) throw new Error('Grouped inventory pagination did not complete.')
  if (byId.size > MAX_CANDIDATES) throw new TradeSampleZeroCandidateLimitError(`More than ${MAX_CANDIDATES} trade samples require adjustment; narrow the operation before retrying.`)
  return [...byId.values()].sort((a, b) => a.productId - b.productId || a.inventoryItemId.localeCompare(b.inventoryItemId))
}

async function getExactItem(dealerId: number, item: TradeSampleZeroItem, deps: TradeSampleZeroDeps): Promise<z.infer<typeof ItemDetailSchema>> {
  const detail = ItemDetailSchema.parse(await deps.rpc(dealerId, 'store.inventory.item.get', { inventoryItemId: item.inventoryItemId }))
  if (String(detail.id) !== item.inventoryItemId || detail.externalTrackCode !== item.externalTrackCode) throw new Error('Inventory item identity or tag changed.')
  return detail
}

export async function previewTradeSampleZero(dealerId: number, injected?: TradeSampleZeroDeps): Promise<TradeSampleZeroPreviewResponse> {
  requireSite(dealerId)
  const items = await liveItems(dealerId, injected ?? defaultDeps())
  return { digest: tradeSampleZeroDigest(dealerId, items), items, siteDealerId: dealerId }
}

export class TradeSampleZeroStaleError extends Error {}
export class TradeSampleZeroBusyError extends Error {}
export class TradeSampleZeroCandidateLimitError extends Error {}

export async function applyTradeSampleZero(input: { actorUserId: number; confirmation: string; digest: string; items: TradeSampleZeroItem[]; requestId: string | null; siteDealerId: number }, injected?: TradeSampleZeroDeps): Promise<TradeSampleZeroApplyResponse> {
  requireSite(input.siteDealerId)
  if (input.confirmation !== 'ZERO TRADE SAMPLES') throw new Error('Confirmation must exactly match ZERO TRADE SAMPLES.')
  if (tradeSampleZeroDigest(input.siteDealerId, input.items) !== input.digest) throw new TradeSampleZeroStaleError('Preview digest does not match submitted items.')
  const deps = injected ?? defaultDeps()
  return deps.withLock(input.siteDealerId, async () => {
    const current = await liveItems(input.siteDealerId, deps)
    if (tradeSampleZeroDigest(input.siteDealerId, current) !== input.digest) throw new TradeSampleZeroStaleError('Trade sample inventory changed; refresh the preview. No adjustments were made.')

    const outcomes: TradeSampleZeroApplyResponse['outcomes'] = []
    for (let index = 0; index < input.items.length; index += 1) {
      const item = input.items[index]!
      let late: z.infer<typeof ItemDetailSchema>
      try {
        late = await getExactItem(input.siteDealerId, item, deps)
      } catch {
        late = { id: '', currentQty: Number.NaN, externalTrackCode: '', isTradeSample: false }
      }
      if (late.isTradeSample !== true || late.currentQty !== item.currentQty) {
        for (const remaining of input.items.slice(index)) outcomes.push({ inventoryItemId: remaining.inventoryItemId, status: 'not_applied_stale', error: 'Inventory changed before adjustment; no further items were applied.' })
        break
      }
      const metadata = { before: item.currentQty, delta: -item.currentQty, externalTrackCode: item.externalTrackCode,
        integrationReasonId: 197, inventoryItemId: item.inventoryItemId, note: 'sample use', productId: item.productId, reasonId: 20 }
      const auditBase = { actorType: 'user' as const, actorUserId: input.actorUserId, entityId: `${input.siteDealerId}:${item.inventoryItemId}`,
        entityType: 'trade_sample_inventory_item' as const, module: 'catalog' as const, requestId: input.requestId, scope: null, undoPayload: null }
      try {
        await deps.audit(deps.db, { ...auditBase, eventType: 'trade_sample.zero.attempted', payload: metadata })
      } catch (error) {
        console.error(`[trade-sample-zero] attempted audit failed request=${input.requestId ?? 'unknown'} item=${item.inventoryItemId}`, error)
        for (const remaining of input.items.slice(index)) {
          outcomes.push({
            inventoryItemId: remaining.inventoryItemId,
            status: 'not_applied_audit_failure',
            error: 'Audit recording failed; this and all remaining packages were not applied.',
          })
        }
        break
      }

      let status: 'completed' | 'failed_unknown' = 'completed'
      let rpcError: unknown
      try {
        await deps.rpc(input.siteDealerId, 'store.inventory.item.adjust', { reasonId: 20, integrationReasonId: 197, note: 'sample use',
          items: [{ qty: -item.currentQty, id: item.inventoryItemId, externalTrackCode: item.externalTrackCode }], isInternal: false })
        const after = await getExactItem(input.siteDealerId, item, deps)
        if (after.currentQty !== 0) throw new Error('Post-adjustment quantity was not exactly zero.')
      } catch (error) {
        status = 'failed_unknown'
        rpcError = error
      }

      const eventType = status === 'completed' ? 'trade_sample.zero.completed' as const : 'trade_sample.zero.failed' as const
      const payload = status === 'completed' ? { ...metadata, after: 0 } : { ...metadata, error: rpcError instanceof Error ? rpcError.message : 'Unknown failure', outcome: 'failed_unknown' }
      try {
        await deps.audit(deps.db, { ...auditBase, eventType, payload })
      } catch (error) {
        console.error(`[trade-sample-zero] terminal audit failed request=${input.requestId ?? 'unknown'} item=${item.inventoryItemId}`, error)
        status = 'failed_unknown'
      }
      outcomes.push(status === 'completed' ? { inventoryItemId: item.inventoryItemId, status } : { inventoryItemId: item.inventoryItemId, status, error: 'Adjustment outcome is unknown; inspect this package in Sweed.' })
    }
    return { counts: { completed: outcomes.filter((x) => x.status === 'completed').length,
      failedUnknown: outcomes.filter((x) => x.status === 'failed_unknown').length,
      notAppliedStale: outcomes.filter((x) => x.status === 'not_applied_stale').length,
      notAppliedAuditFailure: outcomes.filter((x) => x.status === 'not_applied_audit_failure').length }, outcomes }
  })
}
