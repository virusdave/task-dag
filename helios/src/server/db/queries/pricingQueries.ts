import type { QueryResultRow } from 'pg'

import type {
  GroupRecentSales,
  GroupRecentSalesProductRow,
  JsonValue,
  PricingFacetField,
  PricingFacetOption,
  PricingFacetsQuery,
  PricingFacetsResponse,
  PricingReviewItem,
  PricingReviewQuery,
  PricingReviewResponse,
  PricingRunDetailResponse,
  PricingRunGeneratedProduct,
  PricingRunListItem,
  PricingRunListQuery,
  PricingRunListResponse,
  PricingRunMarketListing,
  PricingRunRouteParams,
  PricingRunScopeKind,
  PricingSelectionFilters,
  PricingScopePreviewQuery,
  PricingScopePreviewResponse,
  PricingRunSkippedProduct,
  PricingRunTriggerSource,
  PricingSiteKey,
  ProposalLineItem,
  RecentSalesSummary,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'
import { buildEmptyGroupRecentSales, loadRecentSalesForGroups } from '../../catalog/liveRecentSales.js'
import { buildTextPreview, toIsoString } from './helpers.js'

interface PricingScopeRow extends QueryResultRow {
  brand_name: string | null
  catalog_group_id: number
  category_name: string | null
  group_name: string
  product_count: number
  product_ids: number[]
  subcategory_name: string | null
}

interface PricingRunRow extends QueryResultRow {
  config_json: JsonValue
  created_at: Date
  created_by_user: string | null
  id: number
  job_id: number | null
  job_status: PricingRunListItem['jobStatus']
  line_item_count: number
  row_count: number
  source: PricingRunListItem['source']
  status: PricingRunListItem['status']
  summary_json: JsonValue
  trigger_mode: PricingRunListItem['triggerMode']
}

interface PricingRunGroupRow extends QueryResultRow {
  approved_line_item_count: number
  brand_name: string | null
  catalog_group_id: number
  category_name: string | null
  evidence_json: JsonValue
  group_name: string
  line_item_count: number
  pending_line_item_count: number
  proposal_row_id: number
  rejected_line_item_count: number
  row_title: string
  subcategory_name: string | null
}

interface PricingReviewRow extends QueryResultRow {
  approval_status: ProposalLineItem['approvalStatus']
  approval_updated_at: Date | null
  approved_by_user: string | null
  baseline_snapshot_id: number | null
  baseline_value_json: JsonValue
  batch_created_at: Date
  batch_id: number
  batch_status: PricingRunListItem['status']
  brand_name: string | null
  catalog_group_id: number
  category_name: string | null
  config_json: JsonValue
  edited_value_json: JsonValue | null
  effective_value_json: JsonValue
  evidence_json: JsonValue
  field_path: ProposalLineItem['fieldPath']
  group_name: string
  id: number
  live_state_json: JsonValue
  live_state_hash: string
  notes: string | null
  proposal_row_id: number
  reconcile_status: string
  suggested_value_json: JsonValue
  target_entity_id: number
  target_entity_type: ProposalLineItem['targetEntityType']
  validation_issues_json: ProposalLineItem['validationIssues']
  version: number
}

export interface ResolvedPricingRunScope {
  catalogGroupIds: number[]
  matchedProductCount: number
  previewGroups: PricingScopePreviewResponse['previewGroups']
  // Product-id allowlist that must be passed through to the worker job
  // when one of the scope filters (sites/stockOnly/includePending) or
  // strict / family-expansion modes restricts which products inside a
  // group actually belong to this run. `undefined` means "no
  // product-level scoping" — the worker prices every product in every
  // selected group.
  scopedProductIds?: number[]
}

export async function previewPricingRunScope(
  db: Queryable,
  filters: PricingScopePreviewQuery,
  options?: { seedProductIds?: number[] },
): Promise<PricingScopePreviewResponse> {
  const resolved = await resolvePricingRunScope(db, filters, options)
  return {
    filters,
    matchedCatalogGroupCount: resolved.catalogGroupIds.length,
    matchedProductCount: resolved.matchedProductCount,
    previewGroups: resolved.previewGroups,
  }
}

type ScopeMode = 'all' | 'seed_only' | 'family_expanded'

function pickScopeMode(filters: PricingScopePreviewQuery, hasSeed: boolean): ScopeMode {
  if (filters.scopeKind === 'family_expansion_from_stock_or_pending') {
    return filters.strict ? 'seed_only' : 'family_expanded'
  }
  if (filters.scopeKind === 'full_catalog') {
    return hasSeed ? 'seed_only' : 'all'
  }
  // filtered_catalog
  return hasSeed ? 'seed_only' : 'all'
}

export async function resolvePricingRunScope(
  db: Queryable,
  filters: PricingScopePreviewQuery,
  options?: { seedProductIds?: number[] },
): Promise<ResolvedPricingRunScope> {
  const seedProductIds = options?.seedProductIds ?? null
  const hasSeed = seedProductIds !== null
  const mode: ScopeMode = pickScopeMode(filters, hasSeed)

  if (filters.scopeKind === 'family_expansion_from_stock_or_pending' && !hasSeed) {
    // Family expansion requires a seed set; the route validates this
    // before calling us, so this branch defensively returns an empty
    // scope rather than producing a misleading "everything matches"
    // catalog-wide query.
    return { catalogGroupIds: [], matchedProductCount: 0, previewGroups: [], scopedProductIds: [] }
  }

  const { sql, values } = buildResolvePricingRunScopeSql(filters, seedProductIds ?? [], mode)
  const result = await db.query<PricingScopeRow>(sql, values)

  const allScopedProductIds = new Set<number>()
  for (const row of result.rows) {
    for (const productId of row.product_ids ?? []) {
      allScopedProductIds.add(productId)
    }
  }

  return {
    catalogGroupIds: result.rows.map((row) => row.catalog_group_id),
    matchedProductCount: result.rows.reduce((total, row) => total + row.product_count, 0),
    previewGroups: result.rows
      .slice()
      .sort((left, right) => left.group_name.localeCompare(right.group_name) || left.catalog_group_id - right.catalog_group_id)
      .slice(0, 8)
      .map((row) => ({
        brandName: row.brand_name,
        catalogGroupId: row.catalog_group_id,
        categoryName: row.category_name,
        groupName: row.group_name,
        matchedProductCount: row.product_count,
        subcategoryName: row.subcategory_name,
      })),
    scopedProductIds: mode === 'all' ? undefined : [...allScopedProductIds].sort((left, right) => left - right),
  }
}

function buildResolvePricingRunScopeSql(
  filters: PricingScopePreviewQuery,
  seedProductIds: number[],
  mode: ScopeMode,
): { sql: string; values: unknown[] } {
  const values: unknown[] = []
  values.push(seedProductIds)
  const seedParam = `$${values.length}::int[]`
  values.push(filters.brands)
  const brandsParam = `$${values.length}::text[]`
  values.push(filters.categories)
  const categoriesParam = `$${values.length}::text[]`
  values.push(filters.subcategories)
  const subcategoriesParam = `$${values.length}::text[]`
  values.push(filters.search ?? null)
  const searchParam = `$${values.length}::text`
  values.push(mode)
  const modeParam = `$${values.length}::text`

  const sql = `
    with candidate_groups as (
      select
        cg.id,
        cg.group_name,
        cg.brand_name,
        cg.category_name,
        cg.subcategory_name,
        case
          when jsonb_typeof(cg.live_state_json -> 'products') = 'array' then cg.live_state_json -> 'products'
          else '[]'::jsonb
        end as products_json
      from catalog_groups cg
      where (cardinality(${brandsParam}) = 0 or cg.brand_name = any(${brandsParam}))
        and (cardinality(${categoriesParam}) = 0 or cg.category_name = any(${categoriesParam}))
        and (cardinality(${subcategoriesParam}) = 0 or cg.subcategory_name = any(${subcategoriesParam}))
        and (
          ${searchParam} is null
          or cg.group_name ilike '%' || ${searchParam} || '%'
          or coalesce(cg.brand_name, '') ilike '%' || ${searchParam} || '%'
          or exists (
            select 1 from jsonb_array_elements(
              case
                when jsonb_typeof(cg.live_state_json -> 'products') = 'array' then cg.live_state_json -> 'products'
                else '[]'::jsonb
              end
            ) as product
            where coalesce(product ->> 'name', '') ilike '%' || ${searchParam} || '%'
               or coalesce(product ->> 'shortName', '') ilike '%' || ${searchParam} || '%'
          )
        )
    ),
    catalog_products as (
      select
        cg.id as catalog_group_id,
        cg.group_name,
        cg.brand_name,
        cg.category_name,
        cg.subcategory_name,
        (product ->> 'productId')::int as product_id,
        nullif(trim(product ->> 'sizeName'), '') as size_name
      from candidate_groups cg
      cross join lateral jsonb_array_elements(cg.products_json) as product
      where (product ->> 'productId') ~ '^[0-9]+$'
    ),
    seed_family_sizes as (
      select distinct cp.catalog_group_id, cp.size_name
      from catalog_products cp
      where cp.product_id = any(${seedParam})
    ),
    family_expanded_products as (
      select cp.*
      from catalog_products cp
      inner join seed_family_sizes sfs
        on sfs.catalog_group_id = cp.catalog_group_id
       and sfs.size_name is not distinct from cp.size_name
    ),
    selected_products as (
      select * from catalog_products where ${modeParam} = 'all'
      union all
      select * from catalog_products where ${modeParam} = 'seed_only' and product_id = any(${seedParam})
      union all
      select * from family_expanded_products where ${modeParam} = 'family_expanded'
    )
    select
      sp.catalog_group_id,
      sp.group_name,
      sp.brand_name,
      sp.category_name,
      sp.subcategory_name,
      count(distinct sp.product_id)::int as product_count,
      array_agg(distinct sp.product_id order by sp.product_id) as product_ids
    from selected_products sp
    group by sp.catalog_group_id, sp.group_name, sp.brand_name, sp.category_name, sp.subcategory_name
    order by sp.catalog_group_id asc
  `

  return { sql, values }
}

export async function listPricingFacetOptions(
  db: Queryable,
  query: PricingFacetsQuery,
  options?: { seedProductIds?: number[] },
): Promise<PricingFacetsResponse> {
  const facet = query.facet
  const facetColumn = facet === 'brand' ? 'brand_name' : facet === 'category' ? 'category_name' : 'subcategory_name'
  // For the requested facet, ignore that facet's selected array when
  // counting candidates — so toggling a brand on doesn't hide the
  // other brands the reviewer might still want to pick. Other filters
  // are applied as usual.
  const previewFilters: PricingScopePreviewQuery = {
    brands: facet === 'brand' ? [] : query.brands,
    categories: facet === 'category' ? [] : query.categories,
    includePending: query.includePending,
    scopeKind: query.scopeKind,
    search: query.search,
    sites: query.sites,
    stockOnly: query.stockOnly,
    strict: query.strict,
    subcategories: facet === 'subcategory' ? [] : query.subcategories,
  }

  const seedProductIds = options?.seedProductIds ?? null
  const hasSeed = seedProductIds !== null
  const mode = pickScopeMode(previewFilters, hasSeed)

  if (previewFilters.scopeKind === 'family_expansion_from_stock_or_pending' && !hasSeed) {
    return { facet, filters: query, options: [] }
  }

  const values: unknown[] = []
  values.push(seedProductIds ?? [])
  const seedParam = `$${values.length}::int[]`
  values.push(previewFilters.brands)
  const brandsParam = `$${values.length}::text[]`
  values.push(previewFilters.categories)
  const categoriesParam = `$${values.length}::text[]`
  values.push(previewFilters.subcategories)
  const subcategoriesParam = `$${values.length}::text[]`
  values.push(previewFilters.search ?? null)
  const searchParam = `$${values.length}::text`
  values.push(mode)
  const modeParam = `$${values.length}::text`
  values.push(query.facetSearch ?? null)
  const facetSearchParam = `$${values.length}::text`
  values.push(query.limit)
  const limitParam = `$${values.length}::int`

  // Note: this CTE block mirrors buildResolvePricingRunScopeSql so the
  // facet counts agree with the matched-group counts in the preview.
  const sql = `
    with candidate_groups as (
      select
        cg.id,
        cg.group_name,
        cg.brand_name,
        cg.category_name,
        cg.subcategory_name,
        case
          when jsonb_typeof(cg.live_state_json -> 'products') = 'array' then cg.live_state_json -> 'products'
          else '[]'::jsonb
        end as products_json
      from catalog_groups cg
      where (cardinality(${brandsParam}) = 0 or cg.brand_name = any(${brandsParam}))
        and (cardinality(${categoriesParam}) = 0 or cg.category_name = any(${categoriesParam}))
        and (cardinality(${subcategoriesParam}) = 0 or cg.subcategory_name = any(${subcategoriesParam}))
        and (
          ${searchParam} is null
          or cg.group_name ilike '%' || ${searchParam} || '%'
          or coalesce(cg.brand_name, '') ilike '%' || ${searchParam} || '%'
          or exists (
            select 1 from jsonb_array_elements(
              case
                when jsonb_typeof(cg.live_state_json -> 'products') = 'array' then cg.live_state_json -> 'products'
                else '[]'::jsonb
              end
            ) as product
            where coalesce(product ->> 'name', '') ilike '%' || ${searchParam} || '%'
               or coalesce(product ->> 'shortName', '') ilike '%' || ${searchParam} || '%'
          )
        )
    ),
    catalog_products as (
      select
        cg.id as catalog_group_id,
        cg.${facetColumn} as facet_value,
        (product ->> 'productId')::int as product_id,
        nullif(trim(product ->> 'sizeName'), '') as size_name
      from candidate_groups cg
      cross join lateral jsonb_array_elements(cg.products_json) as product
      where (product ->> 'productId') ~ '^[0-9]+$'
    ),
    seed_family_sizes as (
      select distinct cp.catalog_group_id, cp.size_name
      from catalog_products cp
      where cp.product_id = any(${seedParam})
    ),
    family_expanded_products as (
      select cp.*
      from catalog_products cp
      inner join seed_family_sizes sfs
        on sfs.catalog_group_id = cp.catalog_group_id
       and sfs.size_name is not distinct from cp.size_name
    ),
    selected_products as (
      select * from catalog_products where ${modeParam} = 'all'
      union all
      select * from catalog_products where ${modeParam} = 'seed_only' and product_id = any(${seedParam})
      union all
      select * from family_expanded_products where ${modeParam} = 'family_expanded'
    )
    select
      sp.facet_value as value,
      count(distinct sp.catalog_group_id)::int as row_count
    from selected_products sp
    where sp.facet_value is not null
      and btrim(sp.facet_value) <> ''
      and (${facetSearchParam} is null or sp.facet_value ilike '%' || ${facetSearchParam} || '%')
    group by sp.facet_value
    order by row_count desc, value asc
    limit ${limitParam}
  `

  interface FacetRow extends QueryResultRow {
    row_count: number
    value: string
  }

  const result = await db.query<FacetRow>(sql, values)

  const selectedSet = new Set(
    facet === 'brand' ? query.brands : facet === 'category' ? query.categories : query.subcategories,
  )

  const facetOptions: PricingFacetOption[] = result.rows.map((row) => ({
    rowCount: row.row_count,
    selected: selectedSet.has(row.value),
    value: row.value,
  }))

  // Append any selected values that fell out of the candidate set so the
  // reviewer can always see (and uncheck) what they've already picked.
  for (const selected of selectedSet) {
    if (!facetOptions.some((option) => option.value === selected)) {
      facetOptions.push({ rowCount: 0, selected: true, value: selected })
    }
  }

  return { facet, filters: query, options: facetOptions }
}

export async function listPricingRuns(
  db: Queryable,
  filters: PricingRunListQuery,
): Promise<PricingRunListResponse> {
  const { values, whereSql } = buildPricingRunWhere(filters)
  const pageOffset = (filters.page - 1) * filters.pageSize

  const [itemsResult, countResult] = await Promise.all([
    db.query<PricingRunRow>(
      `
        select
          pb.id,
          pb.source,
          pb.trigger_mode,
          pb.status,
          pb.summary_json,
          pb.config_json,
          pb.created_at,
          pb.job_id,
          jq.status as job_status,
          creator.name as created_by_user,
          coalesce(batch_counts.row_count, 0)::int as row_count,
          coalesce(batch_counts.line_item_count, 0)::int as line_item_count
        from proposal_batches pb
        left join users creator on creator.id = pb.created_by_user_id
        left join job_queue jq on jq.id = pb.job_id
        left join (
          select
            pr.proposal_batch_id,
            count(distinct pr.id)::int as row_count,
            count(pli.id)::int as line_item_count
          from proposal_rows pr
          left join proposal_line_items pli on pli.proposal_row_id = pr.id
          group by pr.proposal_batch_id
        ) batch_counts on batch_counts.proposal_batch_id = pb.id
        ${whereSql}
        order by pb.created_at desc, pb.id desc
        limit $${values.length + 1}
        offset $${values.length + 2}
      `,
      [...values, filters.pageSize, pageOffset],
    ),
    db.query<{ total_count: number }>(
      `
        select count(*)::int as total_count
        from proposal_batches pb
        left join users creator on creator.id = pb.created_by_user_id
        ${whereSql}
      `,
      values,
    ),
  ])

  return {
    filters,
    items: itemsResult.rows.map(mapPricingRunListItem),
    totalCount: countResult.rows[0]?.total_count ?? 0,
  }
}

export async function getPricingRunDetail(
  db: Queryable,
  proposalBatchId: PricingRunRouteParams['proposalBatchId'],
): Promise<PricingRunDetailResponse | null> {
  const runResult = await db.query<PricingRunRow>(
    `
      select
        pb.id,
        pb.source,
        pb.trigger_mode,
        pb.status,
        pb.summary_json,
        pb.config_json,
        pb.created_at,
        pb.job_id,
        jq.status as job_status,
        creator.name as created_by_user,
        coalesce(batch_counts.row_count, 0)::int as row_count,
        coalesce(batch_counts.line_item_count, 0)::int as line_item_count
      from proposal_batches pb
      left join users creator on creator.id = pb.created_by_user_id
      left join job_queue jq on jq.id = pb.job_id
      left join (
        select
          pr.proposal_batch_id,
          count(distinct pr.id)::int as row_count,
          count(pli.id)::int as line_item_count
        from proposal_rows pr
        left join proposal_line_items pli on pli.proposal_row_id = pr.id
        group by pr.proposal_batch_id
      ) batch_counts on batch_counts.proposal_batch_id = pb.id
      where pb.id = $1
        and pb.type = 'pricing'
      limit 1
    `,
    [proposalBatchId],
  )

  const runRow = runResult.rows[0]
  if (!runRow) {
    return null
  }

  const groupResult = await db.query<PricingRunGroupRow>(
    `
      select
        pr.id as proposal_row_id,
        pr.catalog_group_id,
        pr.row_title,
        pr.evidence_json,
        cg.group_name,
        cg.brand_name,
        cg.category_name,
        cg.subcategory_name,
        count(pli.id) filter (where pli.approval_status = 'pending')::int as pending_line_item_count,
        count(pli.id) filter (where pli.approval_status = 'approved')::int as approved_line_item_count,
        count(pli.id) filter (where pli.approval_status = 'rejected')::int as rejected_line_item_count,
        count(pli.id)::int as line_item_count
      from proposal_rows pr
      inner join catalog_groups cg on cg.id = pr.catalog_group_id
      left join proposal_line_items pli on pli.proposal_row_id = pr.id
      where pr.proposal_batch_id = $1
      group by pr.id, cg.id
      order by count(pli.id) desc, cg.group_name asc, pr.id asc
    `,
    [proposalBatchId],
  )

  const reviewItemResult = await db.query<PricingReviewRow>(
    `
      select
        pli.id,
        pli.proposal_row_id,
        pli.catalog_group_id,
        pli.target_entity_type,
        pli.target_entity_id,
        pli.field_path,
        pli.baseline_value_json,
        pli.suggested_value_json,
        pli.edited_value_json,
        pli.effective_value_json,
        pli.approval_status,
        pli.version,
        pli.notes,
        pli.validation_issues_json,
        pli.approval_updated_at,
        pr.evidence_json,
        pb.id as batch_id,
        pb.created_at as batch_created_at,
        pb.status as batch_status,
        pb.config_json,
        cg.group_name,
        cg.brand_name,
        cg.category_name,
        cg.subcategory_name,
        cg.live_state_json,
        cg.reconcile_status,
        cg.live_state_hash,
        approver.name as approved_by_user,
        pr.baseline_snapshot_id
      from proposal_line_items pli
      inner join proposal_rows pr on pr.id = pli.proposal_row_id
      inner join proposal_batches pb on pb.id = pr.proposal_batch_id
      inner join catalog_groups cg on cg.id = pli.catalog_group_id
      left join users approver on approver.id = pli.approved_by_user_id
      where pb.id = $1
        and pb.type = 'pricing'
      order by cg.brand_name asc nulls last, cg.group_name asc, (case when pli.approval_status = 'pending' then 0 else 1 end), pli.id asc
    `,
    [proposalBatchId],
  )
  const recentSalesResult = await loadPricingRecentSales(reviewItemResult.rows)
  const reviewItemsByProposalRowId = new Map<number, PricingReviewItem[]>()
  for (const row of reviewItemResult.rows) {
    const reviewItems = reviewItemsByProposalRowId.get(row.proposal_row_id)
    const mappedItem = mapPricingReviewItem(row, recentSalesResult.byGroupId, recentSalesResult.fallbackByGroupId)
    if (reviewItems) {
      reviewItems.push(mappedItem)
    } else {
      reviewItemsByProposalRowId.set(row.proposal_row_id, [mappedItem])
    }
  }

  let generatedProductCount = 0
  let skippedProductCount = 0
  let pendingLineItemCount = 0
  let approvedLineItemCount = 0
  let rejectedLineItemCount = 0

  const groups = groupResult.rows.map((row) => {
    const evidence = readObject(row.evidence_json)
    const generatedProducts = readGeneratedProducts(evidence)
    const skippedProducts = readSkippedProducts(evidence)

    generatedProductCount += generatedProducts.length
    skippedProductCount += skippedProducts.length
    pendingLineItemCount += row.pending_line_item_count
    approvedLineItemCount += row.approved_line_item_count
    rejectedLineItemCount += row.rejected_line_item_count

    return {
      approvalCounts: {
        approved: row.approved_line_item_count,
        pending: row.pending_line_item_count,
        rejected: row.rejected_line_item_count,
      },
      brandName: row.brand_name,
      catalogGroupId: row.catalog_group_id,
      categoryName: row.category_name,
      generatedProducts,
      groupName: row.group_name,
      lineItemCount: row.line_item_count,
      marketAvailability: readString(readObject(evidence.marketContext)?.availability),
      marketNote: readString(readObject(evidence.marketContext)?.note),
      proposalRowId: row.proposal_row_id,
      reviewItems: reviewItemsByProposalRowId.get(row.proposal_row_id) ?? [],
      rowTitle: row.row_title,
      skippedProducts,
      subcategoryName: row.subcategory_name,
    }
  })

  const run = mapPricingRunListItem(runRow)
  const config = readObject(runRow.config_json)

  return {
    groups,
    recentSalesIssue: recentSalesResult.issue,
    run: {
      ...run,
      rawSummary: runRow.summary_json,
      selectionFilters: readSelectionFilters(config.selectionFilters),
    },
    totals: {
      approvedLineItemCount,
      generatedProductCount,
      groupCount: groups.length,
      pendingLineItemCount,
      rejectedLineItemCount,
      skippedProductCount,
    },
  }
}

export async function listPricingReviewItems(
  db: Queryable,
  filters: PricingReviewQuery,
): Promise<PricingReviewResponse> {
  const effectiveFilters = {
    ...filters,
    showSuperseded: filters.showSuperseded || filters.batchId !== undefined,
  }
  const { values, whereSql } = buildPricingReviewWhere(effectiveFilters)
  const pageOffset = (filters.page - 1) * filters.pageSize

  const [itemsResult, countResult] = await Promise.all([
    db.query<PricingReviewRow>(
      `
        select
          pli.id,
          pli.proposal_row_id,
          pli.catalog_group_id,
          pli.target_entity_type,
          pli.target_entity_id,
          pli.field_path,
          pli.baseline_value_json,
          pli.suggested_value_json,
          pli.edited_value_json,
          pli.effective_value_json,
          pli.approval_status,
          pli.version,
          pli.notes,
          pli.validation_issues_json,
          pli.approval_updated_at,
          pr.evidence_json,
          pb.id as batch_id,
          pb.created_at as batch_created_at,
          pb.status as batch_status,
          pb.config_json,
          cg.group_name,
          cg.brand_name,
          cg.category_name,
          cg.subcategory_name,
          cg.live_state_json,
          cg.reconcile_status,
          cg.live_state_hash,
          approver.name as approved_by_user,
          pr.baseline_snapshot_id
        from proposal_line_items pli
        inner join proposal_rows pr on pr.id = pli.proposal_row_id
        inner join proposal_batches pb on pb.id = pr.proposal_batch_id
        inner join catalog_groups cg on cg.id = pli.catalog_group_id
        left join users approver on approver.id = pli.approved_by_user_id
        ${whereSql}
        order by pb.created_at desc, (case when pli.approval_status = 'pending' then 0 else 1 end), pli.id desc
        limit $${values.length + 1}
        offset $${values.length + 2}
      `,
      [...values, filters.pageSize, pageOffset],
    ),
    db.query<{ total_count: number }>(
      `
        select count(*)::int as total_count
        from proposal_line_items pli
        inner join proposal_rows pr on pr.id = pli.proposal_row_id
        inner join proposal_batches pb on pb.id = pr.proposal_batch_id
        inner join catalog_groups cg on cg.id = pli.catalog_group_id
        ${whereSql}
      `,
      values,
    ),
  ])

  const recentSalesResult = await loadPricingRecentSales(itemsResult.rows)

  return {
    filters: effectiveFilters,
    items: itemsResult.rows.map((row) => mapPricingReviewItem(row, recentSalesResult.byGroupId, recentSalesResult.fallbackByGroupId)),
    recentSalesIssue: recentSalesResult.issue,
    totalCount: countResult.rows[0]?.total_count ?? 0,
  }
}

function buildPricingRunWhere(filters: PricingRunListQuery): { values: unknown[]; whereSql: string } {
  const clauses: string[] = [`pb.type = 'pricing'`]
  const values: unknown[] = []

  if (filters.status) {
    values.push(filters.status)
    clauses.push(`pb.status = $${values.length}`)
  }
  if (filters.search) {
    values.push(`%${filters.search}%`)
    clauses.push(
      `(
        coalesce(pb.config_json ->> 'scopeLabel', '') ilike $${values.length}
        or coalesce(creator.name, '') ilike $${values.length}
        or cast(pb.id as text) ilike $${values.length}
      )`,
    )
  }

  return {
    values,
    whereSql: `where ${clauses.join(' and ')}`,
  }
}

function buildPricingReviewWhere(filters: PricingReviewQuery): { values: unknown[]; whereSql: string } {
  const clauses: string[] = [`pb.type = 'pricing'`]
  const values: unknown[] = []

  if (filters.batchId) {
    values.push(filters.batchId)
    clauses.push(`pb.id = $${values.length}`)
  } else {
    clauses.push(`pb.status = 'ready'`)
  }

  if (filters.approvalStatus) {
    values.push(filters.approvalStatus)
    clauses.push(`pli.approval_status = $${values.length}`)
  }

  if (!filters.showSuperseded) {
    clauses.push(`pli.approval_status <> 'superseded'`)
  }

  if (filters.search) {
    values.push(`%${filters.search}%`)
    clauses.push(`(cg.group_name ilike $${values.length} or coalesce(cg.brand_name, '') ilike $${values.length})`)
  }

  return {
    values,
    whereSql: `where ${clauses.join(' and ')}`,
  }
}

function mapPricingRunListItem(row: PricingRunRow): PricingRunListItem {
  const config = readObject(row.config_json)
  const summary = readObject(row.summary_json)
  const catalogGroupIds = readNumberArray(config.catalogGroupIds)
  const scopeKind = readScopeKind(config.scopeKind) ?? (catalogGroupIds.length > 0 ? 'explicit_selection' : 'filtered_catalog')
  const requestedGroupCount = readInteger(summary.requestedGroupCount)
    ?? readInteger(config.resolvedCatalogGroupCount)
    ?? catalogGroupIds.length

  return {
    batchId: row.id,
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    createdByUser: row.created_by_user,
    forceLiveRefresh: readBoolean(config.forceLiveRefresh),
    generatedGroupCount: readInteger(summary.generatedGroupCount) ?? row.row_count,
    generatedLineItemCount: readInteger(summary.generatedLineItemCount) ?? row.line_item_count,
    jobId: row.job_id,
    jobStatus: row.job_status ?? null,
    requestedGroupCount,
    resolvedProductCount: readInteger(config.resolvedProductCount),
    rowCount: row.row_count,
    scopeKind,
    scopeLabel: readString(config.scopeLabel) ?? deriveScopeLabel(scopeKind, config),
    skippedProductCount: readInteger(summary.skippedProductCount),
    source: row.source,
    status: row.status,
    summaryText: buildPricingRunSummaryText({
      createdByUser: row.created_by_user,
      generatedLineItemCount: readInteger(summary.generatedLineItemCount) ?? row.line_item_count,
      requestedGroupCount,
      scopeKind,
      scopeLabel: readString(config.scopeLabel) ?? deriveScopeLabel(scopeKind, config),
      skippedProductCount: readInteger(summary.skippedProductCount),
      status: row.status,
    }),
    triggerMode: row.trigger_mode,
    triggerSource: readTriggerSource(config.triggerSource) ?? (row.trigger_mode === 'scheduled' ? 'scheduled' : 'manual'),
  }
}

function mapPricingReviewItem(
  row: PricingReviewRow,
  recentSalesByGroupId: Map<number, GroupRecentSales>,
  fallbackByGroupId: Map<number, GroupRecentSales>,
): PricingReviewItem {
  const generatedProduct = findGeneratedProduct(row.evidence_json, row.target_entity_id)
  const config = readObject(row.config_json)
  const groupRecentSales = recentSalesByGroupId.get(row.catalog_group_id)
    ?? fallbackByGroupId.get(row.catalog_group_id)
    ?? buildEmptyGroupRecentSales(row.live_state_json)

  return {
    batchCreatedAt: toIsoString(row.batch_created_at) ?? new Date(0).toISOString(),
    batchId: row.batch_id,
    batchStatus: row.batch_status,
    lineItem: mapProposalLineItem(row),
    pricingContext: {
      action: generatedProduct?.action ?? null,
      currentGmPercent: generatedProduct?.currentGmPercent ?? null,
      marketAverageLabel: buildMarketAverageLabel(generatedProduct?.marketEvidence ?? null),
      marketAveragePostTaxPrice: generatedProduct?.marketEvidence?.averagePostTaxPrice ?? null,
      marketAveragePreTaxPrice: generatedProduct?.marketEvidence?.averagePreTaxPrice ?? null,
      marketFarAveragePostTaxPrice: generatedProduct?.marketEvidence?.farAveragePostTaxPrice ?? null,
      marketFarAveragePreTaxPrice: generatedProduct?.marketEvidence?.farAveragePreTaxPrice ?? null,
      marketFarListingCount: generatedProduct?.marketEvidence?.farListingCount ?? null,
      marketDispensaryCount: generatedProduct?.marketEvidence?.dispensaryCount ?? null,
      marketEligibleListingCount: generatedProduct?.marketEvidence?.pricingEligibleListingCount ?? null,
      marketListingCount: generatedProduct?.marketEvidence?.listingCount ?? null,
      marketListings: generatedProduct?.marketEvidence?.matchedListings ?? [],
      marketMedianPostTaxPrice: generatedProduct?.marketEvidence?.medianPostTaxPrice ?? null,
      marketMedianPreTaxPrice: generatedProduct?.marketEvidence?.medianPreTaxPrice ?? null,
      marketSource: generatedProduct?.marketEvidence?.source ?? null,
      priceReason: generatedProduct?.priceReason ?? null,
      productName: generatedProduct?.productName ?? null,
      proposedGmPercent: generatedProduct?.proposedGmPercent ?? null,
      proposedPrice: generatedProduct?.proposedPrice ?? readNullableNumber(row.effective_value_json),
      recentSales: buildProductRecentSales(groupRecentSales, row.target_entity_id),
      scopeLabel: readString(config.scopeLabel) ?? deriveScopeLabel(readScopeKind(config.scopeKind) ?? 'explicit_selection', config),
      tab: generatedProduct?.tab ?? null,
      wholesaleCost: generatedProduct?.wholesaleCost ?? null,
    },
  }
}

async function loadPricingRecentSales(rows: PricingReviewRow[]): Promise<{
  byGroupId: Map<number, GroupRecentSales>
  fallbackByGroupId: Map<number, GroupRecentSales>
  issue: string | null
}> {
  const uniqueGroups = new Map<number, JsonValue>()
  for (const row of rows) {
    if (!uniqueGroups.has(row.catalog_group_id)) {
      uniqueGroups.set(row.catalog_group_id, row.live_state_json)
    }
  }

  const fallbackByGroupId = new Map<number, GroupRecentSales>(
    [...uniqueGroups.entries()].map(([catalogGroupId, liveState]) => [catalogGroupId, buildEmptyGroupRecentSales(liveState)]),
  )

  if (uniqueGroups.size === 0) {
    return {
      byGroupId: new Map(),
      fallbackByGroupId,
      issue: null,
    }
  }

  try {
    const byGroupId = await loadRecentSalesForGroups(
      [...uniqueGroups.entries()].map(([catalogGroupId, liveState]) => ({ catalogGroupId, liveState })),
    )
    return {
      byGroupId,
      fallbackByGroupId,
      issue: null,
    }
  } catch (error) {
    return {
      byGroupId: new Map(),
      fallbackByGroupId,
      issue:
        error instanceof Error ? `Recent sales velocity is unavailable right now: ${error.message}` : 'Recent sales velocity is unavailable right now.',
    }
  }
}

function buildProductRecentSales(
  groupRecentSales: GroupRecentSales,
  productId: number,
): { sites: GroupRecentSalesProductRow[]; summary: RecentSalesSummary } {
  const sites = groupRecentSales.productRows.filter((row) => row.productId === productId)
  const coveredSites = sites.filter((row) => row.hasCoverage)
  const unitsPerDay = sumNullableNumbers(coveredSites.map((row) => row.unitsPerDay))

  return {
    sites,
    summary: {
      combinationCount: sites.length,
      coverageCount: coveredSites.length,
      daysPerUnit: unitsPerDay !== null && unitsPerDay > 0 ? roundRecentSalesNumber(1 / unitsPerDay) : null,
      last30DaysGrossSales: sumNullableNumbers(coveredSites.map((row) => row.last30DaysGrossSales)),
      onHand: sumNullableNumbers(coveredSites.map((row) => row.onHand)),
      reportDate: latestRecentSalesDate(coveredSites.map((row) => row.reportDate)),
      unitsPerDay,
    },
  }
}

function sumNullableNumbers(values: Array<number | null>): number | null {
  const presentValues = values.filter((value): value is number => value !== null)
  if (presentValues.length === 0) {
    return null
  }

  return roundRecentSalesNumber(presentValues.reduce((sum, value) => sum + value, 0))
}

function latestRecentSalesDate(values: Array<string | null>): string | null {
  let latestValue: string | null = null
  let latestTimestamp = Number.NEGATIVE_INFINITY

  for (const value of values) {
    if (!value) {
      continue
    }
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp) || timestamp <= latestTimestamp) {
      continue
    }
    latestValue = value
    latestTimestamp = timestamp
  }

  return latestValue
}

