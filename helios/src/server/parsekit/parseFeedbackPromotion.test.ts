import { describe, expect, it } from 'vitest'

import {
  ListingCorrectionDetailsSchema,
  ConventionProposalDetailsSchema,
  type ConventionProposalFeedbackRecord,
  type ListingCorrectionDetails,
  type ListingCorrectionFeedbackRecord,
  type ParseFeedbackRecord,
} from '../../shared/contracts/index.js'
import { buildPromotionExportGroups } from './parseFeedbackPromotion.js'

// ---------------------------------------------------------------------------
// Pure-mapper tests for the T5 promotion export. Deterministic and
// prod-resource-free: they build ParseFeedbackRecord literals and assert the
// grouping, best-effort projection, golden validity gating, and convention
// linkage — no DB, no clock, no randomness.
// ---------------------------------------------------------------------------

function correction(
  id: string,
  overrides: {
    dispensaryName?: string | null
    details?: Partial<ListingCorrectionDetails>
    rawListingName?: string | null
    status?: ListingCorrectionFeedbackRecord['status']
  } = {},
): ListingCorrectionFeedbackRecord {
  const details = ListingCorrectionDetailsSchema.parse(overrides.details ?? {})
  return {
    id,
    kind: 'listing_correction',
    useCase: 'litalerts',
    sourceListingId: `listing-${id}`,
    fuzzySkuId: 42,
    retailerId: 7,
    rawListingName: overrides.rawListingName ?? 'Bayside - Fuel Pump Dime Bag - .7g',
    inputHash: 'hash-abc',
    inputSnapshot:
      overrides.dispensaryName === undefined
        ? { dispensaryName: 'Bayside Cannabis' }
        : overrides.dispensaryName === null
          ? {}
          : { dispensaryName: overrides.dispensaryName },
    familyKey: 'fam-1',
    brandKey: 'brand-1',
    matchedCatalogProductId: null,
    sourceFeedbackId: null,
    status: overrides.status ?? 'promotion_requested',
    promotedParserId: null,
    promotedRuleId: null,
    promotedConfigSha: null,
    createdBy: 'op@example.com',
    createdAt: '2026-07-06T10:00:00.000Z',
    updatedBy: 'op@example.com',
    updatedAt: '2026-07-06T10:00:00.000Z',
    details,
  }
}

function convention(id: string, sourceFeedbackId: string): ConventionProposalFeedbackRecord {
  return {
    id,
    kind: 'convention_proposal',
    useCase: 'litalerts',
    sourceListingId: 'listing-x',
    fuzzySkuId: 42,
    retailerId: 7,
    rawListingName: null,
    inputHash: null,
    inputSnapshot: { dispensaryName: 'Bayside Cannabis' },
    familyKey: 'fam-1',
    brandKey: 'brand-1',
    matchedCatalogProductId: null,
    sourceFeedbackId,
    status: 'draft',
    promotedParserId: null,
    promotedRuleId: null,
    promotedConfigSha: null,
    createdBy: 'op@example.com',
    createdAt: '2026-07-06T11:00:00.000Z',
    updatedBy: 'op@example.com',
    updatedAt: '2026-07-06T11:00:00.000Z',
    details: ConventionProposalDetailsSchema.parse({
      scope: 'retailer_category',
      note: 'brand first, size at end',
      examples: ['Bayside - Fuel Pump Dime Bag - .7g'],
      patternChips: ['brand_first', 'size_at_end'],
    }),
  }
}

const FULL_DETAILS: Partial<ListingCorrectionDetails> = {
  brand: 'Bayside',
  strain: 'Fuel Pump Dime Bag',
  category: 'flower',
  packCount: 1,
  unitSizeValue: 0.7,
  unitSizeUnit: 'g',
  totalSizeValue: 0.7,
  totalSizeUnit: 'g',
}

