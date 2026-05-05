import type { QueryResultRow } from 'pg'

import type {
  JsonValue,
  PendingPurchaseApplyRequestSummary,
  PendingPurchaseListQuery,
  PendingPurchaseListResponse,
  PendingPurchasePacketSummary,
  PendingPurchaseRow,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'
import { toIsoString } from './helpers.js'

interface PendingPurchasePacketRow extends QueryResultRow {
  created_at: Date
  generated_at: Date
  id: number
  import_file_name: string | null
  row_count: number
  packet_title: string
  site_keys_json: string[]
  site_labels_json: string[]
  source_path: string | null
  source: PendingPurchasePacketSummary['source']
  state_context_json: JsonValue
  status: PendingPurchasePacketSummary['status']
  summary_json: JsonValue
  updated_at: Date
}

interface PendingPurchaseRowRecord extends QueryResultRow {
  action_type: string
  approval_status: PendingPurchaseRow['approvalStatus']
  approval_updated_at: Date | null
  applied_at: Date | null
  approved_by_user: string | null
  catalog_action: string
  created_at: Date
  current_description: string | null
  current_price: number | null
  distributor_product_id: string
  distributor_product_name: string
  edited_primary_image_url: string | null
  edited_proposed_description: string | null
  edited_proposed_price: number | null
  expected_category: string | null
  expected_subcategory: string | null
  id: number
  last_apply_error: string | null
  last_apply_request_id: number | null
  last_apply_status: PendingPurchaseRow['lastApplyStatus']
  last_apply_summary_json: JsonValue
  mapping_status: PendingPurchaseRow['mappingStatus']
  market_advice_summary: string | null
  notes: string | null
  order_ids_json: number[]
  packet_id: number
  position_ids_json: number[]
  pricing_reason: string | null
  primary_image_note: string | null
  primary_image_source: string | null
  primary_image_url: string | null
  proposed_description: string | null
  proposed_price: number | null
  raw_row_json: JsonValue
  review_flags_json: string[]
  row_input_signature: string | null
  site_dealer_id: number | null
  site_dealer_name: string | null
  site_key: string
  site_label: string
  target_brand: string | null
  target_group_name: string | null
  target_variant_name: string | null
  updated_at: Date
  version: number
}

interface PendingPurchaseApplyRequestRow extends QueryResultRow {
  applied_row_count: number
  blocked_row_count: number
  created_at: Date
  failed_row_count: number
  finished_at: Date | null
  id: number
  job_id: number | null
  packet_id: number
  requested_by_user: string | null
  selected_row_count: number
  started_at: Date | null
  status: PendingPurchaseApplyRequestSummary['status']
  summary_json: JsonValue
  updated_at: Date
}

export async function listPendingPurchaseRows(
  db: Queryable,
  filters: PendingPurchaseListQuery,
): Promise<PendingPurchaseListResponse> {
  const packets = await listPendingPurchasePackets(db)
  const activePacket = resolveActivePacket(packets, filters.packetId)
  if (!activePacket) {
    return {
      activePacket: null,
      activeGenerationJob: null,
      filters,
      items: [],
      latestApplyRequest: null,
      packets,
      totalCount: 0,
    }
  }

  const { values, whereSql } = buildPendingPurchaseWhere(activePacket.packetId, filters)
  const pageOffset = (filters.page - 1) * filters.pageSize

  const [itemsResult, countResult, latestApplyRequest] = await Promise.all([
    db.query<PendingPurchaseRowRecord>(
      `
        select
          ppr.id,
          ppr.packet_id,
          ppr.approval_status,
          ppr.approval_updated_at,
          approver.name as approved_by_user,
          ppr.applied_at,
          ppr.row_input_signature,
          ppr.site_key,
          ppr.site_label,
          ppr.site_dealer_id,
          ppr.site_dealer_name,
          ppr.distributor_product_id,
          ppr.distributor_product_name,
          ppr.action_type,
          ppr.mapping_status,
          ppr.target_brand,
          ppr.target_group_name,
          ppr.target_variant_name,
          ppr.expected_category,
          ppr.expected_subcategory,
          ppr.current_price::double precision as current_price,
          ppr.proposed_price::double precision as proposed_price,
          ppr.edited_proposed_price::double precision as edited_proposed_price,
          ppr.current_description,
          ppr.proposed_description,
          ppr.edited_proposed_description,
          ppr.primary_image_url,
          ppr.edited_primary_image_url,
          ppr.primary_image_source,
          ppr.primary_image_note,
          ppr.catalog_action,
          ppr.pricing_reason,
          ppr.market_advice_summary,
          ppr.notes,
          ppr.last_apply_request_id,
          ppr.last_apply_status,
          ppr.last_apply_error,
          ppr.last_apply_summary_json,
          ppr.review_flags_json,
          ppr.order_ids_json,
          ppr.position_ids_json,
          ppr.raw_row_json,
          ppr.version,
          ppr.created_at,
          ppr.updated_at
        from pending_purchase_rows ppr
        left join users approver on approver.id = ppr.approved_by_user_id
        ${whereSql}
        order by
          case ppr.action_type when 'catalog-create' then 0 when 'mapping-only' then 1 else 2 end,
          ppr.distributor_product_name asc,
          ppr.id asc
        limit $${values.length + 1}
        offset $${values.length + 2}
      `,
      [...values, filters.pageSize, pageOffset],
    ),
    db.query<{ total_count: number }>(
      `
        select count(*)::int as total_count
        from pending_purchase_rows ppr
        ${whereSql}
      `,
      values,
    ),
    getLatestPendingPurchaseApplyRequest(db, activePacket.packetId),
  ])

  return {
    activePacket,
    activeGenerationJob: null,
    filters: {
      ...filters,
      packetId: activePacket.packetId,
    },
    items: itemsResult.rows.map((row) => mapPendingPurchaseRow(row)),
    latestApplyRequest,
    packets,
    totalCount: countResult.rows[0]?.total_count ?? 0,
  }
}

async function getLatestPendingPurchaseApplyRequest(
  db: Queryable,
  packetId: number,
): Promise<PendingPurchaseApplyRequestSummary | null> {
  const result = await db.query<PendingPurchaseApplyRequestRow>(
    `
      select
        ppar.id,
        ppar.packet_id,
        ppar.job_id,
        ppar.status,
        ppar.selected_row_count,
        ppar.applied_row_count,
        ppar.blocked_row_count,
        ppar.failed_row_count,
        ppar.summary_json,
        ppar.started_at,
        ppar.finished_at,
        ppar.created_at,
        ppar.updated_at,
        requester.name as requested_by_user
      from pending_purchase_apply_requests ppar
      left join users requester on requester.id = ppar.requested_by_user_id
      where ppar.packet_id = $1
      order by ppar.created_at desc, ppar.id desc
      limit 1
    `,
    [packetId],
  )

  const row = result.rows[0]
  if (!row) {
    return null
  }

  return {
    appliedRowCount: row.applied_row_count,
    blockedRowCount: row.blocked_row_count,
    failedRowCount: row.failed_row_count,
    finishedAt: toIsoString(row.finished_at),
    jobId: row.job_id,
    packetId: row.packet_id,
    requestId: row.id,
    requestedAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    requestedByUser: row.requested_by_user,
    selectedRowCount: row.selected_row_count,
    startedAt: toIsoString(row.started_at),
    status: row.status,
    summary: row.summary_json,
    summaryText: readSummaryText(row.summary_json),
    updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString(),
  }
}

async function listPendingPurchasePackets(db: Queryable): Promise<PendingPurchasePacketSummary[]> {
  const result = await db.query<PendingPurchasePacketRow>(
    `
      select
        ppp.id,
        ppp.source,
        ppp.packet_title,
        ppp.status,
        ppp.import_file_name,
        ppp.source_path,
        ppp.generated_at,
        ppp.site_keys_json,
        ppp.site_labels_json,
        ppp.summary_json,
        ppp.state_context_json,
        ppp.created_at,
        ppp.updated_at,
        count(ppr.id)::int as row_count
      from pending_purchase_packets ppp
      left join pending_purchase_rows ppr on ppr.packet_id = ppp.id
      group by ppp.id
      order by ppp.generated_at desc, ppp.created_at desc
      limit 20
    `,
  )

  return result.rows.map((row) => ({
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    generatedAt: toIsoString(row.generated_at) ?? new Date(0).toISOString(),
    importFileName: row.import_file_name,
    packetId: row.id,
    packetTitle: row.packet_title,
    rowCount: row.row_count,
    siteKeys: row.site_keys_json,
    siteLabels: row.site_labels_json,
    sourcePath: row.source_path,
    source: row.source,
    stateContext: row.state_context_json,
    status: row.status,
    summary: row.summary_json,
    updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString(),
  }))
}

function resolveActivePacket(
  packets: PendingPurchasePacketSummary[],
  packetId: number | undefined,
): PendingPurchasePacketSummary | null {
  if (packetId) {
    return packets.find((packet) => packet.packetId === packetId) ?? null
  }

  return packets.find((packet) => packet.status === 'ready') ?? packets[0] ?? null
}

function buildPendingPurchaseWhere(
  packetId: number,
  filters: PendingPurchaseListQuery,
): { values: unknown[]; whereSql: string } {
  const clauses = ['ppr.packet_id = $1']
  const values: unknown[] = [packetId]

  if (filters.siteKey) {
    values.push(filters.siteKey)
    clauses.push(`ppr.site_key = $${values.length}`)
  }
  if (filters.actionType) {
    values.push(filters.actionType)
    clauses.push(`ppr.action_type = $${values.length}`)
  }
  if (filters.search) {
    values.push(`%${filters.search}%`)
    clauses.push(`(
      ppr.distributor_product_name ilike $${values.length}
      or coalesce(ppr.target_brand, '') ilike $${values.length}
      or coalesce(ppr.target_variant_name, '') ilike $${values.length}
      or coalesce(ppr.target_group_name, '') ilike $${values.length}
    )`)
  }

  return {
    values,
    whereSql: `where ${clauses.join(' and ')}`,
  }
}

function mapPendingPurchaseRow(row: PendingPurchaseRowRecord): PendingPurchaseRow {
  const rawRow = readRecord(row.raw_row_json)
  const marketListings = readPendingPurchaseMarketListings(rawRow)
  const marketDispensaryCount = readNonNegativeInt(rawRow.marketDispensaryCount)
    ?? readNonNegativeInt(readRecord(rawRow.pricingMarketEvidence).dispensaryCount)
    ?? readNonNegativeInt(rawRow.pricingEvidenceRetailerMatchCount)
    ?? readNonNegativeInt(rawRow.pricingFamilyEvidenceRetailerMatchCount)
    ?? (marketListings.length > 0 ? new Set(marketListings.map((listing) => listing.dispensaryName.toLowerCase())).size : null)
  const marketEligibleListingCount = readNonNegativeInt(rawRow.marketEligibleListingCount)
    ?? readNonNegativeInt(readRecord(rawRow.pricingMarketEvidence).pricingEligibleListingCount)
    ?? (marketListings.length > 0 ? marketListings.filter((listing) => listing.eligibleForPricing).length : null)
  const marketListingCount = readNonNegativeInt(rawRow.marketListingCount)
    ?? readNonNegativeInt(readRecord(rawRow.pricingMarketEvidence).listingCount)
    ?? (marketListings.length > 0 ? marketListings.length : null)

  return {
    actionType: row.action_type,
    approvalStatus: row.approval_status,
    approvalUpdatedAt: toIsoString(row.approval_updated_at),
    averageCompetitorPostTaxPrice: readOptionalNumber(rawRow.averageCompetitorPostTaxPrice),
    averageCompetitorPrice: readOptionalNumber(rawRow.averageCompetitorPrice),
    appliedAt: toIsoString(row.applied_at),
    approvedByUser: row.approved_by_user,
    catalogAction: row.catalog_action,
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    currentDescription: row.current_description,
    currentGmPercent: readOptionalNumber(rawRow.currentGmPercent),
    currentPrice: row.current_price,
    currentPriceBasis: readOptionalString(rawRow.currentPriceBasis),
    distributorProductId: row.distributor_product_id,
    distributorProductName: row.distributor_product_name,
    editedPrimaryImageUrl: row.edited_primary_image_url,
    editedProposedDescription: row.edited_proposed_description,
    editedProposedPrice: row.edited_proposed_price,
    effectivePrimaryImageUrl: row.edited_primary_image_url ?? row.primary_image_url,
    effectiveProposedDescription: row.edited_proposed_description ?? row.proposed_description,
    effectiveProposedPrice: row.edited_proposed_price ?? row.proposed_price,
    effectiveUnitCost: readOptionalNumber(rawRow.effectiveUnitCost),
    effectiveUnitCostSource: readOptionalString(rawRow.effectiveUnitCostSource),
    expectedCategory: row.expected_category,
    expectedSubcategory: row.expected_subcategory,
    existingDistributorLinks: readOptionalString(rawRow.existingDistributorLinks),
    gmPercent: readOptionalNumber(rawRow.gmPercent),
    lastApplyError: row.last_apply_error,
    lastApplyRequestId: row.last_apply_request_id,
    lastApplyStatus: row.last_apply_status,
    lastApplySummary: row.last_apply_summary_json,
    marketDispensaryCount,
    marketEligibleListingCount,
    marketListingCount,
    marketListings,
    marketMedianPostTaxPrice: readOptionalNumber(rawRow.marketMedianPostTaxPrice)
      ?? readOptionalNumber(rawRow.competitorMedianPostTaxPrice)
      ?? readOptionalNumber(readRecord(rawRow.pricingMarketEvidence).medianPostTaxPrice),
    marketMedianPreTaxPrice: readOptionalNumber(rawRow.marketMedianPreTaxPrice)
      ?? readOptionalNumber(readRecord(rawRow.pricingMarketEvidence).medianPreTaxPrice),
    marketNote: readOptionalString(rawRow.marketNote)
      ?? readOptionalString(rawRow.pricingEvidenceNote)
      ?? readOptionalString(rawRow.marketAdviceSummary),
    marketSearchTerm: readOptionalString(rawRow.marketSearchTerm)
      ?? readOptionalString(readRecord(rawRow.pricingMarketEvidence).searchTerm),
    marketSource: readPendingPurchaseMarketSource(rawRow, marketListings),
    mappingStatus: row.mapping_status,
    marketAdviceConfidence: readOptionalString(rawRow.marketAdviceConfidence),
    marketAdvicePosture: readOptionalString(rawRow.marketAdvicePosture),
    marketAdviceSummary: row.market_advice_summary,
    notes: row.notes,
    orderIds: row.order_ids_json,
    packetId: row.packet_id,
    positionIds: row.position_ids_json,
    pricingAction: readOptionalString(rawRow.pricingAction),
    pricingReason: row.pricing_reason,
    primaryImageNote: row.primary_image_note,
    primaryImageSource: row.primary_image_source,
    primaryImageUrl: row.primary_image_url,
    publicSources: readPendingPurchasePublicSources(rawRow, marketListings),
    proposedDescription: row.proposed_description,
    proposedPrice: row.proposed_price,
    reuseGroupId: readOptionalInt(rawRow.reuseGroupId),
    reuseProductId: readOptionalInt(rawRow.reuseProductId),
    reuseProductName: readOptionalString(rawRow.reuseProductName),
    reviewFlags: row.review_flags_json,
    reviewerNotes: readOptionalString(rawRow.reviewerNotes) ?? readOptionalString(rawRow.notes),
    rowId: row.id,
    rowInputSignature: row.row_input_signature,
    sampleLike: readOptionalBoolean(rawRow.sampleLike) ?? false,
    siteDealerId: row.site_dealer_id,
    siteDealerName: row.site_dealer_name,
    siteKey: row.site_key,
    siteLabel: row.site_label,
    suggestionCandidates: readSuggestionCandidates(rawRow.suggestionCandidates),
    targetBrand: row.target_brand,
    targetGroupName: row.target_group_name,
    targetPackCount: readOptionalInt(rawRow.targetPackCount),
    targetPrevalence: readOptionalString(rawRow.targetPrevalence),
    targetSize: readOptionalString(rawRow.targetSize),
    targetStrain: readOptionalString(rawRow.targetStrain),
    targetVariantName: row.target_variant_name,
    targetVariantTab: readOptionalString(rawRow.targetVariantTab),
    updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString(),
    version: row.version,
  }
}

function readRecord(value: JsonValue): Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function readSummaryText(value: JsonValue): string | null {
  return readOptionalString(readRecord(value).summaryText)
}

function readOptionalBoolean(value: JsonValue | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readOptionalInt(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function readNonNegativeInt(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function readOptionalNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readOptionalString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function readStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function readPendingPurchasePublicSources(
  rawRow: Record<string, JsonValue>,
  marketListings: PendingPurchaseRow['marketListings'],
): string[] {
  const explicitSources = readStringArray(rawRow.publicSources)
  if (explicitSources.length > 0) {
    return explicitSources
  }

  const pricingEvidenceUrls = readStringArray(rawRow.pricingEvidenceUrls)
  const pricingFamilyEvidenceUrls = readStringArray(rawRow.pricingFamilyEvidenceUrls)
  if (pricingEvidenceUrls.length > 0 || pricingFamilyEvidenceUrls.length > 0) {
    return [...new Set([...pricingEvidenceUrls, ...pricingFamilyEvidenceUrls])]
  }

  return [...new Set(marketListings.map((listing) => listing.url).filter((url): url is string => typeof url === 'string' && url.trim().length > 0))]
}

function readPendingPurchaseMarketSource(
  rawRow: Record<string, JsonValue>,
  marketListings: PendingPurchaseRow['marketListings'],
): PendingPurchaseRow['marketSource'] {
  const explicitSource = rawRow.marketSource
  if (explicitSource === 'nearby' || explicitSource === 'statewide' || explicitSource === 'mixed') {
    return explicitSource
  }

  const evidenceSource = readRecord(rawRow.pricingMarketEvidence).source
  if (evidenceSource === 'nearby' || evidenceSource === 'statewide' || evidenceSource === 'mixed') {
    return evidenceSource
  }

  const sources = new Set(marketListings.map((listing) => listing.source))
  if (sources.size === 0) {
    return null
  }
  if (sources.size === 1) {
    return [...sources][0] ?? null
  }
  return 'mixed'
}

function readPendingPurchaseMarketListings(rawRow: Record<string, JsonValue>): PendingPurchaseRow['marketListings'] {
  const pricingMarketEvidence = readRecord(rawRow.pricingMarketEvidence)
  const explicitListings = readPendingPurchaseNormalizedMarketListings(pricingMarketEvidence.matchedListings)
  if (explicitListings.length > 0) {
    return explicitListings
  }

  const preferredLegacyDetails = readLegacyPendingPurchaseMarketDetails(
    rawRow.pricingEvidenceSourceDetails,
    rawRow.pricingFamilyEvidenceSourceDetails,
  )
  if (preferredLegacyDetails.length > 0) {
    return preferredLegacyDetails
  }

  return []
}

function readPendingPurchaseNormalizedMarketListings(value: JsonValue | undefined): PendingPurchaseRow['marketListings'] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      return []
    }

    const distanceBand = readPendingPurchaseDistanceBand(candidate.distanceBand)
    const dispensaryName = readOptionalString(candidate.dispensaryName)
    const listingName = readOptionalString(candidate.listingName)
    const postTaxPrice = readOptionalNumber(candidate.postTaxPrice)
    const preTaxPrice = readOptionalNumber(candidate.preTaxPrice)
    const source = candidate.source === 'nearby' || candidate.source === 'statewide' ? candidate.source : null
    if (distanceBand === null || dispensaryName === null || listingName === null || postTaxPrice === null || preTaxPrice === null || source === null) {
      return []
    }

    return [{
      category: readOptionalString(candidate.category),
      distanceBand,
      distanceMiles: readOptionalNumber(candidate.distanceMiles),
      dispensaryName,
      eligibleForPricing: readOptionalBoolean(candidate.eligibleForPricing) ?? false,
      exclusionReason: readOptionalString(candidate.exclusionReason),
      listingName,
      matchTier: candidate.matchTier === 'exact' || candidate.matchTier === 'weak' ? candidate.matchTier : 'fallback',
      postTaxPrice,
      preTaxPrice,
      source,
      url: readOptionalString(candidate.url),
    }]
  })
}

