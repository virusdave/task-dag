/**
 * Family-grouped review queue (issue #15).
 *
 * Joins `proposal_line_items` to their owning catalog group + the
 * latest cached LitAlerts market-evidence row for the targeted SKU, then
 * groups (in JS) into family panels keyed by
 * `(brand, category, subcategory, sizeName)` so the reviewer queue can
 * be rendered as cohesive family cards rather than as a flat list of
 * decision-first line items.
 *
 * See `docs/helios/canonical-review-row/README.md` for the cross-surface
 * contract this endpoint serves.
 */
import type { QueryResultRow } from 'pg'

import type {
  JsonValue,
  PendingPurchaseMarketListing,
  ReviewFamily,
  ReviewFamilyQueueQuery,
  ReviewFamilyQueueResponse,
  ReviewFieldComparison,
  ReviewRow,
  ReviewRowLineItemHandle,
  ReviewRowPricingLadder,
  ValidationIssue,
} from '../../../shared/contracts/index.js'
import type { FieldPath } from '../../../shared/domain/fieldPaths.js'
import type { Queryable } from '../pool.js'
import { PendingPurchaseMarketListingSchema } from '../../../shared/contracts/domain/pendingPurchases.js'
import { buildTextPreview, toIsoString } from './helpers.js'

interface FamilyQueueRow extends QueryResultRow {
  approval_status: 'approved' | 'pending' | 'rejected' | 'superseded'
  // Preview *sources* (not the full value_json). For json-string values the SQL
  // ships a whitespace-normalised, length-bounded prefix (string fields are the
  // bulk of the payload and only a ≤160-char preview is ever rendered); for
  // non-string scalars (e.g. prices) the raw json value is passed through
  // unchanged. `buildTextPreview` / `readNumericValue` run on these exactly as
  // they did on the full value_json, so previews + pricing stay byte-identical.
  // See the SQL projection below for why this slashes the response payload.
  baseline_preview_src: JsonValue
  brand_name: string | null
  catalog_group_id: number
  category_name: string | null
  edited_preview_src: JsonValue | null
  effective_preview_src: JsonValue
  field_path: string
  group_name: string
  id: number
  // Reduced live state: only `{ products: [{ productId, name, tab, sizeName,
  // price }] }` (the fields the family-queue actually reads), in original order.
  live_state_json: JsonValue
  notes: string | null
  proposal_batch_type: string
  proposal_row_id: number
  reconcile_status: string
  subcategory_name: string | null
  suggested_preview_src: JsonValue
  target_entity_id: number
  target_entity_type: 'catalog_group' | 'catalog_product'
  validation_issues_json: ValidationIssue[]
  version: number
}

interface ObservationRow extends QueryResultRow {
  product_id: number
  captured_at: Date
  evidence_json: JsonValue
  listing_count: number | null
  pricing_eligible_listing_count: number | null
}

interface LiveStateProduct {
  productId: number
  name: string | null
  tab: string | null
  sizeName: string | null
  price: number | null
}

