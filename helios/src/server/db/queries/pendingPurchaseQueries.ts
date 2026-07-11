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

import {
  PendingPurchaseOperatorNoteDocumentSchema,
  PendingPurchaseThreeWayComparisonSchema,
} from '../../../shared/contracts/index.js'
import type {
  JsonValue,
  PendingPurchaseApplyRequestStatus,
  PendingPurchaseApplyRequestSummary,
  PendingPurchaseApprovalStatus,
  PendingPurchaseEtlDetailRow,
  PendingPurchaseLlmClassification,
  PendingPurchaseMappingStatus,
  PendingPurchaseMarketListing,
  PendingPurchasePacketSource,
  PendingPurchasePacketStatus,
  PendingPurchasePacketSummary,
  PendingPurchaseOperatorNoteDocument,
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
  // Sparse reviewer-authored structured-taxonomy overrides (issue
  // #35). See `EditedStructuredFieldsSchema` in
  // `shared/contracts/api/pendingPurchases.ts`. NULL = no overrides.
  edited_structured_fields: JsonValue
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
  row_lineage_id: string | null
  lineage_revision_number: number | null
  row_snapshot_sha256: string | null
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
  const [hasLineageColumns, catalogIndex] = await Promise.all([
    hasPendingPurchaseRowLineageColumns(pool),
    loadSweedCatalogIndex(pool),
  ])
  const lineageSelectSql = hasLineageColumns
    ? `
        r.row_lineage_id,
        r.lineage_revision_number,
        r.row_snapshot_sha256,
      `
    : `
        null::text as row_lineage_id,
        null::integer as lineage_revision_number,
        null::text as row_snapshot_sha256,
      `
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
        r.edited_structured_fields,
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
        ${lineageSelectSql}
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
  return result.rows.map((row) => mapPendingPurchaseRow(row, catalogIndex))
}

async function hasPendingPurchaseRowLineageColumns(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ column_count: string }>(
    `
      select count(*)::text as column_count
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'pending_purchase_rows'
        and column_name in ('row_lineage_id', 'lineage_revision_number', 'row_snapshot_sha256')
    `,
  )
  return result.rows[0]?.column_count === '3'
}

interface PendingPurchaseEtlComparisonDbRow extends QueryResultRow {
  action_type: string
  approval_status: PendingPurchaseApprovalStatus
  distributor_product_name: string
  id: string
  site_label: string
  three_way_comparison: JsonValue
}

/**
 * Load the per-row 3-way (LLM vs parsekit vs legacy) comparison records for one
 * packet, powering the "Purchase ETL Details" page (C8b, child epic
 * FreshlyBakedNYC/automation#54). Only rows that actually carry a
 * `threeWayComparison` blob are returned (absent on legacy / imported rows,
 * which are legitimately excluded here rather than fabricated). The blob is
 * extracted SQL-side so the whole `raw_row_json` payload never crosses the
 * wire; each present blob is validated by `parseThreeWayComparison`, which
 * surfaces a malformed record as an explicit `invalid` marker instead of
 * throwing (a corrupt record must not brick the audit page).
 */
export async function listPendingPurchaseEtlComparisonRows(
  pool: Pool,
  packetId: number,
): Promise<PendingPurchaseEtlDetailRow[]> {
  const result = await pool.query<PendingPurchaseEtlComparisonDbRow>(
    `
      select
        r.id,
        r.action_type,
        r.approval_status,
        r.distributor_product_name,
        r.site_label,
        r.raw_row_json -> 'threeWayComparison' as three_way_comparison
      from pending_purchase_rows r
      where r.packet_id = $1
        and r.raw_row_json ? 'threeWayComparison'
      order by r.id asc
    `,
    [packetId],
  )
  return result.rows.map((row) => ({
    rowId: readIntFromString(row.id),
    distributorProductName: row.distributor_product_name,
    siteLabel: row.site_label,
    approvalStatus: row.approval_status,
    actionType: row.action_type,
    comparison: parseThreeWayComparison(row.three_way_comparison, readIntFromString(row.id)),
  }))
}

/**
 * Validate a present `threeWayComparison` blob. On success returns the typed
 * comparison; on failure returns an explicit `invalid` marker AND logs a
 * warning (fail-loud in two places) so a C8a writer bug is discoverable from
 * both the page and the server logs, without a single bad record 500-ing the
 * whole packet. Never called for an absent blob — those rows are filtered out
 * by the query above. Exported for unit testing the coercion (no DB needed).
 */