function roundRecentSalesNumber(value: number): number {
  return Math.round(value * 100) / 100
}

function mapProposalLineItem(row: PricingReviewRow): ProposalLineItem {
  const baselinePreview = buildTextPreview(row.baseline_value_json)
  const suggestedPreview = buildTextPreview(row.suggested_value_json)
  const editedPreview = buildTextPreview(row.edited_value_json ?? row.suggested_value_json)
  const effectivePreview = buildTextPreview(row.effective_value_json)

  return {
    activeDesiredStateRevisionId: null,
    approvalStatus: row.approval_status,
    approvalUpdatedAt: toIsoString(row.approval_updated_at),
    approvedByUser: row.approved_by_user,
    baselineSnapshotId: row.baseline_snapshot_id,
    baselineValue: row.baseline_value_json,
    catalogGroupId: row.catalog_group_id,
    effectiveValue: row.effective_value_json,
    editedValue: row.edited_value_json,
    fieldPath: row.field_path,
    groupSummary: {
      brandName: row.brand_name,
      categoryName: row.category_name,
      groupName: row.group_name,
      liveStateHash: row.live_state_hash,
      reconcileStatus: row.reconcile_status,
      subcategoryName: row.subcategory_name,
    },
    lineItemId: row.id,
    notes: row.notes,
    rowId: row.proposal_row_id,
    suggestedValue: row.suggested_value_json,
    targetEntityId: row.target_entity_id,
    targetEntityType: row.target_entity_type,
    validationIssues: row.validation_issues_json,
    valuePreview: {
      baselineText: baselinePreview.text,
      editedText: editedPreview.text,
      effectiveText: effectivePreview.text,
      isTruncated:
        baselinePreview.isTruncated ||
        suggestedPreview.isTruncated ||
        editedPreview.isTruncated ||
        effectivePreview.isTruncated,
      suggestedText: suggestedPreview.text,
    },
    version: row.version,
  }
}

