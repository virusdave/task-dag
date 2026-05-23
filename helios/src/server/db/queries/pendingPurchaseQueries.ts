/**
 * Pending-purchase row loader used by the reviewer-facing list endpoint.
 *
 * The persisted shape of `pending_purchase_rows` carries a small number of
 * normalized columns plus a `raw_row_json` blob that the generate/import
 * pipelines fill with the rest of the reviewer fields (market evidence,
 * suggestion candidates, parser metadata, etc.). The shared contract
 * `PendingPurchaseRowSchema` expects the merged view, so this loader pulls
 * the columns, reads the rich fields out of `raw_row_json`, computes the
 * `effective*` overrides, and joins to `users` for the approver display
 * name.
 */

import type { Pool, QueryResultRow } from 'pg'

import type {
  JsonValue,
  PendingPurchaseApprovalStatus,
  PendingPurchaseMappingStatus,
  PendingPurchaseMarketListing,
  PendingPurchaseRow,
  PendingPurchaseRowApplyStatus,
  PendingPurchaseSuggestionCandidate,
} from '../../../shared/contracts/index.js'

interface PendingPurchaseRowDbRow extends QueryResultRow {
  action_type: string
  applied_at: Date | null
  approval_status: PendingPurchaseApprovalStatus
  approval_updated_at: Date | null
  approved_by_user_name: string | null
  catalog_action: string
  created_at: Date
  current_description: string | null
  current_price: string | null
  distributor_product_id: string
  distributor_product_name: string
  edited_primary_image_url: string | null
  edited_proposed_description: string | null
  edited_proposed_price: string | null
  expected_category: string | null
  expected_subcategory: string | null
  id: string
  last_apply_error: string | null
  last_apply_request_id: string | null
  last_apply_status: PendingPurchaseRowApplyStatus
  last_apply_summary_json: JsonValue
  mapping_status: PendingPurchaseMappingStatus
  market_advice_summary: string | null
  notes: string | null
  order_ids_json: JsonValue
  packet_id: string
  position_ids_json: JsonValue
  pricing_reason: string | null
  primary_image_note: string | null
  primary_image_source: string | null
  primary_image_url: string | null
  proposed_description: string | null
  proposed_price: string | null
  raw_row_json: JsonValue
  review_flags_json: JsonValue
  row_input_signature: string | null
  site_dealer_id: string | null
  site_dealer_name: string | null
  site_key: string
  site_label: string
  target_brand: string | null
  target_group_name: string | null
  target_variant_name: string | null
  updated_at: Date
  version: number
}

export async function listPendingPurchaseRows(
  pool: Pool,
  packetId: number,
): Promise<PendingPurchaseRow[]> {
  const result = await pool.query<PendingPurchaseRowDbRow>(
    `
      select
        r.id,
        r.packet_id,
        r.action_type,
        r.applied_at,
        r.approval_status,
        r.approval_updated_at,
        u.name as approved_by_user_name,
        r.catalog_action,
        r.created_at,
        r.current_description,
        r.current_price,
        r.distributor_product_id,
        r.distributor_product_name,
        r.edited_primary_image_url,
        r.edited_proposed_description,
        r.edited_proposed_price,
        r.expected_category,
        r.expected_subcategory,
        r.last_apply_error,
        r.last_apply_request_id,
        r.last_apply_status,
        r.last_apply_summary_json,
        r.mapping_status,
        r.market_advice_summary,
        r.notes,
        r.order_ids_json,
        r.position_ids_json,
        r.pricing_reason,
        r.primary_image_note,
        r.primary_image_source,
        r.primary_image_url,
        r.proposed_description,
        r.proposed_price,
        r.raw_row_json,
        r.review_flags_json,
        r.row_input_signature,
        r.site_dealer_id,
        r.site_dealer_name,
        r.site_key,
        r.site_label,
        r.target_brand,
        r.target_group_name,
        r.target_variant_name,
        r.updated_at,
        r.version
      from pending_purchase_rows r
      left join users u on u.id = r.approved_by_user_id
      where r.packet_id = $1
      order by r.id asc
    `,
    [packetId],
  )
  return result.rows.map(mapPendingPurchaseRow)
}