export function parseThreeWayComparison(
  value: JsonValue,
  rowId: number,
): PendingPurchaseEtlDetailRow['comparison'] {
  const parsed = PendingPurchaseThreeWayComparisonSchema.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }
  const schemaVersion =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      && typeof (value as Record<string, unknown>).schemaVersion === 'number'
      ? ((value as Record<string, unknown>).schemaVersion as number)
      : null
  const error = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
  console.warn(
    `pending_purchase_rows.raw_row_json.threeWayComparison malformed for row ${rowId} (schemaVersion=${schemaVersion ?? 'null'}): ${error}`,
  )
  return { status: 'invalid', schemaVersion, error }
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
  // Effective reuse product id (key-presence semantics — see
  // EditedStructuredFieldsSchema.targetReuseProductId in
  // shared/contracts/api/pendingPurchases.ts):
  //   - reviewer override key present + positive int → that id wins
  //   - reviewer override key present + null         → reuse cleared
  //   - reviewer override key absent                 → parser fallback
  // The list/listing UI surfaces this single resolved value so the
  // "linked variant", "needs new variant", and the pricing pending-
  // scope SQL below all agree with what apply will actually do.
  const structuredOverrides = readEditedStructuredFieldsForRow(row.edited_structured_fields)
  const reuseOverridePresent =
    structuredOverrides !== null &&
    Object.prototype.hasOwnProperty.call(structuredOverrides, 'targetReuseProductId')
  const reuseOverrideValue = reuseOverridePresent
    ? readOptionalPositiveInt(structuredOverrides?.targetReuseProductId ?? null)
    : null
  const reuseProductId = reuseOverridePresent
    ? reuseOverrideValue
    : readOptionalPositiveInt(raw.reuseProductId)
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
    editedStructuredFields: structuredOverrides,
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
    llmClassification: readLlmClassification(raw.llmClassification),
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
    rowLineageId: row.row_lineage_id,
    lineageRevisionNumber: row.lineage_revision_number,
    rowSnapshotSha256: row.row_snapshot_sha256,
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

// Pass-through for the `edited_structured_fields` JSONB column on
// pending_purchase_rows. The api-side `EditedStructuredFieldsSchema`
// already gated whatever the reviewer PATCHed, and the row contract
// has its own permissive schema (`RowEditedStructuredFieldsSchema`)
// that re-validates on parse — we just need to convert
// `{ }` / non-object / null into `null` so the optional contract
// field doesn't flicker between "no overrides at all" (null) and
// "empty override map" ({}).
function readEditedStructuredFieldsForRow(
  value: JsonValue,
): PendingPurchaseRow['editedStructuredFields'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  if (Object.keys(value).length === 0) {
    return null
  }
  return value as PendingPurchaseRow['editedStructuredFields']
}

function readRecord(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {}
}

// A packet has ETL Details (C8b) iff it came from the prospective LLM
// classifier pipeline (C8a). C8a stamps `summary_json.classifier` provenance
// on exactly the packets whose every row also got a `threeWayComparison`
// (both were introduced together), so this cheap object-key check on the
// already-selected `summary_json` is an accurate proxy — no per-row
// `raw_row_json` detoast scan required. Legacy / imported packets never carry
// `classifier`, so the ETL details link stays hidden where there is no data.
function summaryJsonHasClassifier(value: JsonValue): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const classifier = (value as Record<string, JsonValue>).classifier
  return classifier !== undefined && classifier !== null
}

export function readPendingPurchaseHintBundleId(value: JsonValue): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const classifier = (value as Record<string, JsonValue>).classifier
  if (classifier === null || typeof classifier !== 'object' || Array.isArray(classifier)) return null
  return readOptionalString((classifier as Record<string, JsonValue>).hintBundleId)
}