export async function listReviewFamilyQueue(
  db: Queryable,
  filters: ReviewFamilyQueueQuery,
): Promise<ReviewFamilyQueueResponse> {
  const { values, whereSql } = buildFamilyWhere(filters)

  const itemsResult = await db.query<FamilyQueueRow>(
    `
      select
        pli.id,
        pli.proposal_row_id,
        pli.catalog_group_id,
        pli.target_entity_type,
        pli.target_entity_id,
        pli.field_path,
        -- Ship only what previews/pricing need, not the full value_json blobs.
        -- json-string values -> whitespace-collapsed, length-bounded prefix
        -- (a 160-char preview never needs more than this); other scalars (e.g.
        -- prices) pass through raw so numeric/canonicalisation stays identical.
        case
          when jsonb_typeof(pli.baseline_value_json) = 'string'
            then to_jsonb(left(regexp_replace(pli.baseline_value_json #>> '{}', '\\s+', ' ', 'g'), 400))
          else pli.baseline_value_json
        end as baseline_preview_src,
        case
          when jsonb_typeof(pli.suggested_value_json) = 'string'
            then to_jsonb(left(regexp_replace(pli.suggested_value_json #>> '{}', '\\s+', ' ', 'g'), 400))
          else pli.suggested_value_json
        end as suggested_preview_src,
        case
          when jsonb_typeof(pli.edited_value_json) = 'string'
            then to_jsonb(left(regexp_replace(pli.edited_value_json #>> '{}', '\\s+', ' ', 'g'), 400))
          else pli.edited_value_json
        end as edited_preview_src,
        case
          when jsonb_typeof(pli.effective_value_json) = 'string'
            then to_jsonb(left(regexp_replace(pli.effective_value_json #>> '{}', '\\s+', ' ', 'g'), 400))
          else pli.effective_value_json
        end as effective_preview_src,
        pli.approval_status,
        pli.version,
        pli.notes,
        pli.validation_issues_json,
        pb.type as proposal_batch_type,
        cg.group_name,
        cg.brand_name,
        cg.category_name,
        cg.subcategory_name,
        cg.reconcile_status,
        -- Reduced live state: only the product fields the family-queue reads,
        -- preserving original product order. The full live_state_json carries
        -- ~19 unused top-level keys + 8 unused per-product fields and was the
        -- single biggest contributor to this endpoint's payload.
        lsp.live_state_json
      from proposal_line_items pli
      inner join proposal_rows pr on pr.id = pli.proposal_row_id
      inner join proposal_batches pb on pb.id = pr.proposal_batch_id
      inner join catalog_groups cg on cg.id = pli.catalog_group_id
      left join lateral (
        select jsonb_build_object(
          'products',
          coalesce(
            (
              select jsonb_agg(
                       jsonb_build_object(
                         'productId', elem -> 'productId',
                         'name', elem -> 'name',
                         'tab', elem -> 'tab',
                         'sizeName', elem -> 'sizeName',
                         'price', elem -> 'price'
                       )
                       order by ord
                     )
              from jsonb_array_elements(
                     case
                       when jsonb_typeof(cg.live_state_json -> 'products') = 'array'
                         then cg.live_state_json -> 'products'
                       else '[]'::jsonb
                     end
                   ) with ordinality as t(elem, ord)
            ),
            '[]'::jsonb
          )
        ) as live_state_json
      ) lsp on true
      ${whereSql}
      order by pli.proposal_row_id, pli.id
    `,
    values,
  )

  // Collect distinct product ids targeted by these line items (catalog_product
  // targets) so we can pull the latest LitAlerts observation for each.
  const targetedProductIds = new Set<number>()
  for (const row of itemsResult.rows) {
    if (row.target_entity_type === 'catalog_product') {
      targetedProductIds.add(row.target_entity_id)
    }
  }

  const observationByProductId = await fetchLatestObservationsByProductId(
    db,
    [...targetedProductIds],
  )

  return buildFamilyQueueResponse(filters, itemsResult.rows, observationByProductId)
}

function buildFamilyWhere(filters: ReviewFamilyQueueQuery): { values: unknown[]; whereSql: string } {
  const clauses: string[] = [`pb.status = 'ready'`]
  const values: unknown[] = []

  if (filters.approvalStatus) {
    values.push(filters.approvalStatus)
    clauses.push(`pli.approval_status = $${values.length}`)
  } else {
    // Default to pending so reviewers see the active queue.
    clauses.push(`pli.approval_status = 'pending'`)
  }

  if (filters.proposalType) {
    values.push(filters.proposalType)
    clauses.push(`pb.type = $${values.length}`)
  }

  if (filters.driftOnly) {
    clauses.push(`cg.reconcile_status = 'drifted'`)
  }

  if (filters.search) {
    values.push(`%${filters.search}%`)
    clauses.push(`(cg.group_name ilike $${values.length} or coalesce(cg.brand_name, '') ilike $${values.length})`)
  }

  // `msoOnly` filtering is applied after grouping (MSO lookup is brand-level
  // and lives off-row); the JS pass discards non-MSO families when set.

  return { values, whereSql: `where ${clauses.join(' and ')}` }
}

