import { describe, expect, it } from 'vitest'

import {
  buildPacketRowHierarchy,
  summarizePricingReviewDraft,
  type PricingReviewDraftGroupFollowUp,
  type PricingReviewDraftRow,
} from './bronxMidtownPricingReviewShared.js'

describe('bronxMidtownPricingReviewShared', () => {
  it('counts descendant products as outstanding when a hierarchy note stays open', () => {
    const weedubest28g = buildPacketRowHierarchy({
      brand: 'Weedubest',
      category: 'Flower',
      subcategory: null,
      variant: '28g',
    })
    const herb28g = buildPacketRowHierarchy({
      brand: 'Herb',
      category: 'Flower',
      subcategory: null,
      variant: '28g',
    })

    const rows: PricingReviewDraftRow[] = [
      {
        followUpNotes: [],
        include: true,
        productId: 101,
        reviewedPrice: '115.00',
        status: 'accepted',
      },
      {
        followUpNotes: [],
        include: true,
        productId: 102,
        reviewedPrice: '120.00',
        status: 'accepted',
      },
      {
        followUpNotes: [
          {
            completedAt: null,
            createdAt: '2026-05-01T00:00:00.000Z',
            id: 'note-row',
            text: 'Recheck this product later',
          },
        ],
        include: false,
        productId: 201,
        reviewedPrice: '99.00',
        status: 'rejected',
      },
    ]
    const groupFollowUpNotes: PricingReviewDraftGroupFollowUp[] = [
      {
        followUpNotes: [
          {
            completedAt: null,
            createdAt: '2026-05-01T00:00:00.000Z',
            id: 'note-group',
            text: 'Re-address the Weedubest 28g family after the first pass',
          },
        ],
        groupKey: weedubest28g.brandKey,
        groupLevel: 'brand',
        label: weedubest28g.brandScopeLabel,
      },
    ]

    const summary = summarizePricingReviewDraft(
      [
        { hierarchy: weedubest28g, productId: 101 },
        { hierarchy: weedubest28g, productId: 102 },
        { hierarchy: herb28g, productId: 201 },
      ],
      rows,
      groupFollowUpNotes,
    )

    expect(summary.outstandingGroupCount).toBe(1)
    expect(summary.outstandingNoteCount).toBe(2)
    expect(summary.outstandingProductCount).toBe(3)
    expect(summary.reviewedCount).toBe(3)
  })
})
