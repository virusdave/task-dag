import { describe, expect, it } from 'vitest'

import type {
  PurchaseLifecycleGateSummary,
  PurchaseLifecycleItem,
  PurchaseLifecycleRun,
  PurchaseLifecyclePath,
  PurchaseLifecycleState,
} from '../../../shared/contracts/index.js'
import {
  marketGateLabel,
  onFloorStockBadge,
  priceUnapprovedLabel,
  priceUnverifiedLabel,
  quarantineGateLabel,
  releaseButtonLabel,
  releaseGateLabel,
  repriceButtonLabel,
} from './purchaseLifecyclePanelLabels.js'

function item(overrides: Partial<PurchaseLifecycleItem> = {}): PurchaseLifecycleItem {
  return {
    id: 1,
    lineId: 'line-1',
    inventoryItemId: 'inv-1',
    sweedProductId: 100,
    metrcTag: null,
    expectedQty: null,
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

function run(overrides: Partial<PurchaseLifecycleRun> = {}): PurchaseLifecycleRun {
  return {
    id: 1,
    dealerId: 1,
    poId: 'PO-1',
    siteKey: 'site',
    path: 'quarantine' as PurchaseLifecyclePath,
    state: 'awaiting_receive_to_quarantine' as PurchaseLifecycleState,
    blockedReason: null,
    marketRequestedAt: null,
    pricingBatchId: null,
    expectedProductIds: [100],
    version: 1,
    createdByUserId: null,
    notes: null,
    releaseTargetLocationId: null,
    releaseTargetLocationName: null,
    releaseRequestedAt: null,
    releasedAt: null,
    releaseLastError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: [item()],
    ...overrides,
  }
}

const emptySummary: PurchaseLifecycleGateSummary = {
  quarantineSellableLotCount: 0,
  marketPendingProductIds: [],
  priceUnapprovedProductIds: [],
  priceUnverifiedProductIds: [],
  releaseUnverifiedLotCount: 0,
  productIdsWithOnFloorStock: [],
}

describe('quarantineGateLabel', () => {
  it('shows "Not checked yet" instead of a misleading 0 before verification', () => {
    expect(quarantineGateLabel(run(), emptySummary)).toEqual({
      text: 'Not checked yet',
      danger: false,
    })
  })

  it('shows "Skipped" on the reprice-in-place path', () => {
    expect(quarantineGateLabel(run({ path: 'reprice_in_place' }), emptySummary).text).toBe(
      'Skipped (reprice in place)',
    )
  })

  it('shows a real, non-danger 0 once quarantine has been checked and all lots passed', () => {
    const r = run({ items: [item({ quarantineVerifiedAt: '2026-01-02T00:00:00.000Z' })] })
    expect(quarantineGateLabel(r, emptySummary)).toEqual({ text: '0', danger: false })
  })

  it('flags a positive sellable count in danger after a check', () => {
    const r = run({ items: [item({ quarantineCurrentQty: 5, quarantineStockLocation: 'FOR SALE' })] })
    const summary = { ...emptySummary, quarantineSellableLotCount: 1 }
    expect(quarantineGateLabel(r, summary)).toEqual({ text: '1', danger: true })
  })
})

describe('marketGateLabel', () => {
  it('shows "Not requested yet" before any market pull', () => {
    expect(marketGateLabel(run(), emptySummary)).toBe('Not requested yet')
  })

  it('shows the pending product count once a pull was requested', () => {
    const r = run({ marketRequestedAt: '2026-01-02T00:00:00.000Z' })
    const summary = { ...emptySummary, marketPendingProductIds: [100, 200] }
    expect(marketGateLabel(r, summary)).toBe('2')
  })
})

describe('price labels', () => {
  it('show "No pricing batch yet" before a batch exists', () => {
    expect(priceUnapprovedLabel(run(), emptySummary)).toBe('No pricing batch yet')
    expect(priceUnverifiedLabel(run(), emptySummary)).toBe('No pricing batch yet')
  })

  it('show "Batch generating…" while the batch is still drafting', () => {
    const r = run({ pricingBatchId: 7, state: 'pricing_pending' })
    expect(priceUnapprovedLabel(r, emptySummary)).toBe('Batch generating…')
    expect(priceUnverifiedLabel(r, emptySummary)).toBe('Batch generating…')
  })

  it('show real counts once the batch is ready', () => {
    const r = run({ pricingBatchId: 7, state: 'awaiting_price_approval' })
    const summary = {
      ...emptySummary,
      priceUnapprovedProductIds: [100],
      priceUnverifiedProductIds: [100, 200],
    }
    expect(priceUnapprovedLabel(r, summary)).toBe('1')
    expect(priceUnverifiedLabel(r, summary)).toBe('2')
  })
})

describe('repriceButtonLabel', () => {
  it('matches the discrete step each state performs', () => {
    expect(repriceButtonLabel('market_refresh_pending')).toBe('Check market gate')
    expect(repriceButtonLabel('market_ready')).toBe('Create pricing batch')
    expect(repriceButtonLabel('pricing_pending')).toBe('Check pricing batch')
    expect(repriceButtonLabel('awaiting_price_approval')).toBe('Re-verify applied prices')
    expect(repriceButtonLabel('price_apply_pending')).toBe('Re-verify applied prices')
  })
})

describe('releaseGateLabel', () => {
  it('shows "Not released yet" instead of a misleading 0 before any release attempt', () => {
    expect(releaseGateLabel(run({ state: 'priced_verified' }), emptySummary)).toEqual({
      text: 'Not released yet',
      danger: false,
    })
  })

  it('skips the release gate entirely on the reprice-in-place path', () => {
    expect(releaseGateLabel(run({ path: 'reprice_in_place' }), emptySummary)).toEqual({
      text: 'Skipped (reprice in place)',
      danger: false,
    })
  })

  it('shows the unverified-lot count (danger) once a release is in progress', () => {
    expect(
      releaseGateLabel(run({ state: 'release_in_progress' }), {
        ...emptySummary,
        releaseUnverifiedLotCount: 2,
      }),
    ).toEqual({ text: '2', danger: true })
  })

  it('shows a real, non-danger 0 once every lot is released and verified', () => {
    expect(
      releaseGateLabel(run({ state: 'released', releaseRequestedAt: '2026-01-02T00:00:00.000Z' }), emptySummary),
    ).toEqual({ text: '0', danger: false })
  })

  it('counts a per-item release attempt as "attempted" even before the run flips state', () => {
    const r = run({
      state: 'priced_verified',
      items: [item({ releaseTransferAttemptedAt: '2026-01-02T00:00:00.000Z' })],
    })
    expect(releaseGateLabel(r, { ...emptySummary, releaseUnverifiedLotCount: 1 })).toEqual({
      text: '1',
      danger: true,
    })
  })
})

describe('onFloorStockBadge', () => {
  it('returns null when no SKU has on-floor stock', () => {
    expect(onFloorStockBadge(emptySummary)).toBeNull()
  })

  it('pluralizes the badge by SKU count', () => {
    expect(onFloorStockBadge({ ...emptySummary, productIdsWithOnFloorStock: [1] })).toBe(
      '1 SKU already has on-floor stock',
    )
    expect(onFloorStockBadge({ ...emptySummary, productIdsWithOnFloorStock: [1, 2] })).toBe(
      '2 SKUs already have on-floor stock',
    )
  })
})

describe('releaseButtonLabel', () => {
  it('says "Release to FOR SALE" for a fresh release', () => {
    expect(releaseButtonLabel('priced_verified')).toBe('Release to FOR SALE')
  })

  it('says "Continue release" while an attempt is in progress', () => {
    expect(releaseButtonLabel('release_in_progress')).toBe('Continue release')
  })
})