async function fetchLatestObservationsByProductId(
  db: Queryable,
  productIds: number[],
): Promise<Map<number, ObservationRow>> {
  if (productIds.length === 0) {
    return new Map()
  }
  const result = await db.query<ObservationRow>(
    `
      select distinct on (product_id)
        product_id, captured_at, evidence_json,
        listing_count, pricing_eligible_listing_count
      from litalerts_competitor_observations
      where product_id = any($1::bigint[]) and status = 'succeeded'
      order by product_id, captured_at desc
    `,
    [productIds],
  )
  const byId = new Map<number, ObservationRow>()
  for (const row of result.rows) {
    byId.set(Number(row.product_id), row)
  }
  return byId
}

function buildFamilyQueueResponse(
  filters: ReviewFamilyQueueQuery,
  rows: FamilyQueueRow[],
  observationByProductId: Map<number, ObservationRow>,
): ReviewFamilyQueueResponse {
  // Group rows by proposal_row_id (one ReviewRow per proposal row).
  const proposalRowGroups = new Map<number, FamilyQueueRow[]>()
  for (const row of rows) {
    const arr = proposalRowGroups.get(row.proposal_row_id)
    if (arr) {
      arr.push(row)
    } else {
      proposalRowGroups.set(row.proposal_row_id, [row])
    }
  }

  // Build review rows + index them by family key.
  type WorkingFamily = {
    key: ReviewFamily['familyKey']
    rows: ReviewRow[]
  }
  const familiesByKey = new Map<string, WorkingFamily>()
  let totalRowCount = 0

  for (const [, group] of proposalRowGroups) {
    const reviewRow = buildReviewRow(group, observationByProductId)
    if (!reviewRow) continue
    totalRowCount += 1

    const familyKey = readFamilyKey(group[0]!)
    const keyStr = familyKeyToString(familyKey)
    const existing = familiesByKey.get(keyStr)
    if (existing) {
      existing.rows.push(reviewRow)
    } else {
      familiesByKey.set(keyStr, { key: familyKey, rows: [reviewRow] })
    }
  }

  // Sort rows within a family + compute ordering hints + apply MSO filter.
  const families: ReviewFamily[] = []
  for (const working of familiesByKey.values()) {
    working.rows.sort(compareRowsForReviewer)
    const driftedRowCount = working.rows.filter(
      (r) => r.reconcileStatus === 'drifted',
    ).length
    const maxPriceSpread = working.rows.reduce<number | null>((acc, r) => {
      const spread = r.pricingLadder?.priceSpread ?? null
      if (spread === null) return acc
      if (acc === null || spread > acc) return spread
      return acc
    }, null)

    // MSO chip: not yet wired to a brand-level annotation store; surface
    // false for v1 (the row contract supports it for when we wire it).
    const mso = { isMSOBrand: false, msoBrandId: null, isHouseBrand: false }

    if (filters.msoOnly && !mso.isMSOBrand) {
      continue
    }

    families.push({
      familyKey: working.key,
      mso,
      ordering: {
        driftedRowCount,
        msoFirst: mso.isMSOBrand,
        maxPriceSpread,
      },
      rows: working.rows,
    })
  }

  families.sort(compareFamiliesForReviewer)

  return {
    filters,
    families,
    totalRowCount,
    totalFamilyCount: families.length,
  }
}