function readObject(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return {}
  }

  return value as Record<string, JsonValue>
}

function readArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function readString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function readBoolean(value: JsonValue | undefined): boolean {
  return value === true
}

function readInteger(value: JsonValue | undefined): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null
  }

  return value
}

function readNullableNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readNumberArray(value: JsonValue | undefined): number[] {
  return readArray(value)
    .filter((candidate): candidate is number => typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0)
}

function readStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const trimmed = item.trim()
      if (trimmed.length > 0) {
        out.push(trimmed)
      }
    }
  }
  return [...new Set(out)]
}

function readSiteKeys(value: JsonValue | undefined): PricingSiteKey[] {
  const candidates = readStringArray(value)
  return candidates.filter((candidate): candidate is PricingSiteKey =>
    candidate === 'bronx' || candidate === 'midtown',
  )
}

function readSelectionFilters(value: JsonValue | undefined): PricingRunDetailResponse['run']['selectionFilters'] {
  const objectValue = readObject(value)
  if (Object.keys(objectValue).length === 0) {
    return null
  }

  // Migrate old single-value fields (`brand`, `category`, `subcategory`,
  // `liveBronxInventory`, `liveMidtownInventory`, `midtownEverReceived`)
  // into the new array/site shape so historical run detail pages keep
  // rendering useful labels.
  const legacyBrand = readString(objectValue.brand)
  const legacyCategory = readString(objectValue.category)
  const legacySubcategory = readString(objectValue.subcategory)
  const brands = readStringArray(objectValue.brands)
  const categories = readStringArray(objectValue.categories)
  const subcategories = readStringArray(objectValue.subcategories)
  if (legacyBrand && !brands.includes(legacyBrand)) brands.push(legacyBrand)
  if (legacyCategory && !categories.includes(legacyCategory)) categories.push(legacyCategory)
  if (legacySubcategory && !subcategories.includes(legacySubcategory)) subcategories.push(legacySubcategory)

  const sites = readSiteKeys(objectValue.sites)
  if (sites.length === 0) {
    if (objectValue.liveBronxInventory === true) sites.push('bronx')
    if (objectValue.liveMidtownInventory === true) sites.push('midtown')
  }
  const stockOnly = objectValue.stockOnly === true
    || objectValue.liveBronxInventory === true
    || objectValue.liveMidtownInventory === true
    || objectValue.inStockOnly === true
  const includePending = objectValue.includePending === true
  const strict = objectValue.strict === true

  return {
    brands,
    categories,
    includePending,
    search: readString(objectValue.search) ?? undefined,
    sites,
    stockOnly,
    strict,
    subcategories,
  }
}

