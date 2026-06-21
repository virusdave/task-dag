import { describe, expect, it } from 'vitest'

import type {
  InventoryLifecycleAdvanceJobPayload,
  PurchaseLifecycleItem,
  PurchaseLifecycleRun,
} from '../../shared/contracts/index.js'
import type { LiveLot } from '../../server/catalogPurchaseSellThrough/purchaseInventoryLifecycleGates.js'
import type { RecentLifecycleAlert } from '../../server/catalogPurchaseSellThrough/purchaseInventoryLifecycleQueries.js'
import { DependencyUnavailableWorkerError } from '../runtime/errors.js'
import { LifecycleConflictError } from '../../server/catalogPurchaseSellThrough/purchaseInventoryLifecycleService.js'
import {
  alreadyAlerted,
  computeAlertConditions,
  detectBreach,
  executeInventoryLifecycleAdvance,
  isApprovalComplete,
  lotKey,
  selectAdvanceTargets,
  MARKET_TIMEOUT_MS,
  PRICE_APPLY_TIMEOUT_MS,
  type AdvanceDependencies,
  type AlertCondition,
  type DetectedBreachLot,
} from './inventoryLifecycleAdvanceJob.js'

const NOW = new Date('2026-06-21T12:00:00Z')

function item(overrides: Partial<PurchaseLifecycleItem> & { id: number; sweedProductId: number }): PurchaseLifecycleItem {
  return {
    lineId: `line-${overrides.id}`,
    inventoryItemId: `inv-${overrides.id}`,
    metrcTag: null,
    expectedQty: 10,
    quarantineVerifiedAt: null,
    quarantineStockLocation: null,
    quarantineCurrentQty: null,
    marketObservationCapturedAt: null,
    marketReadyAt: null,
    priceAppliedVerifiedAt: null,
    approvedPriceDollars: null,
    livePriceDollars: null,
    releaseTransferAttemptedAt: null,
    releaseTransferredAt: null,
    releaseVerifiedAt: null,
    releaseStockLocation: null,
    releaseCurrentQty: null,
    releaseLastError: null,
    notes: null,
    ...overrides,
  }
}

function run(overrides: Partial<PurchaseLifecycleRun> & { id: number }): PurchaseLifecycleRun {
  return {
    dealerId: 210249,
    poId: `PO-${overrides.id}`,
    siteKey: 'bronx',
    path: 'quarantine',
    state: 'pricing_pending',
    blockedReason: null,
    marketRequestedAt: null,
    pricingBatchId: null,
    expectedProductIds: [1001],
    version: 1,
    createdByUserId: null,
    notes: null,
    releaseTargetLocationId: null,
    releaseTargetLocationName: null,
    releaseRequestedAt: null,
    releasedAt: null,
    releaseLastError: null,
    createdAt: '2026-06-20T00:00:00Z',
    updatedAt: '2026-06-21T11:00:00Z',
    items: [item({ id: 1, sweedProductId: 1001 })],
    ...overrides,
  }
}

describe('isApprovalComplete', () => {
  it('is true only when every expected product is approved', () => {
    const r = run({ id: 1, expectedProductIds: [1, 2] })
    expect(isApprovalComplete(r, new Set([1, 2]))).toBe(true)
    expect(isApprovalComplete(r, new Set([1]))).toBe(false)
    expect(isApprovalComplete(r, new Set([1, 2, 3]))).toBe(true)
  })
  it('is false when there are no expected products', () => {
    expect(isApprovalComplete(run({ id: 1, expectedProductIds: [] }), new Set([1]))).toBe(false)
  })
})

describe('selectAdvanceTargets', () => {
  it('selects async-gate states and approved awaiting_price_approval only', () => {
    const runs = [
      run({ id: 1, state: 'market_refresh_pending' }),
      run({ id: 2, state: 'market_ready' }),
      run({ id: 3, state: 'pricing_pending' }),
      run({ id: 4, state: 'price_apply_pending' }),
      run({ id: 5, state: 'awaiting_price_approval' }), // not approved
      run({ id: 6, state: 'awaiting_price_approval' }), // approved
      run({ id: 7, state: 'quarantined' }),
      run({ id: 8, state: 'awaiting_receive_to_quarantine' }),
      run({ id: 9, state: 'priced_verified' }),
      run({ id: 10, state: 'blocked', blockedReason: 'pricing_failed' }),
    ]
    const selected = selectAdvanceTargets(runs, new Set([6]))
    expect(selected.map((r) => r.id)).toEqual([1, 2, 3, 4, 6])
  })
})

