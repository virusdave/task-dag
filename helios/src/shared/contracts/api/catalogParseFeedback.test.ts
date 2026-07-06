import { describe, expect, it } from 'vitest'

import {
  ConventionProposalDetailsSchema,
  CreateParseFeedbackBodySchema,
  ListingCorrectionDetailsSchema,
  PARSE_FEEDBACK_ID_QUERY_LIMIT,
  ParseFeedbackListQuerySchema,
  ParseFeedbackRecordSchema,
} from './catalogParseFeedback.js'

// ---------------------------------------------------------------------------
// Contract tests for the parse-feedback inbox (issue #59, T3): the
// discriminated union, detail defaults, the bounded comma-id query, and the
// compound create body.
// ---------------------------------------------------------------------------

describe('ListingCorrectionDetailsSchema', () => {
  it('fills conservative defaults for an empty correction', () => {
    const parsed = ListingCorrectionDetailsSchema.parse({})
    expect(parsed.issueTypes).toEqual([])
    expect(parsed.packCount).toBeNull()
    expect(parsed.note).toBeNull()
  })

  it('rejects a non-positive pack count', () => {
    expect(ListingCorrectionDetailsSchema.safeParse({ packCount: 0 }).success).toBe(false)
    expect(ListingCorrectionDetailsSchema.safeParse({ packCount: -1 }).success).toBe(false)
  })

  it('rejects unknown fields (strict)', () => {
    expect(ListingCorrectionDetailsSchema.safeParse({ bogus: 1 }).success).toBe(false)
  })

  it('rejects an unknown issue chip', () => {
    expect(ListingCorrectionDetailsSchema.safeParse({ issueTypes: ['nope'] }).success).toBe(false)
  })
})

describe('ConventionProposalDetailsSchema', () => {
  it('requires a scope but defaults note/examples/chips', () => {
    const parsed = ConventionProposalDetailsSchema.parse({ scope: 'retailer_wide' })
    expect(parsed.scope).toBe('retailer_wide')
    expect(parsed.note).toBe('')
    expect(parsed.examples).toEqual([])
    expect(parsed.patternChips).toEqual([])
  })

  it('rejects a missing scope', () => {
    expect(ConventionProposalDetailsSchema.safeParse({}).success).toBe(false)
  })

  it('rejects an unknown pattern chip', () => {
    expect(
      ConventionProposalDetailsSchema.safeParse({ scope: 'listing_only', patternChips: ['nope'] })
        .success,
    ).toBe(false)
  })
})

describe('ParseFeedbackRecordSchema (discriminated union)', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    useCase: 'litalerts',
    sourceListingId: 'listing-1',
    fuzzySkuId: 42,
    retailerId: 7,
    rawListingName: 'x',
    inputHash: 'h',
    inputSnapshot: { retailerId: '7' },
    familyKey: 'fam',
    brandKey: 'brand',
    matchedCatalogProductId: 900,
    sourceFeedbackId: null,
    status: 'draft',
    createdBy: 'op',
    createdAt: '2026-07-06T10:00:00.000Z',
    updatedBy: 'op',
    updatedAt: '2026-07-06T10:00:00.000Z',
    statusChangedBy: null,
    statusChangedAt: null,
  }

  it('parses a listing_correction record with correction details', () => {
    const rec = ParseFeedbackRecordSchema.parse({
      ...base,
      kind: 'listing_correction',
      details: { issueTypes: ['size'], packCount: 1 },
    })
    expect(rec.kind).toBe('listing_correction')
  })

  it('parses a convention_proposal record with convention details', () => {
    const rec = ParseFeedbackRecordSchema.parse({
      ...base,
      kind: 'convention_proposal',
      details: { scope: 'retailer_category' },
    })
    expect(rec.kind).toBe('convention_proposal')
  })

  it('rejects a correction record carrying convention-only details', () => {
    // A convention payload (has `scope`, no correction fields) is invalid for a
    // listing_correction because the details schema is strict.
    expect(
      ParseFeedbackRecordSchema.safeParse({
        ...base,
        kind: 'listing_correction',
        details: { scope: 'retailer_category' },
      }).success,
    ).toBe(false)
  })
})

describe('ParseFeedbackListQuerySchema', () => {
  it('parses comma-separated ids into number arrays', () => {
    const parsed = ParseFeedbackListQuerySchema.parse({ fuzzySkuIds: '1, 2 ,3', retailerIds: '7' })
    expect(parsed.fuzzySkuIds).toEqual([1, 2, 3])
    expect(parsed.retailerIds).toEqual([7])
  })

  it('requires at least one id set', () => {
    expect(ParseFeedbackListQuerySchema.safeParse({}).success).toBe(false)
    expect(ParseFeedbackListQuerySchema.safeParse({ fuzzySkuIds: '', retailerIds: '' }).success).toBe(
      false,
    )
  })

  it('rejects non-integer ids', () => {
    expect(ParseFeedbackListQuerySchema.safeParse({ fuzzySkuIds: 'abc' }).success).toBe(false)
  })

  it('rejects more than the id cap', () => {
    const tooMany = Array.from({ length: PARSE_FEEDBACK_ID_QUERY_LIMIT + 1 }, (_, i) => i + 1).join(
      ',',
    )
    expect(ParseFeedbackListQuerySchema.safeParse({ fuzzySkuIds: tooMany }).success).toBe(false)
  })
})

describe('CreateParseFeedbackBodySchema', () => {
  it('accepts a correction-only save', () => {
    const parsed = CreateParseFeedbackBodySchema.parse({
      listingCorrection: {
        fuzzySkuId: 42,
        familyKey: 'fam',
        brandKey: null,
        matchedCatalogProductId: null,
        details: { issueTypes: ['size'] },
      },
    })
    expect(parsed.conventionProposal).toBeUndefined()
  })

  it('accepts a compound correction + convention save', () => {
    const parsed = CreateParseFeedbackBodySchema.parse({
      listingCorrection: {
        fuzzySkuId: 42,
        familyKey: 'fam',
        brandKey: 'brand',
        matchedCatalogProductId: 900,
        details: { issueTypes: ['brand'], brand: 'Real Brand' },
      },
      conventionProposal: { details: { scope: 'retailer_brand', brand: 'Real Brand' } },
    })
    expect(parsed.conventionProposal?.details.scope).toBe('retailer_brand')
  })

  it('requires a fuzzySkuId + non-empty familyKey on the correction', () => {
    expect(
      CreateParseFeedbackBodySchema.safeParse({
        listingCorrection: {
          brandKey: null,
          matchedCatalogProductId: null,
          details: {},
        },
      }).success,
    ).toBe(false)
  })
})