function readScopeKind(value: JsonValue | undefined): PricingRunScopeKind | null {
  switch (value) {
    case 'explicit_selection':
    case 'family_expansion_from_stock_or_pending':
    case 'filtered_catalog':
    case 'full_catalog':
    case 'saved_profile':
    case 'single_product':
      return value
    default:
      return null
  }
}

function readTriggerSource(value: JsonValue | undefined): PricingRunTriggerSource | null {
  switch (value) {
    case 'manual':
    case 'rerun':
    case 'scheduled':
      return value
    default:
      return null
  }
}

function deriveScopeLabel(scopeKind: PricingRunScopeKind, config: Record<string, JsonValue>): string {
  const selectionFilters = readSelectionFilters(config.selectionFilters)
  if (scopeKind === 'full_catalog') {
    const liveInventoryScopeLabel = buildProductScopeLabels(selectionFilters).join(' · ')
    return liveInventoryScopeLabel ? `${liveInventoryScopeLabel} catalog` : 'Full catalog'
  }
  if (scopeKind === 'explicit_selection') {
    return 'Explicit selection'
  }
  if (scopeKind === 'single_product') {
    return 'Single product'
  }
  if (selectionFilters) {
    const parts: string[] = []
    if (selectionFilters.brands.length > 0) parts.push(selectionFilters.brands.join(', '))
    if (selectionFilters.categories.length > 0) parts.push(selectionFilters.categories.join(', '))
    if (selectionFilters.subcategories.length > 0) parts.push(selectionFilters.subcategories.join(', '))
    if (selectionFilters.search) parts.push(selectionFilters.search)
    const productScopeLabels = buildProductScopeLabels(selectionFilters)
    if (productScopeLabels.length > 0) {
      parts.push(...productScopeLabels)
    }
    if (scopeKind === 'family_expansion_from_stock_or_pending') {
      parts.unshift(selectionFilters.strict ? 'Stock+pending (strict)' : 'Family expansion')
    }
    if (parts.length > 0) {
      return parts.join(' · ')
    }
  }

  if (scopeKind === 'family_expansion_from_stock_or_pending') {
    return 'Family expansion'
  }
  return 'Filtered catalog'
}