function buildReviewRow(
  rows: FamilyQueueRow[],
  observationByProductId: Map<number, ObservationRow>,
): ReviewRow | null {
  if (rows.length === 0) return null
  const first = rows[0]!

  const comparisons: ReviewFieldComparison[] = []
  const lineItems: ReviewRowLineItemHandle[] = []
  const validationIssues: ValidationIssue[] = []
  let notes: string | null = null

  for (const r of rows) {
    const baselinePreview = buildTextPreview(r.baseline_preview_src)
    const suggestedPreview = buildTextPreview(r.suggested_preview_src)
    const proposedSource = r.edited_preview_src ?? r.suggested_preview_src
    const proposedPreview = buildTextPreview(proposedSource)
    const effectivePreview = buildTextPreview(r.effective_preview_src)

    const fieldPath = r.field_path as FieldPath
    comparisons.push({
      lineItemId: r.id,
      fieldPath,
      label: labelForFieldPath(fieldPath),
      liveValueText: baselinePreview.text,
      proposedValueText: proposedPreview.text || suggestedPreview.text,
      effectiveValueText: effectivePreview.text,
      changeKind: changeKindForFieldPath(fieldPath),
      approvalStatus: r.approval_status,
    })
    lineItems.push({
      lineItemId: r.id,
      fieldPath,
      version: r.version,
      approvalStatus: r.approval_status,
      // The full edited/suggested/baseline value_json blobs were historically
      // returned here but are never read by any client (ReviewPage renders only
      // fieldPath/version/approvalStatus from lineItems). They were a large,
      // pure-waste slice of this endpoint's payload, so they are no longer
      // fetched; we emit nulls to keep the wire contract stable for any cached
      // client bundle. Repopulate (and add them back to the SQL) only if a
      // consumer ever genuinely needs the full values.
      editedValue: null,
      suggestedValue: null,
      baselineValue: null,
    })
    if (Array.isArray(r.validation_issues_json)) {
      validationIssues.push(...r.validation_issues_json)
    }
    if (r.notes && !notes) {
      notes = r.notes
    }
  }

  const pricingLadder = buildPricingLadder(first, rows, observationByProductId)

  return {
    catalogGroupId: first.catalog_group_id,
    proposalRowId: first.proposal_row_id,
    rowTitle: buildRowTitle(first),
    reconcileStatus: first.reconcile_status,
    approvalRollup: rollupApproval(rows.map((r) => r.approval_status)),
    targetEntityId: first.target_entity_id,
    targetEntityType: first.target_entity_type,
    comparisons,
    pricingLadder,
    validationIssues,
    operatorNote: notes,
    lineItems,
  }
}

function buildPricingLadder(
  first: FamilyQueueRow,
  rows: FamilyQueueRow[],
  observationByProductId: Map<number, ObservationRow>,
): ReviewRowPricingLadder | null {
  // Resolve the SKU we render the ladder for: prefer the target product
  // if the proposal targets a catalog_product; otherwise pick the first
  // product in live_state_json.
  const liveProducts = extractLiveStateProducts(first.live_state_json)
  let targetProductId: number | null = null
  if (first.target_entity_type === 'catalog_product') {
    targetProductId = first.target_entity_id
  } else {
    targetProductId = liveProducts[0]?.productId ?? null
  }
  if (!targetProductId || targetProductId <= 0) {
    return null
  }

  const liveProduct = liveProducts.find((p) => p.productId === targetProductId) ?? null
  const livePrice = liveProduct?.price ?? null

  // Proposed price comes from any pricing line item in this proposal row.
  const pricingLine = rows.find((r) => r.field_path === 'products.price') ?? null
  // Price values are json numbers, so the SQL passes them through raw (not as a
  // bounded string), and readNumericValue sees the same value it always did.
  const proposedPrice = pricingLine ? readNumericValue(pricingLine.edited_preview_src ?? pricingLine.suggested_preview_src) : null

  const observation = observationByProductId.get(targetProductId) ?? null

  let freshness: ReviewRowPricingLadder['evidenceFreshness'] = 'absent'
  let capturedAt: string | null = null
  let competitorListings: PendingPurchaseMarketListing[] = []
  let marketAveragePostTax: number | null = null
  let marketMedianPostTax: number | null = null

  if (observation) {
    capturedAt = toIsoString(observation.captured_at)
    const ageMs = Math.max(0, Date.now() - observation.captured_at.getTime())
    if (ageMs <= 24 * 60 * 60 * 1000) freshness = 'fresh'
    else if (ageMs <= 4 * 24 * 60 * 60 * 1000) freshness = 'stale'
    else if (ageMs <= 7 * 24 * 60 * 60 * 1000) freshness = 'very_stale'
    else freshness = 'expired'

    competitorListings = extractMatchedListings(observation.evidence_json)
    const eligiblePrices = competitorListings
      .filter((l) => l.eligibleForPricing)
      .map((l) => l.postTaxPrice)
      .filter((n) => Number.isFinite(n))
    if (eligiblePrices.length > 0) {
      marketAveragePostTax = eligiblePrices.reduce((a, b) => a + b, 0) / eligiblePrices.length
      const sorted = [...eligiblePrices].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      marketMedianPostTax = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
    }
  }

  let priceSpread: number | null = null
  if (livePrice !== null && competitorListings.length > 0) {
    let max = 0
    for (const l of competitorListings) {
      if (!l.eligibleForPricing || !Number.isFinite(l.postTaxPrice)) continue
      const delta = Math.abs(l.postTaxPrice - livePrice)
      if (delta > max) max = delta
    }
    priceSpread = max
  } else if (marketAveragePostTax !== null && livePrice !== null) {
    priceSpread = Math.abs(marketAveragePostTax - livePrice)
  }

  return {
    productId: targetProductId,
    livePrice,
    proposedPrice,
    marketAveragePostTax,
    marketMedianPostTax,
    competitorListings,
    evidenceFreshness: freshness,
    evidenceCapturedAt: capturedAt,
    priceSpread,
  }
}

