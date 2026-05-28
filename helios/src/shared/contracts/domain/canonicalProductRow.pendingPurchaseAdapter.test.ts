import { describe, expect, it } from 'vitest'

import { CanonicalProductRowSchema } from './canonicalProductRow.js'
import { pendingPurchaseToCanonicalRow } from './canonicalProductRow.pendingPurchaseAdapter.js'
import { PendingPurchaseRowSchema, type PendingPurchaseRow } from './pendingPurchases.js'

function buildRow(overrides: Partial<PendingPurchaseRow> = {}): PendingPurchaseRow {
  // Round-trip through PendingPurchaseRowSchema so we exercise the
  // same defaults / coercions a real loader would, and so that any
  // schema drift breaks this test fixture loudly.
  return PendingPurchaseRowSchema.parse({
    actionType: 'price_only',
    approvalStatus: 'pending',
    approvalUpdatedAt: null,
    averageCompetitorPostTaxPrice: 42.5,
    averageCompetitorPrice: 38.0,
    appliedAt: null,
    approvedByUser: null,
    catalogAction: 'reprice_existing_product',
    createdAt: '2026-05-01T00:00:00.000Z',
    currentDescription: 'Live description.',
    currentGmPercent: 0.45,
    currentPrice: 40.0,
    currentPriceBasis: 'sweed',
    distributorProductId: 'D-1234',
    distributorProductName: 'Sample Product 3.5g',
    editedPrimaryImageUrl: null,
    editedProposedDescription: null,
    editedProposedPrice: null,
    editedStructuredFields: null,
    effectivePrimaryImageUrl: null,
    effectiveProposedDescription: 'Proposed description.',
    effectiveProposedPrice: 45.0,
    effectiveUnitCost: 18.0,
    effectiveUnitCostSource: 'distributor_csv',
    expectedCategory: 'Flower',
    expectedSubcategory: 'Indoor',
    existingDistributorLinks: null,
    gmPercent: 0.5,
    lastApplyError: null,
    lastApplyRequestId: null,
    lastApplyStatus: 'not_requested',
    lastApplySummary: {},
    marketDispensaryCount: 4,
    marketEligibleListingCount: 6,
    marketListingCount: 8,
    marketListings: [],
    marketMedianPostTaxPrice: 44.0,
    marketMedianPreTaxPrice: 40.0,
    marketNote: null,
    marketSearchTerm: 'sample 3.5g',
    marketSource: 'nearby',
    mappingStatus: 'mapped_variant_ready_for_link',
    needsNewBrand: false,
    needsNewGroup: false,
    needsNewVariant: false,
    marketAdviceConfidence: 'high',
    marketAdvicePosture: 'follow',
    marketAdviceSummary: 'Market clusters near $44.',
    notes: 'Reviewer note.',
    orderIds: [1, 2],
    packetId: 77,
    positionIds: [11, 12],
    pricingAction: 'increase',
    pricingReason: 'Market median above current.',
    primaryImageNote: null,
    primaryImageSource: 'distributor',
    primaryImageUrl: 'https://example.invalid/img.png',
    publicSources: ['litalerts'],
    proposedDescription: 'Proposed description.',
    proposedPrice: 45.0,
    reuseGroupId: 555,
    reuseProductId: 999,
    reuseProductName: 'Sample Product (Flower / Indoor / 3.5g)',
    reviewFlags: [],
    reviewerNotes: null,
    rowId: 123,
    rowInputSignature: null,
    sampleLike: false,
    siteDealerId: 17,
    siteDealerName: 'Distributor X',
    siteKey: 'distributor-x',
    siteLabel: 'Distributor X',
    suggestionCandidates: [],
    targetBrand: 'Sample Brand',
    targetGroupName: 'Sample Group',
    targetPackCount: 1,
    targetPrevalence: 'common',
    targetSize: '3.5g',
    targetStrain: 'Sample Strain',
    targetVariantName: 'Indoor',
    targetVariantTab: 'Flower',
    updatedAt: '2026-05-02T00:00:00.000Z',
    version: 3,
    ...overrides,
  })
}