function buildProductScopeLabels(selectionFilters: PricingRunDetailResponse['run']['selectionFilters']): string[] {
  if (!selectionFilters) {
    return []
  }
  const labels: string[] = []
  const siteLabels = selectionFilters.sites
    .map((siteKey) => (siteKey === 'bronx' ? 'Bronx' : 'Midtown'))
  const siteSummary = siteLabels.length > 0 ? siteLabels.join('+') : null

  if (selectionFilters.stockOnly) {
    labels.push(siteSummary ? `${siteSummary} in stock` : 'In stock')
  }
  if (selectionFilters.includePending) {
    labels.push(siteSummary ? `${siteSummary} pending purchases` : 'Pending purchases')
  }
  return labels
}

function buildPricingRunSummaryText(input: {
  createdByUser: string | null
  generatedLineItemCount: number | null
  requestedGroupCount: number | null
  scopeKind: PricingRunScopeKind
  scopeLabel: string
  skippedProductCount: number | null
  status: PricingRunListItem['status']
}): string {
  const pieces = [input.scopeLabel]
  if (input.requestedGroupCount !== null) {
    pieces.push(`${input.requestedGroupCount} groups`)
  }
  if (input.generatedLineItemCount !== null) {
    pieces.push(`${input.generatedLineItemCount} review rows`)
  }
  if (input.skippedProductCount !== null) {
    pieces.push(`${input.skippedProductCount} skipped`)
  }
  if (input.createdByUser) {
    pieces.push(`by ${input.createdByUser}`)
  }
  pieces.push(input.status)
  return pieces.join(' · ')
}