describe('detectBreach', () => {
  function liveLot(overrides: Partial<LiveLot> & { inventoryItemId: string }): LiveLot {
    return { metrcTag: null, qty: 5, stockLocationName: 'FOR SALE - Sales Floor', ...overrides }
  }

  it('flags a positive-qty expected lot back in a FOR SALE room', () => {
    const r = run({ id: 1, items: [item({ id: 1, sweedProductId: 1001, inventoryItemId: 'inv-1' })] })
    const live = new Map<string, LiveLot[]>([
      [lotKey(r.dealerId, 1001), [liveLot({ inventoryItemId: 'inv-1' })]],
    ])
    const breaches = detectBreach(r, live)
    expect(breaches).toHaveLength(1)
    expect(breaches[0]).toMatchObject({ itemId: 1, sweedProductId: 1001, stockLocation: 'FOR SALE - Sales Floor' })
  })

  it('does not flag a lot safely in a NOT-FOR-SALE room', () => {
    const r = run({ id: 1, items: [item({ id: 1, sweedProductId: 1001, inventoryItemId: 'inv-1' })] })
    const live = new Map<string, LiveLot[]>([
      [lotKey(r.dealerId, 1001), [liveLot({ inventoryItemId: 'inv-1', stockLocationName: 'NOT FOR SALE - Hold for Dave inspection' })]],
    ])
    expect(detectBreach(r, live)).toHaveLength(0)
  })

  it('matches by METRC tag when the inventory item id was re-issued', () => {
    const r = run({
      id: 1,
      items: [item({ id: 1, sweedProductId: 1001, inventoryItemId: 'old', metrcTag: 'TAG1' })],
    })
    const live = new Map<string, LiveLot[]>([
      [lotKey(r.dealerId, 1001), [liveLot({ inventoryItemId: 'new', metrcTag: 'TAG1' })]],
    ])
    expect(detectBreach(r, live)).toHaveLength(1)
  })
})

describe('computeAlertConditions', () => {
  it('flags a market timeout past the threshold', () => {
    const r = run({
      id: 1,
      state: 'market_refresh_pending',
      marketRequestedAt: new Date(NOW.getTime() - MARKET_TIMEOUT_MS - 1000).toISOString(),
    })
    const conds = computeAlertConditions([r], new Map(), NOW)
    expect(conds.map((c) => c.signature)).toContain('market_timeout')
  })

  it('does not flag a market refresh still within the threshold', () => {
    const r = run({
      id: 1,
      state: 'market_refresh_pending',
      marketRequestedAt: new Date(NOW.getTime() - 1000).toISOString(),
    })
    expect(computeAlertConditions([r], new Map(), NOW)).toHaveLength(0)
  })

  it('flags a price-apply timeout past the threshold', () => {
    const r = run({
      id: 1,
      state: 'price_apply_pending',
      updatedAt: new Date(NOW.getTime() - PRICE_APPLY_TIMEOUT_MS - 1000).toISOString(),
    })
    const conds = computeAlertConditions([r], new Map(), NOW)
    expect(conds.map((c) => c.signature)).toEqual(['price_apply_timeout'])
    expect(conds[0]!.priority).toBe(5)
  })

  it('flags a blocked run with a reason-specific signature and release severity', () => {
    const conds = computeAlertConditions(
      [
        run({ id: 1, state: 'blocked', blockedReason: 'pricing_failed' }),
        run({ id: 2, state: 'blocked', blockedReason: 'release_partial_failure' }),
      ],
      new Map(),
      NOW,
    )
    const bySig = new Map(conds.map((c) => [c.signature, c]))
    expect(bySig.get('blocked:pricing_failed')!.priority).toBe(4)
    expect(bySig.get('blocked:release_partial_failure')!.priority).toBe(5)
  })

  it('builds a quarantine-breach condition keyed by the breached product set', () => {
    const r = run({ id: 1, state: 'priced_verified', expectedProductIds: [1001, 1002] })
    const breaches: DetectedBreachLot[] = [
      { itemId: 1, inventoryItemId: 'inv-1', sweedProductId: 1002, stockLocation: 'FOR SALE - X', currentQty: 3 },
      { itemId: 2, inventoryItemId: 'inv-2', sweedProductId: 1001, stockLocation: 'FOR SALE - X', currentQty: 1 },
    ]
    const conds = computeAlertConditions([r], new Map([[1, breaches]]), NOW)
    expect(conds).toHaveLength(1)
    expect(conds[0]!.signature).toBe('quarantine_breach:1001,1002')
    expect(conds[0]!.priority).toBe(5)
  })
})