describe('buildPromotionExportGroups', () => {
  it('groups by parsekit tenant derived from dispensaryName and sets parserId/configPath', () => {
    const { groups, totalCorrections } = buildPromotionExportGroups(
      7,
      [correction('11111111-1111-4111-8111-111111111111', { details: FULL_DETAILS })],
      new Map(),
    )
    expect(totalCorrections).toBe(1)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.tenantId).toBe('bayside-cannabis')
    expect(groups[0]!.parserId).toBe('litalerts.bayside-cannabis')
    expect(groups[0]!.configPath).toBe('use-cases/litalerts/parsers/bayside-cannabis.jsonc')
    expect(groups[0]!.dispensaryName).toBe('Bayside Cannabis')
    expect(groups[0]!.useCase).toBe('litalerts')
  })

  it('emits a ready parsekit golden when the correction forms a full valid descriptor', () => {
    const { groups } = buildPromotionExportGroups(
      7,
      [correction('11111111-1111-4111-8111-111111111111', { details: FULL_DETAILS })],
      new Map(),
    )
    const c = groups[0]!.corrections[0]!
    expect(c.issues).toEqual([])
    expect(c.parsekitGolden).not.toBeNull()
    expect(c.parsekitGolden!.kind).toBe('match')
    expect(c.parsekitGolden!.id).toBe('bayside-cannabis.11111111-1111-4111-8111-111111111111')
    expect(c.parsekitGolden!.input).toBe('Bayside - Fuel Pump Dime Bag - .7g')
    expect(c.parsekitGolden!.expected).toMatchObject({
      brand: 'Bayside',
      category: 'flower',
      packCount: 1,
      unitSize: { value: 0.7, unit: 'g' },
      totalSize: { value: 0.7, unit: 'g' },
      variantName: 'Fuel Pump Dime Bag',
    })
  })

  it('normalizes common unit/category spellings into parsekit enums', () => {
    const { groups } = buildPromotionExportGroups(
      7,
      [
        correction('11111111-1111-4111-8111-111111111111', {
          details: {
            brand: 'Anthem',
            strain: 'Hybrid Blend',
            category: 'Pre-Rolls',
            packCount: 1,
            unitSizeValue: 100,
            unitSizeUnit: 'milligrams',
            totalSizeValue: 100,
            totalSizeUnit: 'mg',
          },
        }),
      ],
      new Map(),
    )
    const c = groups[0]!.corrections[0]!
    expect(c.parsekitGolden).not.toBeNull()
    expect(c.parsekitGolden!.expected).toMatchObject({
      category: 'preroll',
      unitSize: { value: 100, unit: 'mg' },
    })
  })

  it('withholds the golden with issues when required fields are missing', () => {
    const { groups } = buildPromotionExportGroups(
      7,
      [
        correction('11111111-1111-4111-8111-111111111111', {
          details: { brand: 'Bayside' /* no category, no sizes */ },
        }),
      ],
      new Map(),
    )
    const c = groups[0]!.corrections[0]!
    expect(c.parsekitGolden).toBeNull()
    expect(c.issues).toContain('missing corrected category')
    expect(c.issues).toContain('missing corrected unit size (value + unit)')
    // best-effort projection still surfaces what the operator DID give us.
    expect(c.bestEffortExpected.brand).toBe('Bayside')
    expect(c.bestEffortExpected.unitSize).toBeNull()
    // the raw correction is preserved verbatim for the reviewer.
    expect(c.rawCorrection.brand).toBe('Bayside')
  })

  it('flags an unparseable category/unit rather than silently dropping it', () => {
    const { groups } = buildPromotionExportGroups(
      7,
      [
        correction('11111111-1111-4111-8111-111111111111', {
          details: {
            brand: 'Bayside',
            category: 'widgets',
            unitSizeValue: 1,
            unitSizeUnit: 'furlongs',
            totalSizeValue: 1,
            totalSizeUnit: 'furlongs',
          },
        }),
      ],
      new Map(),
    )
    const c = groups[0]!.corrections[0]!
    expect(c.parsekitGolden).toBeNull()
    expect(c.issues).toContain('category "widgets" is not a parsekit category')
    expect(c.issues).toContain('unit "furlongs" is not a parsekit size unit')
  })

  it('attaches linked convention proposals to their correction', () => {
    const cid = '11111111-1111-4111-8111-111111111111'
    const conventions = new Map<string, ParseFeedbackRecord[]>([
      [cid, [convention('22222222-2222-4222-8222-222222222222', cid)]],
    ])
    const { groups } = buildPromotionExportGroups(
      7,
      [correction(cid, { details: FULL_DETAILS })],
      conventions,
    )
    const c = groups[0]!.corrections[0]!
    expect(c.conventionProposals).toHaveLength(1)
    expect(c.conventionProposals[0]!.id).toBe('22222222-2222-4222-8222-222222222222')
    expect(c.conventionProposals[0]!.details.patternChips).toEqual(['brand_first', 'size_at_end'])
  })

  it('falls back to a per-retailer tenant id when the dispensary name is blank', () => {
    const { groups } = buildPromotionExportGroups(
      7,
      [correction('11111111-1111-4111-8111-111111111111', { dispensaryName: null, details: FULL_DETAILS })],
      new Map(),
    )
    expect(groups[0]!.tenantId).toBe('retailer-7')
    expect(groups[0]!.parserId).toBe('litalerts.retailer-7')
    expect(groups[0]!.dispensaryName).toBeNull()
  })

  it('orders groups by tenant id deterministically', () => {
    const { groups } = buildPromotionExportGroups(
      7,
      [
        correction('11111111-1111-4111-8111-111111111111', {
          dispensaryName: 'Zenith Dispensary',
          details: FULL_DETAILS,
        }),
        correction('33333333-3333-4333-8333-333333333333', {
          dispensaryName: 'Apex Cannabis',
          details: FULL_DETAILS,
        }),
      ],
      new Map(),
    )
    expect(groups.map((g) => g.tenantId)).toEqual(['apex-cannabis', 'zenith-dispensary'])
  })
})
