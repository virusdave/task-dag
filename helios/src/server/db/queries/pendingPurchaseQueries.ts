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
  PendingPurchaseApplyRequestStatus,
  PendingPurchaseApplyRequestSummary,
  PendingPurchaseApprovalStatus,
  PendingPurchaseMappingStatus,
  PendingPurchaseMarketListing,
  PendingPurchasePacketSource,
  PendingPurchasePacketStatus,
  PendingPurchasePacketSummary,
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

interface SweedCatalogIndex {
  brandNames: Set<string>
  brandGroupPairs: Set<string>
}

async function loadSweedCatalogIndex(pool: Pool): Promise<SweedCatalogIndex> {
  // Snapshot of live Sweed brand/group names (case-insensitive). Used
  // by `mapPendingPurchaseRow` to decide whether a row's target_brand
  // / target_group_name would result in a NEW catalog entity getting
  // created on apply, so the UI can highlight it for the reviewer.
  const result = await pool.query<{ brand_name: string | null; group_name: string }>(
    `
      select lower(brand_name) as brand_name, lower(group_name) as group_name
      from catalog_groups
      where deleted_at is null
    `,
  )
  const brandNames = new Set<string>()
  const brandGroupPairs = new Set<string>()
  for (const row of result.rows) {
    const brand = row.brand_name?.trim() ?? ''
    if (brand.length > 0) {
      brandNames.add(brand)
    }
    const group = row.group_name.trim()
    if (brand.length > 0 && group.length > 0) {
      brandGroupPairs.add(`${brand}\u0001${group}`)
    }
  }
  return { brandNames, brandGroupPairs }
}

export async function listPendingPurchaseRows(
  pool: Pool,
  packetId: number,
): Promise<PendingPurchaseRow[]> {
  const [result, catalogIndex] = await Promise.all([
    pool.query<PendingPurchaseRowDbRow>(
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
    ),
    loadSweedCatalogIndex(pool),
  ])
  return result.rows.map((row) => mapPendingPurchaseRow(row, catalogIndex))
}

function mapPendingPurchaseRow(
  row: PendingPurchaseRowDbRow,
  catalogIndex: SweedCatalogIndex,
): PendingPurchaseRow {
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

  const targetBrand = row.target_brand ?? readOptionalString(raw.targetBrand)
  const targetGroupName = row.target_group_name ?? readOptionalString(raw.targetGroupName)
  const reuseGroupId = readOptionalPositiveInt(raw.reuseGroupId)
  const reuseProductId = readOptionalPositiveInt(raw.reuseProductId)
  const isCatalogCreate = row.mapping_status === 'needs_catalog_create'
  const normalizedBrand = targetBrand?.trim().toLowerCase() ?? ''
  const normalizedGroup = targetGroupName?.trim().toLowerCase() ?? ''
  const needsNewBrand =
    isCatalogCreate && normalizedBrand.length > 0 && !catalogIndex.brandNames.has(normalizedBrand)
  const brandGroupKey =
    normalizedBrand.length > 0 && normalizedGroup.length > 0
      ? `${normalizedBrand}\u0001${normalizedGroup}`
      : ''
  const needsNewGroup =
    isCatalogCreate &&
    reuseGroupId == null &&
    brandGroupKey.length > 0 &&
    !catalogIndex.brandGroupPairs.has(brandGroupKey)
  const needsNewVariant = isCatalogCreate && reuseProductId == null

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
    needsNewBrand,
    needsNewGroup,
    needsNewVariant,
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
    reuseGroupId,
    reuseProductId,
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
    targetBrand,
    targetGroupName,
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

interface PendingPurchasePacketDbRow extends QueryResultRow {
  created_at: Date
  generated_at: Date
  id: string
  import_file_name: string | null
  packet_title: string
  row_count: string
  site_keys_json: JsonValue
  site_labels_json: JsonValue
  source: string
  source_path: string | null
  state_context_json: JsonValue
  status: string
  summary_json: JsonValue
  updated_at: Date
}

export async function getPendingPurchasePacketSummary(
  pool: Pool,
  packetId: number,
): Promise<PendingPurchasePacketSummary | null> {
  const result = await pool.query<PendingPurchasePacketDbRow>(
    `
      select
        p.created_at,
        p.generated_at,
        p.id,
        p.import_file_name,
        p.packet_title,
        coalesce((select count(*) from pending_purchase_rows r where r.packet_id = p.id), 0) as row_count,
        p.site_keys_json,
        p.site_labels_json,
        p.source,
        p.source_path,
        p.state_context_json,
        p.status,
        p.summary_json,
        p.updated_at
      from pending_purchase_packets p
      where p.id = $1
    `,
    [packetId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    createdAt: toIso(row.created_at),
    generatedAt: toIso(row.generated_at),
    importFileName: row.import_file_name,
    packetId: readIntFromString(row.id),
    packetTitle: row.packet_title,
    rowCount: Number.parseInt(row.row_count, 10),
    siteKeys: readStringArray(row.site_keys_json),
    siteLabels: readStringArray(row.site_labels_json),
    source: row.source as PendingPurchasePacketSource,
    sourcePath: row.source_path,
    stateContext: row.state_context_json,
    status: row.status as PendingPurchasePacketStatus,
    summary: row.summary_json,
    updatedAt: toIso(row.updated_at),
  }
}

interface PendingPurchaseApplyRequestDbRow extends QueryResultRow {
  applied_row_count: number
  blocked_row_count: number
  created_at: Date
  failed_row_count: number
  finished_at: Date | null
  id: string
  job_id: string | null
  packet_id: string
  requested_by_user_name: string | null
  requested_reason: string | null
  selected_row_count: number
  started_at: Date | null
  status: string
  summary_json: JsonValue
  updated_at: Date
}

export async function getLatestPendingPurchaseApplyRequest(
  pool: Pool,
  packetId: number,
): Promise<PendingPurchaseApplyRequestSummary | null> {
  const result = await pool.query<PendingPurchaseApplyRequestDbRow>(
    `
      select
        a.applied_row_count,
        a.blocked_row_count,
        a.created_at,
        a.failed_row_count,
        a.finished_at,
        a.id,
        a.job_id,
        a.packet_id,
        u.name as requested_by_user_name,
        a.requested_reason,
        a.selected_row_count,
        a.started_at,
        a.status,
        a.summary_json,
        a.updated_at
      from pending_purchase_apply_requests a
      left join users u on u.id = a.requested_by_user_id
      where a.packet_id = $1
      order by a.created_at desc, a.id desc
      limit 1
    `,
    [packetId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    appliedRowCount: row.applied_row_count,
    blockedRowCount: row.blocked_row_count,
    failedRowCount: row.failed_row_count,
    finishedAt: toIsoOrNull(row.finished_at),
    jobId: readOptionalIntFromString(row.job_id),
    packetId: readIntFromString(row.packet_id),
    requestId: readIntFromString(row.id),
    requestedAt: toIso(row.created_at),
    requestedByUser: row.requested_by_user_name,
    selectedRowCount: row.selected_row_count,
    startedAt: toIsoOrNull(row.started_at),
    status: row.status as PendingPurchaseApplyRequestStatus,
    summary: row.summary_json,
    summaryText: typeof row.summary_json === 'object' && row.summary_json !== null && !Array.isArray(row.summary_json)
      ? (typeof (row.summary_json as Record<string, unknown>).summaryText === 'string'
          ? ((row.summary_json as Record<string, unknown>).summaryText as string)
          : null)
      : null,
    updatedAt: toIso(row.updated_at),
  }
}