describe('alreadyAlerted', () => {
  function cond(overrides: Partial<AlertCondition> & { signature: string }): AlertCondition {
    return {
      runId: 1,
      dealerId: 210249,
      poId: 'PO-1',
      kind: 'blocked',
      message: 'x',
      priority: 4,
      onset: new Date(NOW.getTime() - 60_000),
      ...overrides,
    }
  }

  it('suppresses an onset-based alert paged after the onset', () => {
    const alerts: RecentLifecycleAlert[] = [
      { runId: 1, signature: 'blocked:pricing_failed', createdAt: new Date(NOW.getTime() - 30_000) },
    ]
    expect(alreadyAlerted(cond({ signature: 'blocked:pricing_failed' }), alerts, NOW)).toBe(true)
  })

  it('re-pages an onset-based alert whose prior page predates a new onset', () => {
    const alerts: RecentLifecycleAlert[] = [
      { runId: 1, signature: 'blocked:pricing_failed', createdAt: new Date(NOW.getTime() - 120_000) },
    ]
    expect(alreadyAlerted(cond({ signature: 'blocked:pricing_failed' }), alerts, NOW)).toBe(false)
  })

  it('suppresses a breach within the re-page window and re-pages a changed breach set', () => {
    const alerts: RecentLifecycleAlert[] = [
      { runId: 1, signature: 'quarantine_breach:1001', createdAt: new Date(NOW.getTime() - 3_600_000) },
    ]
    const sameSet = cond({ kind: 'quarantine_breach', signature: 'quarantine_breach:1001', onset: null })
    const changedSet = cond({ kind: 'quarantine_breach', signature: 'quarantine_breach:1001,1002', onset: null })
    expect(alreadyAlerted(sameSet, alerts, NOW)).toBe(true)
    expect(alreadyAlerted(changedSet, alerts, NOW)).toBe(false)
  })
})

// --------------------------- executor wiring -------------------------------

interface FakeState {
  tablesExist: boolean
  runs: PurchaseLifecycleRun[]
  approvedByBatch: Map<number, Map<number, number>>
  liveLots: Map<string, LiveLot[]>
  persistBreachResult: (dealerId: number, poId: string) => boolean
  repriceCalls: Array<{ dealerId: number; poId: string; version: number }>
  repriceThrows: Map<string, unknown>
  recentAlerts: RecentLifecycleAlert[]
  pages: string[]
  recorded: AlertCondition[]
  summaries: number
}

function fakeDeps(state: FakeState): AdvanceDependencies {
  return {
    tablesExist: async () => state.tablesExist,
    loadActiveRuns: async () => state.runs,
    loadApprovedPrices: async (batchId) => state.approvedByBatch.get(batchId) ?? new Map(),
    reprice: async (dealerId, poId, version) => {
      state.repriceCalls.push({ dealerId, poId, version })
      const thrown = state.repriceThrows.get(poId)
      if (thrown) throw thrown
    },
    readLiveLots: async () => state.liveLots,
    persistBreach: async (dealerId, poId) => state.persistBreachResult(dealerId, poId),
    loadRecentAlerts: async () => state.recentAlerts,
    page: async (message) => {
      state.pages.push(message)
    },
    recordAlert: async (cond) => {
      state.recorded.push(cond)
    },
    appendSummary: async () => {
      state.summaries += 1
    },
  }
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    tablesExist: true,
    runs: [],
    approvedByBatch: new Map(),
    liveLots: new Map(),
    persistBreachResult: () => true,
    repriceCalls: [],
    repriceThrows: new Map(),
    recentAlerts: [],
    pages: [],
    recorded: [],
    summaries: 0,
    ...overrides,
  }
}

const PAYLOAD: InventoryLifecycleAdvanceJobPayload = { trigger: 'scheduled', requestedByUserId: null }