function readLegacyPendingPurchaseMarketDetails(
  pricingEvidenceSourceDetails: JsonValue | undefined,
  pricingFamilyEvidenceSourceDetails: JsonValue | undefined,
): PendingPurchaseRow['marketListings'] {
  const primaryListings = readLegacyPendingPurchaseMarketListingArray(pricingEvidenceSourceDetails)
  if (primaryListings.length > 0) {
    return primaryListings
  }

  return readLegacyPendingPurchaseMarketListingArray(pricingFamilyEvidenceSourceDetails)
}

function readLegacyPendingPurchaseMarketListingArray(value: JsonValue | undefined): PendingPurchaseRow['marketListings'] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      return []
    }

    const dispensaryName = readOptionalString(candidate.dispensaryName)
    const listingName = readOptionalString(candidate.listingName) ?? readOptionalString(candidate.label)
    const postTaxPrice = readOptionalNumber(candidate.postTaxPrice)
    const preTaxPrice = readOptionalNumber(candidate.price)
    if (dispensaryName === null || listingName === null || postTaxPrice === null || preTaxPrice === null) {
      return []
    }

    return [{
      category: readOptionalString(candidate.category),
      distanceBand: deriveLegacyPendingPurchaseDistanceBand(candidate.distanceBucket, candidate.retailerDistanceMiles),
      distanceMiles: readOptionalNumber(candidate.retailerDistanceMiles),
      dispensaryName,
      eligibleForPricing: readOptionalBoolean(candidate.pricingEligible) ?? true,
      exclusionReason: readOptionalBoolean(candidate.pricingEligible) === false ? 'Legacy packet kept this listing for display only.' : null,
      listingName,
      matchTier: 'fallback',
      postTaxPrice,
      preTaxPrice,
      source: candidate.distanceBucket === 'statewide' ? 'statewide' : 'nearby',
      url: readOptionalString(candidate.url),
    }]
  })
}