function readGeneratedProducts(evidence: Record<string, JsonValue>): PricingRunGeneratedProduct[] {
  return readArray(evidence.generatedProducts).flatMap((candidate) => {
    const objectValue = readObject(candidate)
    const productId = readPositiveInteger(objectValue.productId)
    const productName = readString(objectValue.productName)
    const proposedPrice = readNullableNumber(objectValue.proposedPrice)
    const tab = readString(objectValue.tab)
    const wholesaleCost = readNullableNumber(objectValue.wholesaleCost)
    const action = readGeneratedAction(objectValue.action)

    if (productId === null || productName === null || proposedPrice === null || tab === null || wholesaleCost === null || action === null) {
      return []
    }

    return [{
      action,
      currentGmPercent: readNullableNumber(objectValue.currentGmPercent),
      currentPrice: readNullableNumber(objectValue.currentPrice),
      marketEvidence: readMarketEvidence(objectValue.marketEvidence),
      priceReason: readString(objectValue.priceReason) ?? 'No pricing reason recorded.',
      productId,
      productName,
      proposedGmPercent: readNullableNumber(objectValue.proposedGmPercent),
      proposedPrice,
      tab,
      validationIssues: readValidationIssues(objectValue.validationIssues),
      wholesaleCost,
    }]
  })
}

