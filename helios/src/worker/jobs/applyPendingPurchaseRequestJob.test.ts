import { describe, expect, it } from 'vitest'

import {
  buildPendingPurchaseSuggestionVerification,
  readInactiveReuseTargetReason,
} from './applyPendingPurchaseRequestJob.js'

describe('readInactiveReuseTargetReason', () => {
  const activeProduct = { enabled: true, id: 83257, name: 'Blue Dream 1.5g' }
  const activeGroup = { brand: { id: 22, name: 'Dumbo' }, enabled: true, name: 'Electric' }

  it('accepts an active product, group, and brand', () => {
    expect(readInactiveReuseTargetReason(activeProduct, activeGroup)).toBeNull()
  })

  it.each([
    [{ ...activeProduct, enabled: false }, activeGroup],
    [activeProduct, { ...activeGroup, enabled: false }],
    [{ ...activeProduct, name: 'DEAD - Blue Dream 1.5g' }, activeGroup],
    [activeProduct, { ...activeGroup, name: 'RETIRED Electric' }],
    [activeProduct, { ...activeGroup, brand: { id: 22, name: 'DELETED Dumbo' } }],
  ])('blocks disabled and soft-retired targets', (product, group) => {
    expect(readInactiveReuseTargetReason(product, group)).toContain('disabled or retired Sweed product 83257')
  })
})

describe('buildPendingPurchaseSuggestionVerification', () => {
  it('marks verification as passed when every relevant position suggests the target product', () => {
    const summary = buildPendingPurchaseSuggestionVerification({
      orders: [
        {
          orderId: 108224,
          positionChecks: [
            {
              manualFollowUpRequired: false,
              positionId: 664204,
              status: 'target_suggested',
              suggestedProducts: [{ productId: 83257, productName: 'Dumbo Electric Blue Dream 1.5g', score: 98 }],
            },
          ],
        },
      ],
      targetProductName: 'Dumbo Electric Blue Dream 1.5g',
    })

    expect(summary.overallStatus).toBe('verified')
    expect(summary.manualFollowUpPositionCount).toBe(0)
    expect(summary.summaryText).toContain('now proposes Dumbo Electric Blue Dream 1.5g for all 1 relevant purchase position')
  })

  it('surfaces manual follow-up when suggestion verification still misses positions', () => {
    const summary = buildPendingPurchaseSuggestionVerification({
      orders: [
        {
          orderId: 108224,
          positionChecks: [
            {
              manualFollowUpRequired: false,
              positionId: 664204,
              status: 'target_suggested',
              suggestedProducts: [{ productId: 83257, productName: 'Dumbo Electric Blue Dream 1.5g', score: 98 }],
            },
            {
              manualFollowUpRequired: true,
              positionId: 664206,
              status: 'still_unresolved',
              suggestedProducts: [],
            },
          ],
        },
      ],
      targetProductName: 'Dumbo Electric Blue Dream 1.5g',
    })

    expect(summary.overallStatus).toBe('manual_follow_up_required')
    expect(summary.manualFollowUpOrderCount).toBe(1)
    expect(summary.manualFollowUpPositionCount).toBe(1)
    expect(summary.orders[0]?.manualFollowUpPositionIds).toEqual([664206])
    expect(summary.summaryText).toContain('manual purchase-side follow-up is still required')
  })
})