export function readPendingPurchaseOperatorNoteDocuments(
  value: JsonValue,
): PendingPurchaseOperatorNoteDocument[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const classifier = (value as Record<string, JsonValue>).classifier
  if (classifier === null || typeof classifier !== 'object' || Array.isArray(classifier)) return null
  const documents = (classifier as Record<string, JsonValue>).operatorNoteDocuments
  if (documents === undefined) return null
  const parsed = PendingPurchaseOperatorNoteDocumentSchema.array().safeParse(documents)
  if (!parsed.success) {
    throw new Error('Pending-purchase packet has malformed operator-note provenance.')
  }
  return parsed.data
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
      imageUrl: typeof record.imageUrl === 'string' && record.imageUrl ? record.imageUrl : null,
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

// Read the prospective-classifier provenance block the generate job (C8) stores
// under `raw_row_json.llmClassification`. Tolerant by design: the field is
// absent on every legacy / imported row, so anything that isn't a well-formed
// object returns null (the UI then simply omits the model panel). These values
// are audit/review context only — never trusted for safety — so we coerce
// defensively rather than throwing on a malformed blob.
// Exported for unit testing the defensive coercion (no DB needed); the row
// mapper above is the only production caller.
export function readLlmClassification(value: unknown): PendingPurchaseLlmClassification | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  // Confidence is a required part of the C4/C5 contract. A block missing a
  // finite confidence is malformed, not a real classification — treat it as
  // absent rather than fabricating a misleading "model 0%" pill in the UI.
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) return null
  return {
    // Clamp to the contract's nonnegative-integer range so a malformed value
    // (e.g. -1) can't slip past the API schema and turn into a route failure.
    schemaVersion:
      typeof record.schemaVersion === 'number' &&
      Number.isInteger(record.schemaVersion) &&
      record.schemaVersion >= 0
        ? record.schemaVersion
        : 0,
    model: typeof record.model === 'string' ? record.model : '',
    promptVersion: typeof record.promptVersion === 'string' ? record.promptVersion : '',
    reconcilerVersion:
      typeof record.reconcilerVersion === 'string' ? record.reconcilerVersion : '',
    confidence: Math.min(1, Math.max(0, record.confidence)),
    rationale: typeof record.rationale === 'string' ? record.rationale : '',
    citedHintIds: readStringArray(record.citedHintIds as JsonValue),
    warningFlags: readStringArray(record.warningFlags as JsonValue),
  }
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
    hasEtlDetails: summaryJsonHasClassifier(row.summary_json),
    hintBundleId: readPendingPurchaseHintBundleId(row.summary_json),
    importFileName: row.import_file_name,
    operatorNoteDocuments: readPendingPurchaseOperatorNoteDocuments(row.summary_json),
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

// ──────────────────────────────────────────────────────────────────────────────
// Packet list (cross-packet) — powers the reviewer-first archive view at the
// top of /catalog/pending-purchases. Returns a paginated slice of every
// produced packet (generated or imported), each enriched with the row-level
// approval / apply counts that drive the status chips on each packet card.
// ──────────────────────────────────────────────────────────────────────────────

export interface PendingPurchasePacketListFilters {
  after: string | null
  before: string | null
  search: string | null
  siteKey: string | null
  source: PendingPurchasePacketSource | null
  status: PendingPurchasePacketStatus | null
}

export interface PendingPurchasePacketListItemRow {
  applyCounts: {
    applied: number
    blocked: number
    failed: number
    notRequested: number
    queued: number
    running: number
  }
  approvalCounts: {
    approved: number
    pending: number
    rejected: number
  }
  createdAt: string
  generatedAt: string
  hasEtlDetails: boolean
  hintBundleId: string | null
  importFileName: string | null
  latestApplyRequest: PendingPurchaseApplyRequestSummary | null
  operatorNoteDocuments: PendingPurchaseOperatorNoteDocument[] | null
  packetId: number
  packetTitle: string
  rowCount: number
  siteKeys: string[]
  siteLabels: string[]
  source: PendingPurchasePacketSource
  sourcePath: string | null
  stateContext: JsonValue
  status: PendingPurchasePacketStatus
  summary: JsonValue
  updatedAt: string
}

export interface PendingPurchasePacketListPage {
  items: PendingPurchasePacketListItemRow[]
  totalCount: number
}

interface PendingPurchasePacketListDbRow extends QueryResultRow {
  apply_applied: string
  apply_blocked: string
  apply_failed: string
  apply_not_requested: string
  apply_queued: string
  apply_running: string
  approval_approved: string
  approval_pending: string
  approval_rejected: string
  created_at: Date
  generated_at: Date
  id: string
  import_file_name: string | null
  latest_apply_applied: number | null
  latest_apply_blocked: number | null
  latest_apply_failed: number | null
  latest_apply_finished_at: Date | null
  latest_apply_id: string | null
  latest_apply_job_id: string | null
  latest_apply_request_created_at: Date | null
  latest_apply_request_updated_at: Date | null
  latest_apply_requested_by_user_name: string | null
  latest_apply_selected: number | null
  latest_apply_started_at: Date | null
  latest_apply_status: string | null
  latest_apply_summary_json: JsonValue
  packet_title: string
  row_count: string
  site_keys_json: JsonValue
  site_labels_json: JsonValue
  source: string
  source_path: string | null
  state_context_json: JsonValue
  status: string
  summary_json: JsonValue
  total_count: string
  updated_at: Date
}

