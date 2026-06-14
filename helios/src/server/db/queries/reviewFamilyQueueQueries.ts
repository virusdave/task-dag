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
  ReviewFamilyQueuePageInfo,
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
import {
  REVIEW_FAMILY_KEY_VERSION,
  REVIEW_MAX_LINE_ITEMS_PER_PAGE,
} from '../../../shared/contracts/index.js'
import { PendingPurchaseMarketListingSchema } from '../../../shared/contracts/domain/pendingPurchases.js'
import { buildTextPreview, toIsoString } from './helpers.js'
import { decodeReviewCursor, encodeReviewCursor } from './reviewFamilyQueueCursor.js'

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
  /** Position of this row's family within the selected page (SQL keyset order). */
  family_ord: number
}

/** One row per family from the narrow (cheap) page query — no JSON cracking. */
interface NarrowFamilyRow extends QueryResultRow {
  family_brand: string | null
  family_category: string | null
  family_subcategory: string | null
  has_drift: boolean
  line_item_count: number
  review_row_count: number
  total_family_count: number
  total_row_count: number
  page_row: boolean
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

/**
 * Phase A (top-level#16) family-aware keyset pagination.
 *
 * Two phases:
 *  1. A NARROW page query rolls the indexed join up to one row per family
 *     `(brand, category, subcategory)` — no `live_state_json` crack, no
 *     `regexp_replace` previews, no `evidence_json`, no observation join —
 *     orders families by `(has_drift desc, brand, category, subcategory)`
 *     and keyset-pages `familyLimit + 1` of them.
 *  2. A DETAIL query then fetches the SQL-projected line items (preview
 *     sources + reduced live state — see #dbb4897) and we fetch the latest
 *     observation ONLY for the selected page's families/products.
 *
 * This is the ~9× win: the whole-queue per-row JSON work that dominated
 * the old endpoint now happens for ≤ `familyLimit` families per request.
 */
export async function listReviewFamilyQueue(
  db: Queryable,
  filters: ReviewFamilyQueueQuery,
): Promise<ReviewFamilyQueueResponse> {
  // MSO is hardcoded false today (no brand-annotation source yet — Phase D).
  // `msoOnly` would discard every family, so short-circuit to an empty page
  // rather than paginate and throw the whole page away.
  if (filters.msoOnly) {
    return emptyResponse(filters)
  }

  const narrowRows = await runNarrowFamilyPageQuery(db, filters)

  const totalFamilyCount = narrowRows[0]?.total_family_count ?? 0
  const totalRowCount = narrowRows[0]?.total_row_count ?? 0
  const candidates = narrowRows.filter((r) => r.page_row)

  if (candidates.length === 0) {
    return emptyResponse(filters, { totalFamilyCount, totalRowCount })
  }

  // Apply the family limit + per-page item cap (massive-family guard).
  const familyLimit = filters.limit
  const selected: NarrowFamilyRow[] = []
  let returnedLineItemCount = 0
  let truncatedByItemCap = false
  let oversizedFamily: ReviewFamilyQueuePageInfo['oversizedFamily'] = null

  for (const family of candidates) {
    if (selected.length >= familyLimit) break

    // An oversized first family is returned alone so it is never silently
    // truncated; subsequent families that would breach the cap stop the page.
    if (family.line_item_count > REVIEW_MAX_LINE_ITEMS_PER_PAGE) {
      if (selected.length === 0) {
        selected.push(family)
        returnedLineItemCount += family.line_item_count
        truncatedByItemCap = true
        oversizedFamily = {
          familyKey: {
            brand: family.family_brand,
            category: family.family_category,
            subcategory: family.family_subcategory,
          },
          lineItemCount: family.line_item_count,
        }
        console.warn('[review-queue] oversized family returned alone', {
          brand: family.family_brand,
          category: family.family_category,
          subcategory: family.family_subcategory,
          lineItemCount: family.line_item_count,
          cap: REVIEW_MAX_LINE_ITEMS_PER_PAGE,
        })
      } else {
        truncatedByItemCap = true
      }
      break
    }

    if (selected.length > 0 && returnedLineItemCount + family.line_item_count > REVIEW_MAX_LINE_ITEMS_PER_PAGE) {
      truncatedByItemCap = true
      break
    }

    selected.push(family)
    returnedLineItemCount += family.line_item_count
  }

  // `hasNextPage` reflects whether the keyset has more families beyond the
  // ones we actually emitted (the limit+1 fetch and/or item-cap stop).
  const hasNextPage = candidates.length > selected.length || truncatedByItemCap
  const boundary = selected[selected.length - 1] ?? null
  const endCursor =
    boundary && hasNextPage
      ? encodeReviewCursor({
          hasDrift: boundary.has_drift,
          brand: boundary.family_brand,
          category: boundary.family_category,
          subcategory: boundary.family_subcategory,
          filters,
        })
      : null

  // Detail fetch: only the selected families' line items + observations.
  const detailRows = await runFamilyDetailQuery(db, filters, selected)

  const targetedProductIds = new Set<number>()
  for (const row of detailRows) {
    if (row.target_entity_type === 'catalog_product') {
      targetedProductIds.add(row.target_entity_id)
    }
  }
  const observationByProductId = await fetchLatestObservationsByProductId(db, [...targetedProductIds])

  const families = buildFamilies(detailRows, observationByProductId)

  const pageInfo: ReviewFamilyQueuePageInfo = {
    familyKeyVersion: REVIEW_FAMILY_KEY_VERSION,
    hasNextPage,
    endCursor,
    familyLimit,
    maxLineItemsPerPage: REVIEW_MAX_LINE_ITEMS_PER_PAGE,
    returnedFamilyCount: families.length,
    returnedLineItemCount,
    truncatedByItemCap,
    oversizedFamily,
  }

  return { filters, families, totalRowCount, totalFamilyCount, pageInfo }
}

function emptyResponse(
  filters: ReviewFamilyQueueQuery,
  totals?: { totalFamilyCount: number; totalRowCount: number },
): ReviewFamilyQueueResponse {
  return {
    filters,
    families: [],
    totalRowCount: totals?.totalRowCount ?? 0,
    totalFamilyCount: totals?.totalFamilyCount ?? 0,
    pageInfo: {
      familyKeyVersion: REVIEW_FAMILY_KEY_VERSION,
      hasNextPage: false,
      endCursor: null,
      familyLimit: filters.limit,
      maxLineItemsPerPage: REVIEW_MAX_LINE_ITEMS_PER_PAGE,
      returnedFamilyCount: 0,
      returnedLineItemCount: 0,
      truncatedByItemCap: false,
      oversizedFamily: null,
    },
  }
}

/**
 * Append the shared review-queue filter predicates to `values`, returning
 * the SQL clauses (with `$N` placeholders pointing at `values`). Called
 * once per query so the narrow and detail queries get independent,
 * correctly-numbered placeholders over the same logical filter set.
 */
function buildFilterClauses(filters: ReviewFamilyQueueQuery, values: unknown[]): string[] {
  const clauses: string[] = [`pb.status = 'ready'`]

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

  return clauses
}

/**
 * Phase 1 — narrow family-page query. Rolls the indexed join up to one
 * row per `(brand, category, subcategory)` family, orders by
 * `(has_drift desc, brand, category, subcategory)` (all cheap columns),
 * and keyset-pages `limit + 1`. Null brand/category/subcategory are paged
 * via explicit `*_is_null` flags so a `NULL` and an empty string never
 * collapse in the keyset comparison. Totals (whole-queue family/row
 * counts) ride along via a `totals left join page` so an empty page still
 * returns them.
 */
async function runNarrowFamilyPageQuery(
  db: Queryable,
  filters: ReviewFamilyQueueQuery,
): Promise<NarrowFamilyRow[]> {
  const values: unknown[] = []
  const filterClauses = buildFilterClauses(filters, values)

  let cursorPredicate = ''
  if (filters.cursor) {
    const cursor = decodeReviewCursor(filters.cursor, filters)
    const driftRank = cursor.hasDrift ? 0 : 1
    values.push(driftRank) // c_drift_rank
    const pDrift = values.length
    values.push(cursor.brand === null) // c_brand_is_null
    const pBrandNull = values.length
    values.push(cursor.brand ?? '') // c_brand_sort
    const pBrandSort = values.length
    values.push(cursor.category === null)
    const pCatNull = values.length
    values.push(cursor.category ?? '')
    const pCatSort = values.length
    values.push(cursor.subcategory === null)
    const pSubNull = values.length
    values.push(cursor.subcategory ?? '')
    const pSubSort = values.length
    cursorPredicate = `
      where (
        fs.drift_rank, fs.brand_is_null, fs.brand_sort,
        fs.category_is_null, fs.category_sort,
        fs.subcategory_is_null, fs.subcategory_sort
      ) > (
        $${pDrift}::int, $${pBrandNull}::boolean, $${pBrandSort}::text collate "C",
        $${pCatNull}::boolean, $${pCatSort}::text collate "C",
        $${pSubNull}::boolean, $${pSubSort}::text collate "C"
      )`
  }

  values.push(filters.limit + 1)
  const limitParam = values.length

  const result = await db.query<NarrowFamilyRow>(
    `
      with candidate_items as (
        select
          cg.brand_name as family_brand,
          cg.category_name as family_category,
          cg.subcategory_name as family_subcategory,
          (cg.reconcile_status = 'drifted') as is_drifted,
          pli.proposal_row_id
        from proposal_line_items pli
        inner join proposal_rows pr on pr.id = pli.proposal_row_id
        inner join proposal_batches pb on pb.id = pr.proposal_batch_id
        inner join catalog_groups cg on cg.id = pli.catalog_group_id
        where ${filterClauses.join(' and ')}
      ),
      family_rollup as (
        select
          family_brand, family_category, family_subcategory,
          bool_or(is_drifted) as has_drift,
          count(*)::int as line_item_count,
          count(distinct proposal_row_id)::int as review_row_count
        from candidate_items
        group by family_brand, family_category, family_subcategory
      ),
      family_sorted as (
        select
          family_rollup.*,
          case when has_drift then 0 else 1 end as drift_rank,
          (family_brand is null) as brand_is_null,
          coalesce(family_brand, '') collate "C" as brand_sort,
          (family_category is null) as category_is_null,
          coalesce(family_category, '') collate "C" as category_sort,
          (family_subcategory is null) as subcategory_is_null,
          coalesce(family_subcategory, '') collate "C" as subcategory_sort
        from family_rollup
      ),
      totals as (
        select
          count(*)::int as total_family_count,
          coalesce(sum(review_row_count), 0)::int as total_row_count
        from family_sorted
      ),
      page as (
        select fs.*
        from family_sorted fs
        ${cursorPredicate}
        order by
          fs.drift_rank, fs.brand_is_null, fs.brand_sort,
          fs.category_is_null, fs.category_sort,
          fs.subcategory_is_null, fs.subcategory_sort
        limit $${limitParam}
      )
      select
        (page.family_brand is not null or page.family_category is not null
          or page.family_subcategory is not null or page.has_drift is not null) as page_row,
        page.family_brand,
        page.family_category,
        page.family_subcategory,
        page.has_drift,
        page.line_item_count,
        page.review_row_count,
        totals.total_family_count,
        totals.total_row_count
      from totals
      left join page on true
      order by
        page.drift_rank asc nulls last,
        page.brand_is_null asc nulls last,
        page.brand_sort asc nulls last,
        page.category_is_null asc nulls last,
        page.category_sort asc nulls last,
        page.subcategory_is_null asc nulls last,
        page.subcategory_sort asc nulls last
    `,
    values,
  )

  // Normalize the synthetic totals-only row (page columns null) to page_row=false.
  return result.rows.map((row) => ({ ...row, page_row: Boolean(row.page_row) }))
}

/**
 * Phase 2 — detail query for the selected page families only. Joins
 * `catalog_groups` by null-safe `(brand, category, subcategory)` equality
 * to the families chosen in Phase 1, then their line items, applying the
 * SAME filters. This is the only query allowed to read `live_state_json`,
 * and it does so for ≤ `familyLimit` families. It keeps the #dbb4897 SQL
 * projection — preview sources (length-bounded prefixes) + reduced live
 * state — so the per-row payload trimming is preserved on the page.
 */
async function runFamilyDetailQuery(
  db: Queryable,
  filters: ReviewFamilyQueueQuery,
  selected: NarrowFamilyRow[],
): Promise<FamilyQueueRow[]> {
  if (selected.length === 0) return []

  const selectedFamiliesJson = JSON.stringify(
    selected.map((f, index) => ({
      ord: index,
      brand: f.family_brand,
      category: f.family_category,
      subcategory: f.family_subcategory,
    })),
  )

  const values: unknown[] = [selectedFamiliesJson]
  const filterClauses = buildFilterClauses(filters, values)

  const result = await db.query<FamilyQueueRow>(
    `
      with selected_families as (
        select ord::int as ord, brand::text as family_brand,
               category::text as family_category, subcategory::text as family_subcategory
        from jsonb_to_recordset($1::jsonb)
          as x(ord int, brand text, category text, subcategory text)
      )
      select
        pli.id,
        pli.proposal_row_id,
        pli.catalog_group_id,
        pli.target_entity_type,
        pli.target_entity_id,
        pli.field_path,
        -- Ship only what previews/pricing need, not the full value_json blobs
        -- (#dbb4897): json-string values -> whitespace-collapsed, length-bounded
        -- prefix; other scalars (e.g. prices) pass through raw so numeric /
        -- canonicalisation stays identical.
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
        -- preserving original product order (#dbb4897).
        lsp.live_state_json,
        sf.ord as family_ord
      from selected_families sf
      inner join catalog_groups cg
        on cg.brand_name is not distinct from sf.family_brand
       and cg.category_name is not distinct from sf.family_category
       and cg.subcategory_name is not distinct from sf.family_subcategory
      inner join proposal_line_items pli on pli.catalog_group_id = cg.id
      inner join proposal_rows pr on pr.id = pli.proposal_row_id
      inner join proposal_batches pb on pb.id = pr.proposal_batch_id
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
      where ${filterClauses.join(' and ')}
      order by sf.ord, pli.proposal_row_id, pli.id
    `,
    values,
  )

  return result.rows
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

/**
 * Build the page's `ReviewFamily[]` from the (page-scoped) detail rows.
 * Families are keyed by Phase A identity `(brand, category, subcategory)`;
 * `sizeName` is display-only ("Mixed" when a family spans multiple sizes,
 * the single size otherwise) and is NOT part of identity in
 * `familyKeyVersion: 1`. Families are returned in the SQL keyset page order
 * (`family_ord`) so the page is consistent with the cursor boundary.
 */
function buildFamilies(
  rows: FamilyQueueRow[],
  observationByProductId: Map<number, ObservationRow>,
): ReviewFamily[] {
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

  type WorkingFamily = {
    brand: string | null
    category: string | null
    subcategory: string | null
    ord: number
    sizeNames: Set<string>
    rows: ReviewRow[]
  }
  const familiesByKey = new Map<string, WorkingFamily>()

  for (const [, group] of proposalRowGroups) {
    const reviewRow = buildReviewRow(group, observationByProductId)
    if (!reviewRow) continue

    const first = group[0]!
    const keyStr = familyIdentityToString(first)
    let working = familiesByKey.get(keyStr)
    if (!working) {
      working = {
        brand: first.brand_name,
        category: first.category_name,
        subcategory: first.subcategory_name,
        ord: first.family_ord,
        sizeNames: new Set<string>(),
        rows: [],
      }
      familiesByKey.set(keyStr, working)
    }
    working.rows.push(reviewRow)
    for (const size of readRowSizeNames(group)) working.sizeNames.add(size)
  }

  const families: ReviewFamily[] = []
  for (const working of familiesByKey.values()) {
    working.rows.sort(compareRowsForReviewer)
    const driftedRowCount = working.rows.filter((r) => r.reconcileStatus === 'drifted').length
    const maxPriceSpread = working.rows.reduce<number | null>((acc, r) => {
      const spread = r.pricingLadder?.priceSpread ?? null
      if (spread === null) return acc
      if (acc === null || spread > acc) return spread
      return acc
    }, null)

    // MSO chip: not yet wired to a brand-level annotation store; surface
    // false for v1 (the row contract supports it for when we wire it).
    const mso = { isMSOBrand: false, msoBrandId: null, isHouseBrand: false }

    // Phase A display-only size label: a single size renders verbatim,
    // multiple sizes render "Mixed"; identity stays size-agnostic.
    const sizeName =
      working.sizeNames.size === 1
        ? [...working.sizeNames][0]!
        : working.sizeNames.size > 1
          ? 'Mixed'
          : null

    families.push({
      familyKey: {
        brand: working.brand,
        category: working.category,
        subcategory: working.subcategory,
        sizeName,
      },
      mso,
      ordering: {
        driftedRowCount,
        msoFirst: mso.isMSOBrand,
        maxPriceSpread,
      },
      rows: working.rows,
    })
  }

  // Preserve the SQL keyset page order so families line up with the cursor.
  families.sort((a, b) => {
    const ordA = familiesByKey.get(familyKeyToOrdString(a.familyKey))?.ord ?? 0
    const ordB = familiesByKey.get(familyKeyToOrdString(b.familyKey))?.ord ?? 0
    return ordA - ordB
  })

  return families
}

function familyIdentityToString(row: FamilyQueueRow): string {
  return JSON.stringify([row.brand_name, row.category_name, row.subcategory_name])
}

function familyKeyToOrdString(key: ReviewFamily['familyKey']): string {
  return JSON.stringify([key.brand, key.category, key.subcategory])
}

/** Distinct sizeNames represented by a proposal row's targeted product(s). */
function readRowSizeNames(group: FamilyQueueRow[]): string[] {
  const sizes = new Set<string>()
  for (const row of group) {
    const liveProducts = extractLiveStateProducts(row.live_state_json)
    if (row.target_entity_type === 'catalog_product') {
      const p = liveProducts.find((lp) => lp.productId === row.target_entity_id)
      if (p?.sizeName) sizes.add(p.sizeName)
    } else {
      for (const p of liveProducts) {
        if (p.sizeName) sizes.add(p.sizeName)
      }
    }
  }
  return [...sizes]
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