function readSkippedProducts(evidence: Record<string, JsonValue>): PricingRunSkippedProduct[] {
  return readArray(evidence.skippedProducts).flatMap((candidate) => {
    const objectValue = readObject(candidate)
    const productId = readPositiveInteger(objectValue.productId)
    const productName = readString(objectValue.productName)
    const reason = readString(objectValue.reason)
    const tab = readString(objectValue.tab)

    if (productId === null || productName === null || reason === null || tab === null) {
      return []
    }

    return [{
      currentPrice: readNullableNumber(objectValue.currentPrice),
      marketEvidence: readMarketEvidence(objectValue.marketEvidence),
      productId,
      productName,
      reason,
      tab,
      wholesaleCost: readNullableNumber(objectValue.wholesaleCost),
    }]
  })
}

function findGeneratedProduct(evidenceJson: JsonValue, productId: number): PricingRunGeneratedProduct | null {
  const evidence = readObject(evidenceJson)
  return readGeneratedProducts(evidence).find((candidate) => candidate.productId === productId) ?? null
}

function readGeneratedAction(value: JsonValue | undefined): PricingRunGeneratedProduct['action'] | null {
  switch (value) {
    case 'keep-price':
    case 'lower-price':
    case 'raise-price':
    case 'set-price':
      return value
    default:
      return null
  }
}