function mapPendingPurchaseRow(row: PendingPurchaseRowDbRow): PendingPurchaseRow {
  const raw = readRecord(row.raw_row_json)
  const editedProposedPrice = readNumberFromString(row.edited_proposed_price)
  const proposedPrice = readNumberFromString(row.proposed_price)
  const currentPrice = readNumberFromString(row.current_price)
  const effectiveProposedPrice = editedProposedPrice ?? proposedPrice
  const effectiveProposedDescription = row.edited_proposed_description ?? row.proposed_description
  const effectivePrimaryImageUrl = row.edited_primary_image_url ?? row.primary_image_url

  const effectiveUnitCost = readOptionalNumber(raw.effectiveUnitCost)
  const currentGmPercent = computeGmPercent(effectiveUnitCost, currentPrice)
  const gmPercent = computeGmPercent(effectiveUnitCost, effectiveProposedPrice)

  const marketSource = readMarketSource(raw.marketSource)

  return {
    actionType: row.action_type,
    appliedAt: toIsoOrNull(row.applied_at),
    approvalStatus: row.approval_status,
    approvalUpdatedAt: toIsoOrNull(row.approval_updated_at),
    approvedByUser: row.approved_by_user_name,
    averageCompetitorPostTaxPrice: readOptionalNumber(raw.averageCompetitorPostTaxPrice),
    averageCompetitorPrice: readOptionalNumber(raw.averageCompetitorPrice),
    catalogAction: row.catalog_action,
    createdAt: toIso(row.created_at),
    currentDescription: row.current_description,
    currentGmPercent,
    currentPrice,
    currentPriceBasis: readOptionalString(raw.currentPriceBasis),
    distributorProductId: row.distributor_product_id,
    distributorProductName: row.distributor_product_name,
    editedPrimaryImageUrl: row.edited_primary_image_url,
    editedProposedDescription: row.edited_proposed_description,
    editedProposedPrice,
    effectivePrimaryImageUrl,
    effectiveProposedDescription,
    effectiveProposedPrice,
    effectiveUnitCost,
    effectiveUnitCostSource: readOptionalString(raw.effectiveUnitCostSource),
    expectedCategory: row.expected_category ?? readOptionalString(raw.expectedCategory),
    expectedSubcategory: row.expected_subcategory ?? readOptionalString(raw.expectedSubcategory),
    existingDistributorLinks: readOptionalString(raw.existingDistributorLinks),
    gmPercent,
    lastApplyError: row.last_apply_error,
    lastApplyRequestId: readOptionalIntFromString(row.last_apply_request_id),
    lastApplyStatus: row.last_apply_status,
    lastApplySummary: row.last_apply_summary_json ?? {},
    mappingStatus: row.mapping_status,
    marketAdviceConfidence: readOptionalString(raw.marketAdviceConfidence),
    marketAdvicePosture: readOptionalString(raw.marketAdvicePosture),
    marketAdviceSummary: row.market_advice_summary ?? readOptionalString(raw.marketAdviceSummary),
    marketDispensaryCount: readOptionalInt(raw.marketDispensaryCount),
    marketEligibleListingCount: readOptionalInt(raw.marketEligibleListingCount),
    marketListingCount: readOptionalInt(raw.marketListingCount),
    marketListings: readMarketListings(raw.marketListings),
    marketMedianPostTaxPrice: readOptionalFinite(raw.marketMedianPostTaxPrice),
    marketMedianPreTaxPrice: readOptionalFinite(raw.marketMedianPreTaxPrice),
    marketNote: readOptionalString(raw.marketNote),
    marketSearchTerm: readOptionalString(raw.marketSearchTerm),
    marketSource,
    notes: row.notes,
    orderIds: readNumberArray(row.order_ids_json),
    packetId: readIntFromString(row.packet_id),
    positionIds: readNumberArray(row.position_ids_json),
    pricingAction: readOptionalString(raw.pricingAction),
    pricingReason: row.pricing_reason ?? readOptionalString(raw.pricingReason),
    primaryImageNote: row.primary_image_note,
    primaryImageSource: row.primary_image_source,
    primaryImageUrl: row.primary_image_url,
    proposedDescription: row.proposed_description,
    proposedPrice,
    publicSources: readStringArray(raw.publicSources),
    reuseGroupId: readOptionalPositiveInt(raw.reuseGroupId),
    reuseProductId: readOptionalPositiveInt(raw.reuseProductId),
    reuseProductName: readOptionalString(raw.reuseProductName),
    reviewFlags: readStringArray(row.review_flags_json),
    reviewerNotes: readOptionalString(raw.reviewerNotes) ?? row.notes,
    rowId: readIntFromString(row.id),
    rowInputSignature: row.row_input_signature,
    sampleLike: typeof raw.sampleLike === 'boolean' ? raw.sampleLike : false,
    siteDealerId: readOptionalPositiveIntFromString(row.site_dealer_id),
    siteDealerName: row.site_dealer_name,
    siteKey: row.site_key,
    siteLabel: row.site_label,
    suggestionCandidates: readSuggestionCandidates(raw.suggestionCandidates),
    targetBrand: row.target_brand ?? readOptionalString(raw.targetBrand),
    targetGroupName: row.target_group_name ?? readOptionalString(raw.targetGroupName),
    targetPackCount: readOptionalPositiveInt(raw.targetPackCount),
    targetPrevalence: readOptionalString(raw.targetPrevalence),
    targetSize: readOptionalString(raw.targetSize),
    targetStrain: readOptionalString(raw.targetStrain),
    targetVariantName: row.target_variant_name ?? readOptionalString(raw.targetVariantName),
    targetVariantTab: readOptionalString(raw.targetVariantTab),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  }
}