describe('executeInventoryLifecycleAdvance', () => {
  it('no-ops when the lifecycle migration is not applied', async () => {
    const state = baseState({ tablesExist: false })
    const result = await executeInventoryLifecycleAdvance(PAYLOAD, fakeDeps(state), NOW)
    expect(result.migrationPending).toBe(true)
    expect(state.repriceCalls).toHaveLength(0)
    expect(state.summaries).toBe(0)
  })

  it('advances async-gate runs and counts conflicts without aborting', async () => {
    const state = baseState({
      runs: [
        run({ id: 1, poId: 'A', state: 'pricing_pending', path: 'reprice_in_place', version: 7 }),
        run({ id: 2, poId: 'B', state: 'market_ready', path: 'reprice_in_place' }),
        run({ id: 3, poId: 'C', state: 'quarantined', path: 'reprice_in_place' }),
      ],
      repriceThrows: new Map([['B', new LifecycleConflictError('raced')]]),
    })
    const result = await executeInventoryLifecycleAdvance(PAYLOAD, fakeDeps(state), NOW)
    expect(state.repriceCalls.map((c) => c.poId)).toEqual(['A', 'B'])
    expect(state.repriceCalls[0]).toMatchObject({ version: 7 })
    expect(result.advancedCount).toBe(1)
    expect(result.advanceConflictCount).toBe(1)
    expect(state.summaries).toBe(1)
  })

  it('advances awaiting_price_approval only once every product is approved', async () => {
    const state = baseState({
      runs: [
        run({ id: 1, poId: 'A', state: 'awaiting_price_approval', path: 'reprice_in_place', pricingBatchId: 50, expectedProductIds: [1, 2] }),
        run({ id: 2, poId: 'B', state: 'awaiting_price_approval', path: 'reprice_in_place', pricingBatchId: 51, expectedProductIds: [3, 4] }),
      ],
      approvedByBatch: new Map([
        [50, new Map([[1, 9.99], [2, 8.88]])],
        [51, new Map([[3, 5.0]])],
      ]),
    })
    await executeInventoryLifecycleAdvance(PAYLOAD, fakeDeps(state), NOW)
    expect(state.repriceCalls.map((c) => c.poId)).toEqual(['A'])
  })

  it('propagates Sweed pool exhaustion instead of burying it', async () => {
    const state = baseState({
      runs: [run({ id: 1, poId: 'A', state: 'pricing_pending', path: 'reprice_in_place' })],
      repriceThrows: new Map([['A', new DependencyUnavailableWorkerError('sweed pool empty')]]),
    })
    await expect(executeInventoryLifecycleAdvance(PAYLOAD, fakeDeps(state), NOW)).rejects.toBeInstanceOf(
      DependencyUnavailableWorkerError,
    )
  })

  it('pages a persisted breach but not one that raced out of a monitored state', async () => {
    const breached = run({
      id: 1,
      poId: 'A',
      state: 'priced_verified',
      path: 'quarantine',
      items: [item({ id: 1, sweedProductId: 1001, inventoryItemId: 'inv-1' })],
    })
    const raced = run({
      id: 2,
      poId: 'B',
      state: 'priced_verified',
      path: 'quarantine',
      items: [item({ id: 2, sweedProductId: 2002, inventoryItemId: 'inv-2' })],
    })
    const state = baseState({
      runs: [breached, raced],
      liveLots: new Map([
        [lotKey(breached.dealerId, 1001), [{ inventoryItemId: 'inv-1', metrcTag: null, qty: 4, stockLocationName: 'FOR SALE - Sales Floor' }]],
        [lotKey(raced.dealerId, 2002), [{ inventoryItemId: 'inv-2', metrcTag: null, qty: 4, stockLocationName: 'FOR SALE - Sales Floor' }]],
      ]),
      persistBreachResult: (_dealerId, poId) => poId === 'A',
    })
    const result = await executeInventoryLifecycleAdvance(PAYLOAD, fakeDeps(state), NOW)
    expect(result.breachRunCount).toBe(1)
    expect(state.pages).toHaveLength(1)
    expect(state.pages[0]).toContain('QUARANTINE BREACH')
    expect(state.recorded.map((c) => c.runId)).toEqual([1])
  })

  it('suppresses a page already recorded in the audit log', async () => {
    const blocked = run({ id: 1, poId: 'A', state: 'blocked', blockedReason: 'pricing_failed', path: 'reprice_in_place' })
    const state = baseState({
      runs: [blocked],
      recentAlerts: [
        { runId: 1, signature: 'blocked:pricing_failed', createdAt: new Date(NOW.getTime() - 10_000) },
      ],
    })
    const result = await executeInventoryLifecycleAdvance(PAYLOAD, fakeDeps(state), NOW)
    expect(state.pages).toHaveLength(0)
    expect(result.pagedCount).toBe(0)
  })
})