function deriveLegacyPendingPurchaseDistanceBand(
  distanceBucket: JsonValue | undefined,
  retailerDistanceMiles: JsonValue | undefined,
): PendingPurchaseRow['marketListings'][number]['distanceBand'] {
  const numericDistance = readOptionalNumber(retailerDistanceMiles)
  if (numericDistance !== null) {
    if (numericDistance <= 1) {
      return 'near'
    }
    if (numericDistance <= 3) {
      return 'mid'
    }
    if (numericDistance < 10) {
      return 'far'
    }
    return 'very_far'
  }

  const normalizedBucket = readOptionalString(distanceBucket)?.toLowerCase() ?? ''
  if (normalizedBucket.includes('near') || normalizedBucket.includes('1')) {
    return 'near'
  }
  if (normalizedBucket.includes('mid') || normalizedBucket.includes('3')) {
    return 'mid'
  }
  if (normalizedBucket.includes('far') || normalizedBucket.includes('10')) {
    return 'far'
  }
  if (normalizedBucket.includes('statewide')) {
    return 'unknown'
  }
  return 'unknown'
}

function readPendingPurchaseDistanceBand(value: JsonValue | undefined): PendingPurchaseRow['marketListings'][number]['distanceBand'] | null {
  return value === 'near' || value === 'mid' || value === 'far' || value === 'very_far' || value === 'unknown'
    ? value
    : null
}

function readSuggestionCandidates(value: JsonValue | undefined): PendingPurchaseRow['suggestionCandidates'] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return []
    }

    const productName = readOptionalString(item.productName)
    const score = readOptionalNumber(item.score)
    const rawProductId = item.productId
    const productId = typeof rawProductId === 'number' && Number.isInteger(rawProductId) && rawProductId > 0
      ? rawProductId
      : null

    if (productName === null && score === null && productId === null) {
      return []
    }

    return [{ productId, productName, score }]
  })
}

export const __test__ = {
  mapPendingPurchaseRow,
}