function extractLiveStateProducts(liveState: JsonValue): LiveStateProduct[] {
  if (!liveState || typeof liveState !== 'object' || Array.isArray(liveState)) return []
  const products = (liveState as Record<string, JsonValue>).products
  if (!Array.isArray(products)) return []
  const entries: LiveStateProduct[] = []
  for (const raw of products) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, JsonValue>
    const productId = typeof record.productId === 'number' ? record.productId : Number(record.productId)
    if (!Number.isFinite(productId) || productId <= 0) continue
    entries.push({
      productId,
      name: typeof record.name === 'string' ? record.name : null,
      tab: typeof record.tab === 'string' ? record.tab : null,
      sizeName: typeof record.sizeName === 'string' ? record.sizeName : null,
      price: typeof record.price === 'number' && Number.isFinite(record.price) ? record.price : null,
    })
  }
  return entries
}

function extractMatchedListings(evidenceJson: JsonValue): PendingPurchaseMarketListing[] {
  if (!evidenceJson || typeof evidenceJson !== 'object' || Array.isArray(evidenceJson)) return []
  const candidate = (evidenceJson as Record<string, JsonValue>).matchedListings
  if (!Array.isArray(candidate)) return []
  const listings: PendingPurchaseMarketListing[] = []
  for (const raw of candidate) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, JsonValue>
    const normalized = {
      category: typeof record.category === 'string' ? record.category : null,
      distanceBand: record.distanceBand ?? 'unknown',
      distanceMiles:
        typeof record.distanceMiles === 'number' && Number.isFinite(record.distanceMiles)
          ? record.distanceMiles
          : null,
      dispensaryName: typeof record.dispensaryName === 'string' ? record.dispensaryName : '',
      eligibleForPricing: typeof record.eligibleForPricing === 'boolean' ? record.eligibleForPricing : false,
      exclusionReason: typeof record.exclusionReason === 'string' ? record.exclusionReason : null,
      imageUrl: typeof record.imageUrl === 'string' && record.imageUrl ? record.imageUrl : null,
      listingName: typeof record.listingName === 'string' ? record.listingName : '',
      matchTier: record.matchTier ?? 'weak',
      postTaxPrice: typeof record.postTaxPrice === 'number' ? record.postTaxPrice : Number.NaN,
      preTaxPrice: typeof record.preTaxPrice === 'number' ? record.preTaxPrice : Number.NaN,
      source: record.source ?? 'nearby',
      url: typeof record.url === 'string' ? record.url : null,
    }
    const parsed = PendingPurchaseMarketListingSchema.safeParse(normalized)
    if (parsed.success) listings.push(parsed.data)
  }
  return listings
}

