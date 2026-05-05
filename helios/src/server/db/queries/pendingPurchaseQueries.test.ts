import { describe, expect, it } from 'vitest'

import type { JsonValue } from '../../../shared/contracts/index.js'
import { __test__ } from './pendingPurchaseQueries.js'

function buildRow(
  rawRowJson: Record<string, unknown>,
): Parameters<typeof __test__.mapPendingPurchaseRow>[0] {
  const now = new Date('2026-05-05T00:00:00.000Z')

  return {
    action_type: 'catalog-create',
    approval_status: 'pending',
    approval_updated_at: null,
    applied_at: null,
    approved_by_user: null,
    catalog_action: 'Create the target row.',
    created_at: now,
    current_description: null,
    current_price: 24,
    distributor_product_id: 'dp-1',
    distributor_product_name: 'Example Pending Product',
    edited_primary_image_url: null,
    edited_proposed_description: null,
    edited_proposed_price: null,
    expected_category: 'Edibles',
    expected_subcategory: 'Gummies',
    id: 1,
    last_apply_error: null,
    last_apply_request_id: null,
    last_apply_status: 'not_requested',
    last_apply_summary_json: {},
    mapping_status: 'needs_catalog_create',
    market_advice_summary: null,
    notes: null,
    order_ids_json: [101],
    packet_id: 7,
    position_ids_json: [202],
    pricing_reason: 'Anchor-based draft price.',
    primary_image_note: null,
    primary_image_source: null,
    primary_image_url: null,
    proposed_description: null,
    proposed_price: 28,
    raw_row_json: rawRowJson as JsonValue,
    review_flags_json: [],
    row_input_signature: 'sig-1',
    site_dealer_id: 210705,
    site_dealer_name: 'Freshly Baked NYC - Midtown',
    site_key: 'midtown',
    site_label: 'Midtown',
    target_brand: 'Ayrloom',
    target_group_name: 'Ayrloom Gummies',
    target_variant_name: 'Ayrloom Black Cherry 5mg',
    updated_at: now,
    version: 3,
  }
}

describe('mapPendingPurchaseRow', () => {
  it('normalizes live generated pricing-market evidence into pending-purchase market listings', () => {
    const mapped = __test__.mapPendingPurchaseRow(buildRow({
      averageCompetitorPostTaxPrice: 29,
      averageCompetitorPrice: 25.66,
      pricingMarketEvidence: {
        averagePostTaxPrice: 29,
        averagePreTaxPrice: 25.66,
        dispensaryCount: 3,
        farAveragePostTaxPrice: null,
        farAveragePreTaxPrice: null,
        farListingCount: 0,
        listingCount: 3,
        matchedListings: [{
          category: 'Edibles',
          distanceBand: 'mid',
          distanceMiles: 2.1,
          dispensaryName: 'Example Midtown Shop',
          eligibleForPricing: true,
          exclusionReason: null,
          listingName: 'Ayrloom Black Cherry 5mg Gummies',
          matchTier: 'exact',
          postTaxPrice: 29,
          preTaxPrice: 25.66,
          source: 'nearby',
          url: 'https://example.com/listing',
        }],
        medianPostTaxPrice: 29,
        medianPreTaxPrice: 25.66,
        pricingEligibleDispensaryCount: 3,
        pricingEligibleListingCount: 3,
        searchTerm: 'Black Cherry 5mg',
        source: 'nearby',
      },
      pricingEvidenceNote: 'Matched Lit Alerts listings.',
    }))

    expect(mapped.marketListingCount).toBe(3)
    expect(mapped.marketEligibleListingCount).toBe(3)
    expect(mapped.marketDispensaryCount).toBe(3)
    expect(mapped.marketMedianPostTaxPrice).toBe(29)
    expect(mapped.marketSearchTerm).toBe('Black Cherry 5mg')
    expect(mapped.marketSource).toBe('nearby')
    expect(mapped.publicSources).toEqual(['https://example.com/listing'])
    expect(mapped.marketListings).toEqual([
      {
        category: 'Edibles',
        distanceBand: 'mid',
        distanceMiles: 2.1,
        dispensaryName: 'Example Midtown Shop',
        eligibleForPricing: true,
        exclusionReason: null,
        listingName: 'Ayrloom Black Cherry 5mg Gummies',
        matchTier: 'exact',
        postTaxPrice: 29,
        preTaxPrice: 25.66,
        source: 'nearby',
        url: 'https://example.com/listing',
      },
    ])
  })

  it('falls back to preserved legacy pricing evidence details when packets predate normalized market evidence', () => {
    const mapped = __test__.mapPendingPurchaseRow(buildRow({
      averageCompetitorPostTaxPrice: 46.33,
      averageCompetitorPrice: 41,
      competitorMedianPostTaxPrice: 46.33,
      pricingEvidenceNote: 'Legacy statewide Lit Alerts evidence was preserved for review.',
      pricingEvidenceSourceDetails: [{
        category: 'Vaporizers',
        dispensaryName: 'Indoor Treez - 8th Ave',
        distanceBucket: 'statewide',
        label: 'Indoor Treez - 8th Ave - AIO - BLUE LOBSTER - 1 G',
        listingName: 'AIO - BLUE LOBSTER - 1 G',
        postTaxPrice: 46.33,
        price: 41,
        pricingEligible: true,
        retailerDistanceMiles: null,
        url: 'https://legacy.example.com/listing',
      }],
      pricingEvidenceUrls: ['https://legacy.example.com/listing'],
    }))

    expect(mapped.marketNote).toBe('Legacy statewide Lit Alerts evidence was preserved for review.')
    expect(mapped.marketMedianPostTaxPrice).toBe(46.33)
    expect(mapped.marketSource).toBe('statewide')
    expect(mapped.publicSources).toEqual(['https://legacy.example.com/listing'])
    expect(mapped.marketListings).toEqual([
      {
        category: 'Vaporizers',
        distanceBand: 'unknown',
        distanceMiles: null,
        dispensaryName: 'Indoor Treez - 8th Ave',
        eligibleForPricing: true,
        exclusionReason: null,
        listingName: 'AIO - BLUE LOBSTER - 1 G',
        matchTier: 'fallback',
        postTaxPrice: 46.33,
        preTaxPrice: 41,
        source: 'statewide',
        url: 'https://legacy.example.com/listing',
      },
    ])
  })
})
