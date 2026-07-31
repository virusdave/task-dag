import { describe, expect, it, vi } from 'vitest'

import type { CatalogInventoryZeroTradeSamplesJobPayload } from '../../shared/contracts/index.js'
import { runCatalogInventoryZeroTradeSamplesJob } from './catalogInventoryZeroTradeSamplesJob.js'

const destination = { id: 88, name: 'NOT FOR SALE - Samples' as const, stockTypeId: 7 }
const item = {
  availableQty: 3.5,
  currentQty: 3.5,
  externalTrackCode: 'TAG-1',
  inventoryItemId: '44',
  packageLabel: null,
  productId: 9,
  productName: 'Sample',
  productSku: 'S',
  sourceLocationId: 12,
  sourceLocationName: 'Sales Floor',
  sourceStockTypeId: 3,
}
const payload: CatalogInventoryZeroTradeSamplesJobPayload = {
  siteDealerId: 210249,
  items: [item],
  destination,
  confirmation: 'I VERIFIED ONLY TRADE SAMPLES',
  stageJobId: 8,
  actorUserId: 17,
  requestId: 'zero-stage-8',
}
const context = { id: 9, leaseToken: 'lease', jobType: 'catalog.inventory.zero_trade_samples' as const, module: 'catalog' as const, payload, scope: null }
const locationList = { data: [{ id: 88, name: destination.name, enabled: true, stockType: { id: 7 } }] }

function grouped(isTradeSample = true, extra: unknown[] = []) {
  return { data: [{ product: { id: 9, name: 'Sample', sku: 'S' }, items: [{
    id: '44', currentQty: 3.5, availableQty: 3.5, externalTrackCode: 'TAG-1', isTradeSample,
    stockLocation: { id: 88, name: destination.name }, stockType: { id: 7 },
  }, ...extra] }], totalCount: 1 }
}

function detail(overrides: Record<string, unknown> = {}) {
  return { id: '44', currentQty: 3.5, availableQty: 3.5, externalTrackCode: 'TAG-1', isTradeSample: true,
    stockLocation: { id: 88, name: destination.name }, stockType: { id: 7 }, ...overrides }
}

function dependencies(responses: unknown[], audit = vi.fn().mockResolvedValue(1)) {
  return {
    rpc: vi.fn(async () => responses.shift()),
    audit,
    db: { query: vi.fn() },
    assertLease: vi.fn().mockResolvedValue(undefined),
  }
}

describe('zero trade sample worker', () => {
  it('validates the whole exact set, rechecks immediately, adjusts exactly, verifies zero, and persists result', async () => {
    const deps = dependencies([locationList, grouped(), detail(), {}, detail({ currentQty: 0, availableQty: 0 })])
    await runCatalogInventoryZeroTradeSamplesJob(context, payload, deps)

    expect(deps.rpc).toHaveBeenCalledWith(210249, 'store.inventory.item.adjust', {
      reasonId: 20,
      integrationReasonId: 197,
      note: 'sample use',
      items: [{ qty: -3.5, id: '44', externalTrackCode: 'TAG-1' }],
      isInternal: false,
    })
    expect(deps.audit.mock.calls.map((call) => call[1].eventType)).toEqual([
      'trade_sample.zero.attempted',
      'trade_sample.zero.completed',
      'trade_sample.zero.batch_result',
    ])
    expect(deps.audit.mock.calls[2]?.[1].payload.counts.completed).toBe(1)
  })

  it('accepts Sweed padding around the destination name before zeroing', async () => {
    const padded = ` ${destination.name}`
    const paddedLocations = { data: [{ id: 88, name: padded, enabled: true, stockType: { id: 7 } }] }
    const paddedGrouped = grouped()
    paddedGrouped.data[0]!.items[0]!.stockLocation.name = padded
    const deps = dependencies([
      paddedLocations,
      paddedGrouped,
      detail({ stockLocation: { id: 88, name: padded } }),
      {},
      detail({ currentQty: 0, availableQty: 0, stockLocation: { id: 88, name: padded } }),
    ])

    await runCatalogInventoryZeroTradeSamplesJob(context, payload, deps)

    expect(deps.rpc.mock.calls.filter((call) => call[1] === 'store.inventory.item.adjust')).toHaveLength(1)
  })

  it('aborts before mutation for an extra target package or a non-sample', async () => {
    const extra = { ...detail(), id: '45', externalTrackCode: 'EXTRA' }
    for (const live of [grouped(false), grouped(true, [extra])]) {
      const deps = dependencies([locationList, live])
      await expect(runCatalogInventoryZeroTradeSamplesJob(context, payload, deps)).rejects.toThrow()
      expect(deps.rpc.mock.calls.some((call) => call[1] === 'store.inventory.item.adjust')).toBe(false)
    }
  })

  it('stops after an unknown adjustment/post-read result and persists terminal batch state', async () => {
    const deps = dependencies([locationList, grouped(), detail(), {}, detail({ currentQty: 1 })])
    await expect(runCatalogInventoryZeroTradeSamplesJob(context, payload, deps)).rejects.toThrow()
    expect(deps.rpc.mock.calls.filter((call) => call[1] === 'store.inventory.item.adjust')).toHaveLength(1)
    expect(deps.audit.mock.calls.at(-1)?.[1].eventType).toBe('trade_sample.zero.batch_result')
    expect(deps.audit.mock.calls.at(-1)?.[1].payload.outcomes).toEqual([{ inventoryItemId: '44', status: 'failed_unknown' }])
  })

  it('does not mutate when the attempted audit fails', async () => {
    const audit = vi.fn().mockRejectedValueOnce(new Error('audit unavailable')).mockResolvedValue(1)
    const deps = dependencies([locationList, grouped(), detail()], audit)
    await expect(runCatalogInventoryZeroTradeSamplesJob(context, payload, deps)).rejects.toThrow('audit unavailable')
    expect(deps.rpc.mock.calls.some((call) => call[1] === 'store.inventory.item.adjust')).toBe(false)
    expect(deps.audit.mock.calls.at(-1)?.[1].payload.outcomes).toEqual([{ inventoryItemId: '44', status: 'not_applied_audit_failure' }])
  })

  it('keeps a verified zero completed when its completion audit fails', async () => {
    const audit = vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('audit failed')).mockResolvedValue(1)
    const deps = dependencies([locationList, grouped(), detail(), {}, detail({ currentQty: 0, availableQty: 0 })], audit)
    await expect(runCatalogInventoryZeroTradeSamplesJob(context, payload, deps)).rejects.toThrow('audit failed')
    expect(deps.rpc.mock.calls.filter((call) => call[1] === 'store.inventory.item.adjust')).toHaveLength(1)
    expect(deps.audit.mock.calls.at(-1)?.[1].payload.outcomes).toEqual([{ inventoryItemId: '44', status: 'completed' }])
  })
})