function readFamilyKey(row: FamilyQueueRow): ReviewFamily['familyKey'] {
  const liveProducts = extractLiveStateProducts(row.live_state_json)
  let sizeName: string | null = null
  if (row.target_entity_type === 'catalog_product') {
    const p = liveProducts.find((lp) => lp.productId === row.target_entity_id)
    sizeName = p?.sizeName ?? null
  }
  if (!sizeName) {
    // Fall back to the first product's sizeName (catalog groups are
    // size-cohesive in practice; this is a stable proxy when not).
    sizeName = liveProducts[0]?.sizeName ?? null
  }
  return {
    brand: row.brand_name,
    category: row.category_name,
    subcategory: row.subcategory_name,
    sizeName,
  }
}

function familyKeyToString(key: ReviewFamily['familyKey']): string {
  return [key.brand ?? '∅', key.category ?? '∅', key.subcategory ?? '∅', key.sizeName ?? '∅'].join('|')
}

function buildRowTitle(row: FamilyQueueRow): string {
  const parts = [row.brand_name, row.group_name].filter((v): v is string => !!v && v.trim().length > 0)
  if (parts.length === 0) return `Catalog group #${row.catalog_group_id}`
  return parts.join(' — ')
}

function rollupApproval(statuses: Array<'approved' | 'pending' | 'rejected' | 'superseded'>): ReviewRow['approvalRollup'] {
  const unique = new Set(statuses.filter((s) => s !== 'superseded'))
  if (unique.size === 1) {
    const only = [...unique][0]!
    if (only === 'approved') return 'approved'
    if (only === 'rejected') return 'rejected'
    return 'pending'
  }
  if (unique.size === 0) return 'pending'
  return 'mixed'
}

function labelForFieldPath(path: FieldPath): string {
  switch (path) {
    case 'products.price':
      return 'Price'
    case 'description':
      return 'Description'
    default:
      return path
  }
}

function changeKindForFieldPath(path: FieldPath): ReviewFieldComparison['changeKind'] {
  switch (path) {
    case 'products.price':
      return 'pricing'
    case 'description':
      return 'description'
    default:
      return 'other'
  }
}

function readNumericValue(value: JsonValue): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function compareRowsForReviewer(a: ReviewRow, b: ReviewRow): number {
  // drifted first
  const aDrift = a.reconcileStatus === 'drifted' ? 1 : 0
  const bDrift = b.reconcileStatus === 'drifted' ? 1 : 0
  if (aDrift !== bDrift) return bDrift - aDrift

  // then by price spread descending
  const aSpread = a.pricingLadder?.priceSpread ?? -Infinity
  const bSpread = b.pricingLadder?.priceSpread ?? -Infinity
  if (aSpread !== bSpread) return bSpread - aSpread

  // stable tiebreak by row title
  return a.rowTitle.localeCompare(b.rowTitle)
}

function compareFamiliesForReviewer(a: ReviewFamily, b: ReviewFamily): number {
  // drifted families first
  if (a.ordering.driftedRowCount > 0 || b.ordering.driftedRowCount > 0) {
    if (a.ordering.driftedRowCount !== b.ordering.driftedRowCount) {
      return b.ordering.driftedRowCount - a.ordering.driftedRowCount
    }
  }

  // then MSO first
  if (a.mso.isMSOBrand !== b.mso.isMSOBrand) {
    return a.mso.isMSOBrand ? -1 : 1
  }

  // then largest spread first
  const aSpread = a.ordering.maxPriceSpread ?? -Infinity
  const bSpread = b.ordering.maxPriceSpread ?? -Infinity
  if (aSpread !== bSpread) return bSpread - aSpread

  // stable tiebreak
  const cmp = (a.familyKey.brand ?? '').localeCompare(b.familyKey.brand ?? '')
  if (cmp !== 0) return cmp
  const cmp2 = (a.familyKey.category ?? '').localeCompare(b.familyKey.category ?? '')
  if (cmp2 !== 0) return cmp2
  const cmp3 = (a.familyKey.subcategory ?? '').localeCompare(b.familyKey.subcategory ?? '')
  if (cmp3 !== 0) return cmp3
  return (a.familyKey.sizeName ?? '').localeCompare(b.familyKey.sizeName ?? '')
}