function readRecord(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {}
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readOptionalFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readOptionalInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function readOptionalPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function readOptionalPositiveIntFromString(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function readOptionalIntFromString(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function readIntFromString(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected integer but got ${value}`)
  }
  return parsed
}

function readNumberFromString(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function readNumberArray(value: JsonValue): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const entry of value) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      out.push(entry)
    }
  }
  return out
}

function readStringArray(value: JsonValue): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) {
      out.push(entry)
    }
  }
  return out
}

function readMarketSource(value: unknown): 'nearby' | 'statewide' | 'mixed' | null {
  return value === 'nearby' || value === 'statewide' || value === 'mixed' ? value : null
}

function readMarketListings(value: unknown): PendingPurchaseMarketListing[] {
  if (!Array.isArray(value)) return []
  const out: PendingPurchaseMarketListing[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const distanceBand = record.distanceBand
    const matchTier = record.matchTier
    const source = record.source
    const dispensaryName = record.dispensaryName
    const listingName = record.listingName
    const preTaxPrice = record.preTaxPrice
    const postTaxPrice = record.postTaxPrice
    if (typeof dispensaryName !== 'string' || typeof listingName !== 'string') continue
    if (typeof preTaxPrice !== 'number' || !Number.isFinite(preTaxPrice)) continue
    if (typeof postTaxPrice !== 'number' || !Number.isFinite(postTaxPrice)) continue
    if (distanceBand !== 'near' && distanceBand !== 'mid' && distanceBand !== 'far' && distanceBand !== 'very_far' && distanceBand !== 'unknown') continue
    if (matchTier !== 'exact' && matchTier !== 'fallback' && matchTier !== 'weak') continue
    if (source !== 'nearby' && source !== 'statewide') continue
    out.push({
      category: typeof record.category === 'string' ? record.category : null,
      distanceBand,
      distanceMiles:
        typeof record.distanceMiles === 'number' && Number.isFinite(record.distanceMiles)
          ? record.distanceMiles
          : null,
      dispensaryName,
      eligibleForPricing: record.eligibleForPricing === true,
      exclusionReason: typeof record.exclusionReason === 'string' ? record.exclusionReason : null,
      listingName,
      matchTier,
      postTaxPrice,
      preTaxPrice,
      source,
      url: typeof record.url === 'string' ? record.url : null,
    })
  }
  return out
}

function readSuggestionCandidates(value: unknown): PendingPurchaseSuggestionCandidate[] {
  if (!Array.isArray(value)) return []
  const out: PendingPurchaseSuggestionCandidate[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const productId =
      typeof record.productId === 'number' && Number.isInteger(record.productId) && record.productId > 0
        ? record.productId
        : null
    const productName = typeof record.productName === 'string' ? record.productName : null
    const score =
      typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : null
    out.push({ productId, productName, score })
  }
  return out
}

function computeGmPercent(cost: number | null, price: number | null): number | null {
  if (cost === null || price === null || price <= 0) return null
  return (price - cost) / price
}

function toIso(value: Date): string {
  return value.toISOString()
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}