describe('pendingPurchaseToCanonicalRow', () => {
  it('produces a CanonicalProductRowSchema-valid row for the happy path', () => {
    const row = buildRow()
    const canonical = pendingPurchaseToCanonicalRow(row)
    expect(() => CanonicalProductRowSchema.parse(canonical)).not.toThrow()
    expect(canonical.rowId).toBe('pp:123')
    expect(canonical.source).toEqual({ kind: 'pending_purchase', packetId: 77, rowId: 123 })
    expect(canonical.catalogGroupId).toBe(555)
    expect(canonical.family).toEqual({
      brand: 'Sample Brand',
      category: 'Flower',
      subcategory: 'Indoor',
      sizeName: '3.5g',
    })
    expect(canonical.approvalRollup).toBe('pending')
    expect(canonical.operatorNote).toBe('Reviewer note.')
    expect(canonical.executionPreview.mechanism).toBe('direct_catalog_write')
  })

  it('prefers structured-fields overrides for the family key', () => {
    const row = buildRow({
      editedStructuredFields: {
        targetBrand: 'Overridden Brand',
        expectedCategory: 'Pre-rolls',
      },
    })
    const canonical = pendingPurchaseToCanonicalRow(row)
    expect(canonical.family.brand).toBe('Overridden Brand')
    expect(canonical.family.category).toBe('Pre-rolls')
    // Keys absent from the override fall back to the parser value.
    expect(canonical.family.subcategory).toBe('Indoor')
    expect(canonical.family.sizeName).toBe('3.5g')
  })

  it('allows the structured-fields override to NULL out a parser-supplied key', () => {
    const row = buildRow({
      editedStructuredFields: { targetBrand: null },
    })
    const canonical = pendingPurchaseToCanonicalRow(row)
    expect(canonical.family.brand).toBeNull()
    // Other parser keys still flow through.
    expect(canonical.family.category).toBe('Flower')
  })

  it('flags create_new_catalog_entities when any needsNew* is true', () => {
    const row = buildRow({ needsNewBrand: true, needsNewGroup: true })
    const canonical = pendingPurchaseToCanonicalRow(row)
    expect(canonical.executionPreview.mechanism).toBe('create_new_catalog_entities')
    expect(canonical.executionPreview.needsNewBrand).toBe(true)
    expect(canonical.executionPreview.needsNewGroup).toBe(true)
    expect(canonical.executionPreview.summary).toContain('creates new')
  })

  it('emits approve/reject ops only while the row is pending', () => {
    const pendingRow = buildRow({ approvalStatus: 'pending' })
    const pendingCanonical = pendingPurchaseToCanonicalRow(pendingRow)
    expect(pendingCanonical.actions.approveOps).toHaveLength(1)
    expect(pendingCanonical.actions.rejectOps).toHaveLength(1)
    expect(pendingCanonical.actions.approveOps[0].url).toBe('/api/catalog/pending-purchases/123/approval')
    expect(pendingCanonical.actions.approveOps[0].expectedVersion).toBe(3)

    const approvedRow = buildRow({ approvalStatus: 'approved' })
    const approvedCanonical = pendingPurchaseToCanonicalRow(approvedRow)
    expect(approvedCanonical.actions.approveOps).toHaveLength(0)
    expect(approvedCanonical.actions.rejectOps).toHaveLength(0)
  })

  it('emits a pricing ladder when the row is bound to a Sweed product', () => {
    const row = buildRow()
    const canonical = pendingPurchaseToCanonicalRow(row)
    expect(canonical.pricingLadder).not.toBeNull()
    expect(canonical.pricingLadder?.productId).toBe(999)
    expect(canonical.pricingLadder?.livePrice).toBe(40.0)
    expect(canonical.pricingLadder?.proposedPrice).toBe(45.0)
  })

  it('omits the pricing ladder when the row has no bound Sweed product yet', () => {
    const row = buildRow({ reuseProductId: null })
    const canonical = pendingPurchaseToCanonicalRow(row)
    expect(canonical.pricingLadder).toBeNull()
  })

  it('leaves field editUrls null until the per-field body-shape gap is reconciled', () => {
    // Gap #2 in the adapter header: pp PATCH wants named keys
    // (editedProposedPrice etc.) but CanonicalRowApplyOp emits
    // { editedValue, expectedVersion }. Until reconciled the
    // canonical UI treats every field as read-only and the host
    // page owns the inline editors.
    const row = buildRow()
    const canonical = pendingPurchaseToCanonicalRow(row)
    for (const field of canonical.fields) {
      expect(field.editUrl).toBeNull()
    }
  })
})