export async function listPendingPurchasePacketListPage(
  pool: Pool,
  options: {
    filters: PendingPurchasePacketListFilters
    limit: number
    offset: number
  },
): Promise<PendingPurchasePacketListPage> {
  const { filters, limit, offset } = options
  const siteKeyJson = filters.siteKey ? JSON.stringify([filters.siteKey]) : null
  const searchPattern = filters.search ? `%${filters.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null

  const result = await pool.query<PendingPurchasePacketListDbRow>(
    `
      with filtered as (
        select p.*
        from pending_purchase_packets p
        where ($1::text is null or p.status = $1::text)
          and ($2::text is null or p.source = $2::text)
          and ($3::text is null or p.site_keys_json @> $3::jsonb)
          and ($4::text is null or p.packet_title ilike $4::text)
          and ($5::text is null or p.generated_at >= $5::date)
          and ($6::text is null or p.generated_at < ($6::date + interval '1 day'))
      ),
      counted as (
        select f.*,
               (select count(*) from filtered) as total_count
        from filtered f
        order by f.generated_at desc, f.id desc
        limit $7
        offset $8
      )
      select
        c.id,
        c.packet_title,
        c.source,
        c.source_path,
        c.import_file_name,
        c.status,
        c.state_context_json,
        c.summary_json,
        c.site_keys_json,
        c.site_labels_json,
        c.generated_at,
        c.created_at,
        c.updated_at,
        c.total_count,
        coalesce(rc.row_count, 0)::text as row_count,
        coalesce(rc.approval_approved, 0)::text as approval_approved,
        coalesce(rc.approval_pending, 0)::text as approval_pending,
        coalesce(rc.approval_rejected, 0)::text as approval_rejected,
        coalesce(rc.apply_applied, 0)::text as apply_applied,
        coalesce(rc.apply_blocked, 0)::text as apply_blocked,
        coalesce(rc.apply_failed, 0)::text as apply_failed,
        coalesce(rc.apply_not_requested, 0)::text as apply_not_requested,
        coalesce(rc.apply_queued, 0)::text as apply_queued,
        coalesce(rc.apply_running, 0)::text as apply_running,
        la.id as latest_apply_id,
        la.status as latest_apply_status,
        la.job_id as latest_apply_job_id,
        la.created_at as latest_apply_request_created_at,
        la.updated_at as latest_apply_request_updated_at,
        la.started_at as latest_apply_started_at,
        la.finished_at as latest_apply_finished_at,
        la.requested_by_user_name as latest_apply_requested_by_user_name,
        la.selected_row_count as latest_apply_selected,
        la.applied_row_count as latest_apply_applied,
        la.failed_row_count as latest_apply_failed,
        la.blocked_row_count as latest_apply_blocked,
        la.summary_json as latest_apply_summary_json
      from counted c
      left join lateral (
        select
          count(*) as row_count,
          count(*) filter (where r.approval_status = 'approved') as approval_approved,
          count(*) filter (where r.approval_status = 'pending') as approval_pending,
          count(*) filter (where r.approval_status = 'rejected') as approval_rejected,
          count(*) filter (where r.last_apply_status = 'applied') as apply_applied,
          count(*) filter (where r.last_apply_status = 'blocked') as apply_blocked,
          count(*) filter (where r.last_apply_status = 'failed') as apply_failed,
          count(*) filter (where r.last_apply_status = 'not_requested') as apply_not_requested,
          count(*) filter (where r.last_apply_status = 'queued') as apply_queued,
          count(*) filter (where r.last_apply_status = 'running') as apply_running
        from pending_purchase_rows r
        where r.packet_id = c.id
      ) rc on true
      left join lateral (
        select a.id, a.status, a.job_id, a.created_at, a.updated_at, a.started_at, a.finished_at,
               a.selected_row_count, a.applied_row_count, a.failed_row_count, a.blocked_row_count,
               a.summary_json, u.name as requested_by_user_name
        from pending_purchase_apply_requests a
        left join users u on u.id = a.requested_by_user_id
        where a.packet_id = c.id
        order by a.created_at desc, a.id desc
        limit 1
      ) la on true
      order by c.generated_at desc, c.id desc
    `,
    [
      filters.status,
      filters.source,
      siteKeyJson,
      searchPattern,
      filters.after,
      filters.before,
      limit,
      offset,
    ],
  )

  const totalCount = result.rows[0] ? Number.parseInt(result.rows[0].total_count, 10) : 0
  const items = result.rows.map((row) => mapPendingPurchasePacketListItem(row))
  return { items, totalCount }
}

export async function countPendingPurchasePacketsMatching(
  pool: Pool,
  filters: PendingPurchasePacketListFilters,
): Promise<number> {
  const siteKeyJson = filters.siteKey ? JSON.stringify([filters.siteKey]) : null
  const searchPattern = filters.search ? `%${filters.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null
  const result = await pool.query<{ total: string }>(
    `
      select count(*)::text as total
      from pending_purchase_packets p
      where ($1::text is null or p.status = $1::text)
        and ($2::text is null or p.source = $2::text)
        and ($3::text is null or p.site_keys_json @> $3::jsonb)
        and ($4::text is null or p.packet_title ilike $4::text)
        and ($5::text is null or p.generated_at >= $5::date)
        and ($6::text is null or p.generated_at < ($6::date + interval '1 day'))
    `,
    [filters.status, filters.source, siteKeyJson, searchPattern, filters.after, filters.before],
  )
  return Number.parseInt(result.rows[0]?.total ?? '0', 10)
}

function mapPendingPurchasePacketListItem(row: PendingPurchasePacketListDbRow): PendingPurchasePacketListItemRow {
  const latestApplyRequest: PendingPurchaseApplyRequestSummary | null = row.latest_apply_id
    ? {
        appliedRowCount: Number(row.latest_apply_applied ?? 0),
        blockedRowCount: Number(row.latest_apply_blocked ?? 0),
        failedRowCount: Number(row.latest_apply_failed ?? 0),
        finishedAt: toIsoOrNull(row.latest_apply_finished_at),
        jobId: readOptionalIntFromString(row.latest_apply_job_id),
        packetId: readIntFromString(row.id),
        requestId: readIntFromString(row.latest_apply_id),
        requestedAt: row.latest_apply_request_created_at ? toIso(row.latest_apply_request_created_at) : toIso(row.created_at),
        requestedByUser: row.latest_apply_requested_by_user_name,
        selectedRowCount: Number(row.latest_apply_selected ?? 0),
        startedAt: toIsoOrNull(row.latest_apply_started_at),
        status: (row.latest_apply_status ?? 'queued') as PendingPurchaseApplyRequestStatus,
        summary: row.latest_apply_summary_json ?? {},
        summaryText:
          typeof row.latest_apply_summary_json === 'object'
          && row.latest_apply_summary_json !== null
          && !Array.isArray(row.latest_apply_summary_json)
          && typeof (row.latest_apply_summary_json as Record<string, unknown>).summaryText === 'string'
            ? ((row.latest_apply_summary_json as Record<string, unknown>).summaryText as string)
            : null,
        updatedAt: row.latest_apply_request_updated_at ? toIso(row.latest_apply_request_updated_at) : toIso(row.updated_at),
      }
    : null

  return {
    applyCounts: {
      applied: Number.parseInt(row.apply_applied, 10),
      blocked: Number.parseInt(row.apply_blocked, 10),
      failed: Number.parseInt(row.apply_failed, 10),
      notRequested: Number.parseInt(row.apply_not_requested, 10),
      queued: Number.parseInt(row.apply_queued, 10),
      running: Number.parseInt(row.apply_running, 10),
    },
    approvalCounts: {
      approved: Number.parseInt(row.approval_approved, 10),
      pending: Number.parseInt(row.approval_pending, 10),
      rejected: Number.parseInt(row.approval_rejected, 10),
    },
    createdAt: toIso(row.created_at),
    generatedAt: toIso(row.generated_at),
    hasEtlDetails: summaryJsonHasClassifier(row.summary_json),
    hintBundleId: readPendingPurchaseHintBundleId(row.summary_json),
    importFileName: row.import_file_name,
    latestApplyRequest,
    operatorNoteDocuments: readPendingPurchaseOperatorNoteDocuments(row.summary_json),
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