function readPositiveInteger(value: JsonValue | undefined): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return null
  }

  return value
}

function readValidationIssues(value: JsonValue | undefined): PricingRunGeneratedProduct['validationIssues'] {
  return readArray(value).flatMap((candidate) => {
    const objectValue = readObject(candidate)
    const code = readString(objectValue.code)
    const detail = readString(objectValue.detail)
    const severity = objectValue.severity === 'error' ? 'error' : objectValue.severity === 'warning' ? 'warning' : null
    if (code === null || detail === null || severity === null) {
      return []
    }

    return [{ code, detail, severity }]
  })
}

function readMarketEvidence(value: JsonValue | undefined): PricingRunGeneratedProduct['marketEvidence'] {
  const objectValue = readObject(value)
  const averagePostTaxPrice = readNullableNumber(objectValue.averagePostTaxPrice)
  const averagePreTaxPrice = readNullableNumber(objectValue.averagePreTaxPrice)
  const dispensaryCount = readInteger(objectValue.dispensaryCount)
  const farAveragePostTaxPrice = readNullableNumber(objectValue.farAveragePostTaxPrice)
  const farAveragePreTaxPrice = readNullableNumber(objectValue.farAveragePreTaxPrice)
  const farListingCount = readInteger(objectValue.farListingCount) ?? 0
  const listingCount = readInteger(objectValue.listingCount)
  const medianPostTaxPrice = readNullableNumber(objectValue.medianPostTaxPrice)
  const medianPreTaxPrice = readNullableNumber(objectValue.medianPreTaxPrice)
  const pricingEligibleDispensaryCount = readInteger(objectValue.pricingEligibleDispensaryCount)
  const pricingEligibleListingCount = readInteger(objectValue.pricingEligibleListingCount)
  const searchTerm = readString(objectValue.searchTerm)
  const source = objectValue.source === 'nearby' || objectValue.source === 'statewide' || objectValue.source === 'mixed'
    ? objectValue.source
    : null

  if (
    dispensaryCount === null
    || listingCount === null
    || pricingEligibleDispensaryCount === null
    || pricingEligibleListingCount === null
    || searchTerm === null
  ) {
    return null
  }

  return {
    averagePostTaxPrice,
    averagePreTaxPrice,
    dispensaryCount,
    farAveragePostTaxPrice,
    farAveragePreTaxPrice,
    farListingCount,
    listingCount,
    medianPostTaxPrice,
    medianPreTaxPrice,
    pricingEligibleDispensaryCount,
    pricingEligibleListingCount,
    matchedListings: readMatchedListings(objectValue.matchedListings),
    searchTerm,
    source,
  }
}

function readMatchedListings(value: JsonValue | undefined): PricingRunMarketListing[] {
  return readArray(value).flatMap((candidate) => {
    const objectValue = readObject(candidate)
    const distanceBand = readDistanceBand(objectValue.distanceBand)
    const distanceMiles = readNullableNumber(objectValue.distanceMiles)
    const dispensaryName = readString(objectValue.dispensaryName)
    const eligibleForPricing = readBoolean(objectValue.eligibleForPricing)
    const exclusionReason = readString(objectValue.exclusionReason)
    const listingName = readString(objectValue.listingName)
    const matchTier = readMatchTier(objectValue.matchTier)
    const postTaxPrice = readNullableNumber(objectValue.postTaxPrice)
    const preTaxPrice = readNullableNumber(objectValue.preTaxPrice)
    const source = objectValue.source === 'nearby' || objectValue.source === 'statewide' ? objectValue.source : null

    if (distanceBand === null || dispensaryName === null || listingName === null || matchTier === null || postTaxPrice === null || preTaxPrice === null || source === null) {
      return []
    }

    return [{
      category: readString(objectValue.category),
      distanceBand,
      distanceMiles,
      dispensaryName,
      eligibleForPricing,
      exclusionReason,
      imageUrl: readString(objectValue.imageUrl),
      listingName,
      matchTier,
      postTaxPrice,
      preTaxPrice,
      source,
      url: readString(objectValue.url),
    }]
  })
}

function buildMarketAverageLabel(evidence: PricingRunGeneratedProduct['marketEvidence']): string | null {
  if (!evidence) {
    return null
  }
  if (evidence.pricingEligibleListingCount > 0) {
    const thinCompNote = evidence.pricingEligibleListingCount < 3 ? ' (thin comps)' : ''
    const medianNote = evidence.medianPostTaxPrice === null ? '' : ` · median ${formatMoneyCompact(evidence.medianPostTaxPrice)}`
    return `Near/mid weighted from ${evidence.pricingEligibleListingCount} listing${evidence.pricingEligibleListingCount === 1 ? '' : 's'}${thinCompNote}${medianNote}`
  }
  if (evidence.farListingCount > 0 && evidence.farAveragePostTaxPrice !== null) {
    return `Far-only market pressure from ${evidence.farListingCount} listing${evidence.farListingCount === 1 ? '' : 's'} · avg ${formatMoneyCompact(evidence.farAveragePostTaxPrice)}`
  }
  if (evidence.listingCount > 0) {
    return 'Far/very-far display only'
  }
  return null
}

function formatMoneyCompact(value: number): string {
  return `$${value.toFixed(2)}`
}

function readDistanceBand(value: JsonValue | undefined): PricingRunMarketListing['distanceBand'] | null {
  switch (value) {
    case 'near':
    case 'mid':
    case 'far':
    case 'very_far':
    case 'unknown':
      return value
    default:
      return null
  }
}

function readMatchTier(value: JsonValue | undefined): PricingRunMarketListing['matchTier'] | null {
  switch (value) {
    case 'exact':
    case 'fallback':
    case 'weak':
      return value
    default:
      return null
  }
}
