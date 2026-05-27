import type { QueryResultRow } from 'pg'

import type {
  CatalogBrowserQuery,
  CatalogBrowserResponse,
  GroupDetailResponse,
  GroupProductMarketEvidence,
  JsonValue,
  PendingPurchaseMarketListing,
  ProposalLineItem,
} from '../../../shared/contracts/index.js'
import { PendingPurchaseMarketListingSchema } from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'
import { buildEmptyGroupRecentSales, loadRecentSalesForGroups } from '../../catalog/liveRecentSales.js'
import { buildTextPreview, jsonValueToPreview, toIsoString } from './helpers.js'
import {
  loadEffectiveMarketListingsForGroup,
  type EffectiveMarketListing,
} from './catalogMarketMatchQueries.js'

interface CatalogBrowserRow extends QueryResultRow {
  active_desired_field_count: number
  approved_line_item_count: number
  brand_name: string | null
  category_name: string | null
  catalog_group_id: number
  drifted_at: Date | null
  group_name: string
  last_synced_at: Date
  live_state_json: JsonValue
  pending_line_item_count: number
  product_tabs_json: string[]
  reconcile_status: string
  subcategory_name: string | null
  sweed_group_id: number
}

interface GroupRow extends QueryResultRow {
  brand_name: string | null
  category_name: string | null
  drifted_at: Date | null
  group_name: string
  id: number
  last_synced_at: Date
  live_state_json: JsonValue
  reconcile_status: string
  strain_name: string | null
  subcategory_name: string | null
  sweed_group_id: number
}

interface SnapshotRow extends QueryResultRow {
  created_at: Date
  id: number
  source: string
  state_json: JsonValue
}

interface LineItemRow extends QueryResultRow {
  active_desired_state_revision_id: number | null
  approval_status: string
  approval_updated_at: Date | null
  approved_by_user: string | null
  baseline_snapshot_id: number | null
  baseline_value_json: JsonValue
  catalog_group_id: number
  effective_value_json: JsonValue
  edited_value_json: JsonValue | null
  field_path: string
  group_name: string
  id: number
  live_state_hash: string
  notes: string | null
  proposal_batch_id: number
  proposal_row_created_at: Date
  proposal_row_id: number
  reconcile_status: string
  row_title: string
  suggested_value_json: JsonValue
  target_entity_id: number
  target_entity_type: string
  validation_issues_json: Array<{ code: string; detail: string; severity: 'error' | 'warning' }>
  version: number
}

interface DesiredStateRow extends QueryResultRow {
  active: boolean
  created_at: Date
  desired_value_json: JsonValue
  field_path: string
  id: number
  paused: boolean
  target_entity_id: number
  target_entity_type: string
}

interface WriteOperationRow extends QueryResultRow {
  created_at: Date
  error: string | null
  finished_at: Date | null
  id: number
  operation_type: string
  post_write_snapshot_id: number | null
  pre_write_snapshot_id: number | null
  started_at: Date | null
  status: string
}

interface LlmRunRow extends QueryResultRow {
  created_at: Date
  forced_refresh: boolean
  id: number
  model: string
  prompt_version: string
  purpose: string
  status: string
  validation_issues_json: JsonValue
}

interface JobRow extends QueryResultRow {
  created_at: Date
  finished_at: Date | null
  id: number
  job_type: string
  last_error: string | null
  run_at: Date
  started_at: Date | null
  status: string
}

interface AuditRow extends QueryResultRow {
  actor_label: string
  created_at: Date
  event_type: string
  id: number
  undo_status: string | null
}

interface LitalertsObservationRow extends QueryResultRow {
  product_id: string | number
  captured_at: Date
  availability: string | null
  search_term_label: string | null
  notes: string | null
  brand_name: string | null
  listing_count: number
  pricing_eligible_listing_count: number
  evidence_json: JsonValue
}

interface LiveStateProductEntry {
  productId: number
  name: string | null
  tab: string | null
  price: number | null
}

export async function listCatalogGroups(
  db: Queryable,
  filters: CatalogBrowserQuery,
): Promise<CatalogBrowserResponse> {
  const { values, whereSql } = buildCatalogWhere(filters)
  const pageOffset = (filters.page - 1) * filters.pageSize

  const [itemsResult, countResult, facets] = await Promise.all([
    db.query<CatalogBrowserRow>(
      `
        select
          cg.id as catalog_group_id,
          cg.sweed_group_id,
          cg.group_name,
          cg.brand_name,
          cg.category_name,
          cg.subcategory_name,
          cg.live_state_json,
          cg.product_tabs_json,
          cg.reconcile_status,
          cg.last_synced_at,
          cg.drifted_at,
          coalesce(ds.active_desired_field_count, 0) as active_desired_field_count,
          coalesce(li.pending_line_item_count, 0) as pending_line_item_count,
          coalesce(li.approved_line_item_count, 0) as approved_line_item_count
        from catalog_groups cg
        left join (
          select catalog_group_id, count(*)::int as active_desired_field_count
          from desired_state_revisions
          where active = true
          group by catalog_group_id
        ) ds on ds.catalog_group_id = cg.id
        left join (
          select
            pli.catalog_group_id,
            count(*) filter (where approval_status = 'pending')::int as pending_line_item_count,
            count(*) filter (where approval_status = 'approved')::int as approved_line_item_count
          from proposal_line_items pli
          inner join proposal_rows pr on pr.id = pli.proposal_row_id
          inner join proposal_batches pb on pb.id = pr.proposal_batch_id
          where pb.status = 'ready'
          group by pli.catalog_group_id
        ) li on li.catalog_group_id = cg.id
        ${whereSql}
        order by cg.last_synced_at desc, cg.id desc
        limit $${values.length + 1}
        offset $${values.length + 2}
      `,
      [...values, filters.pageSize, pageOffset],
    ),
    db.query<{ total_count: number }>(
      `
        select count(*)::int as total_count
        from catalog_groups cg
        ${whereSql}
      `,
      values,
    ),
    loadCatalogBrowserFacets(db),
  ])

  let recentSalesIssue: string | null = null
  let recentSalesByGroup = new Map<number, ReturnType<typeof buildEmptyGroupRecentSales>>()
  try {
    recentSalesByGroup = await loadRecentSalesForGroups(
      itemsResult.rows.map((row) => ({
        catalogGroupId: row.catalog_group_id,
        liveState: row.live_state_json,
      })),
    )
  } catch (error) {
    recentSalesIssue =
      error instanceof Error ? `Recent sales velocity is unavailable right now: ${error.message}` : 'Recent sales velocity is unavailable right now.'
  }

  return {
    facets,
    filters,
    items: itemsResult.rows.map((row) => ({
      activeDesiredFieldCount: row.active_desired_field_count,
      approvedLineItemCount: row.approved_line_item_count,
      brandName: row.brand_name,
      catalogGroupId: row.catalog_group_id,
      categoryName: row.category_name,
      driftedAt: toIsoString(row.drifted_at),
      groupName: row.group_name,
      lastSyncedAt: toIsoString(row.last_synced_at) ?? new Date(0).toISOString(),
      pendingLineItemCount: row.pending_line_item_count,
      productTabs: row.product_tabs_json,
      reconcileStatus: row.reconcile_status as CatalogBrowserResponse['items'][number]['reconcileStatus'],
      recentSales: (recentSalesByGroup.get(row.catalog_group_id) ?? buildEmptyGroupRecentSales(row.live_state_json)).summary,
      subcategoryName: row.subcategory_name,
      sweedGroupId: row.sweed_group_id,
    })),
    recentSalesIssue,
    totalCount: countResult.rows[0]?.total_count ?? 0,
  }
}

export async function getGroupDetail(db: Queryable, catalogGroupId: number): Promise<GroupDetailResponse | null> {
  const groupResult = await db.query<GroupRow>(
    `
      select
        id,
        sweed_group_id,
        group_name,
        brand_name,
        category_name,
        subcategory_name,
        strain_name,
        live_state_json,
        reconcile_status,
        last_synced_at,
        drifted_at
      from catalog_groups
      where id = $1
    `,
    [catalogGroupId],
  )

  const group = groupResult.rows[0]
  if (!group) {
    return null
  }

  const liveStateProducts = extractLiveStateProducts(group.live_state_json)
  const productIds = liveStateProducts.map((entry) => entry.productId)

  const [snapshotResult, lineItemsResult, desiredStateResult, writeOperationsResult, llmRunsResult, jobsResult, auditsResult, observationsResult] =
    await Promise.all([
      db.query<SnapshotRow>(
        `
          select id, source, state_json, created_at
          from catalog_group_snapshots
          where catalog_group_id = $1
          order by created_at desc
          limit 1
        `,
        [catalogGroupId],
      ),
      db.query<LineItemRow>(
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
            pr.baseline_snapshot_id,
            pr.proposal_batch_id,
            pr.row_title,
            pr.created_at as proposal_row_created_at,
            cg.group_name,
            cg.reconcile_status,
            cg.live_state_hash,
            approver.name as approved_by_user,
            ds.id as active_desired_state_revision_id
          from proposal_line_items pli
          inner join proposal_rows pr on pr.id = pli.proposal_row_id
          inner join catalog_groups cg on cg.id = pli.catalog_group_id
          left join users approver on approver.id = pli.approved_by_user_id
          left join desired_state_revisions ds
            on ds.proposal_line_item_id = pli.id
           and ds.active = true
          where pli.catalog_group_id = $1
          order by pr.created_at desc, pli.id asc
        `,
        [catalogGroupId],
      ),
      db.query<DesiredStateRow>(
        `
          select id, field_path, target_entity_type, target_entity_id, desired_value_json, active, paused, created_at
          from desired_state_revisions
          where catalog_group_id = $1
          order by created_at desc
        `,
        [catalogGroupId],
      ),
      db.query<WriteOperationRow>(
        `
          select id, operation_type, status, created_at, started_at, finished_at, pre_write_snapshot_id, post_write_snapshot_id, error
          from write_operations
          where catalog_group_id = $1
          order by created_at desc
          limit 25
        `,
        [catalogGroupId],
      ),
      db.query<LlmRunRow>(
        `
          select id, purpose, status, forced_refresh, model, prompt_version, created_at, validation_issues_json
          from llm_runs
          where catalog_group_id = $1
          order by created_at desc
          limit 25
        `,
        [catalogGroupId],
      ),
      db.query<JobRow>(
        `
          select id, job_type, status, run_at, started_at, finished_at, last_error, created_at
          from job_queue
          where catalog_group_id = $1
          order by created_at desc
          limit 25
        `,
        [catalogGroupId],
      ),
      db.query<AuditRow>(
        `
          select
            ae.id,
            ae.event_type,
            ae.created_at,
            coalesce(u.name, ae.actor_type) as actor_label,
            ue.status as undo_status
          from audit_events ae
          left join users u on u.id = ae.actor_user_id
          left join undo_events ue on ue.original_event_id = ae.id
          where ae.catalog_group_id = $1
          order by ae.created_at desc
          limit 50
        `,
        [catalogGroupId],
      ),
      productIds.length === 0
        ? Promise.resolve({ rows: [] as LitalertsObservationRow[] })
        : db.query<LitalertsObservationRow>(
            `
              select distinct on (product_id)
                product_id, captured_at, availability, search_term_label, notes,
                brand_name, listing_count, pricing_eligible_listing_count,
                evidence_json
              from litalerts_competitor_observations
              where product_id = any($1::bigint[]) and status = 'succeeded'
              order by product_id, captured_at desc
            `,
            [productIds],
          ),
    ])

  // Effective marketplace listings = reviewed exact/brand_family
  // verdicts + auto-promoted unreviewed candidates whose score is
  // high enough. Loaded in parallel with the rest of the page; if
  // it fails we fall back silently to observation-only evidence so
  // the page still renders.
  const effectiveListings = await loadEffectiveMarketListingsForGroup(db, catalogGroupId).catch(
    (err: unknown) => {
      console.warn(`[catalog] effective listings load failed for group ${catalogGroupId}:`, err)
      return null
    },
  )

  const marketEvidence = buildMarketEvidence(
    liveStateProducts,
    observationsResult.rows,
    effectiveListings?.byProductId ?? new Map(),
  )

  // Recent-sales velocity used to be loaded inline here via
  // loadRecentSalesForGroups(), which cold-paginated the entire
  // Sweed `store.reports.reorder` report (pageSize=200, both
  // Bronx + Midtown) every time the 60s in-memory cache expired,
  // just to look up sales for the 1-3 productIds in this group.
  // That made GET /api/catalog/groups/:id take 20-25s cold even
  // though every other query in the function completed in <70ms.
  // We now return the empty shape (same contract) plus an
  // informational message; if a recent-sales surface is needed
  // we can wire a separate on-demand endpoint that doesn't block
  // the rest of the page.
  const recentSales = buildEmptyGroupRecentSales(group.live_state_json)
  const recentSalesIssue: string | null =
    'Recent sales velocity is not loaded on this page (was making the page take ~24s cold). View sales detail on the Pending Purchases page.'

  const proposalRowsById = new Map<number, GroupDetailResponse['proposalRows'][number]>()
  for (const row of lineItemsResult.rows) {
    const mappedLineItem = mapProposalLineItem(row)
    const existing = proposalRowsById.get(row.proposal_row_id)
    if (existing) {
      existing.lineItems.push(mappedLineItem)
      continue
    }

    proposalRowsById.set(row.proposal_row_id, {
      createdAt: toIsoString(row.proposal_row_created_at) ?? new Date(0).toISOString(),
      lineItems: [mappedLineItem],
      proposalBatchId: row.proposal_batch_id,
      proposalRowId: row.proposal_row_id,
      rowTitle: row.row_title,
    })
  }

  const liveSnapshot = snapshotResult.rows[0]

  return {
    desiredState: desiredStateResult.rows.map((row) => ({
      active: row.active,
      createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
      desiredValue: row.desired_value_json,
      fieldPath: row.field_path,
      paused: row.paused,
      revisionId: row.id,
      targetEntityId: row.target_entity_id,
      targetEntityType: row.target_entity_type,
    })),
    group: {
      brandName: group.brand_name,
      catalogGroupId: group.id,
      categoryName: group.category_name,
      driftedAt: toIsoString(group.drifted_at),
      groupName: group.group_name,
      lastSyncedAt: toIsoString(group.last_synced_at) ?? new Date(0).toISOString(),
      reconcileStatus: group.reconcile_status,
      strainName: group.strain_name,
      subcategoryName: group.subcategory_name,
      sweedGroupId: group.sweed_group_id,
    },
    liveSnapshot: liveSnapshot
      ? {
          createdAt: toIsoString(liveSnapshot.created_at) ?? new Date(0).toISOString(),
          snapshotId: liveSnapshot.id,
          source: liveSnapshot.source,
          stateJson: liveSnapshot.state_json,
        }
      : null,
    marketEvidence,
    recentSales,
    recentSalesIssue,
    llmRuns: llmRunsResult.rows.map((row) => ({
      createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
      forcedRefresh: row.forced_refresh,
      llmRunId: row.id,
      model: row.model,
      promptVersion: row.prompt_version,
      purpose: row.purpose,
      status: row.status,
      validationIssues: row.validation_issues_json,
    })),
    proposalRows: Array.from(proposalRowsById.values()),
    recentAuditEvents: auditsResult.rows.map((row) => ({
      actorLabel: row.actor_label,
      createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
      eventId: row.id,
      eventType: row.event_type,
      undoStatus: row.undo_status,
    })),
    recentJobs: jobsResult.rows.map((row) => ({
      createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
      finishedAt: toIsoString(row.finished_at),
      jobId: row.id,
      jobType: row.job_type,
      lastError: row.last_error,
      runAt: toIsoString(row.run_at) ?? new Date(0).toISOString(),
      startedAt: toIsoString(row.started_at),
      status: row.status,
    })),
    writeOperations: writeOperationsResult.rows.map((row) => ({
      createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
      error: row.error,
      finishedAt: toIsoString(row.finished_at),
      operationType: row.operation_type,
      postWriteSnapshotId: row.post_write_snapshot_id,
      preWriteSnapshotId: row.pre_write_snapshot_id,
      startedAt: toIsoString(row.started_at),
      status: row.status,
      writeOperationId: row.id,
    })),
  }
}

// Distinct brand/category/subcategory/status values pulled from the
// catalog_groups table. These power the filter-rail <select> menus on
// /catalog/browser so reviewers can discover legal values rather than
// guessing exact strings. Cheap enough to run inline on every browser
// request (one scan per column, table is small and the columns are
// already used by other queries).
async function loadCatalogBrowserFacets(db: Queryable): Promise<{
  brands: string[]
  categories: string[]
  reconcileStatuses: string[]
  sizes: string[]
  subcategories: string[]
}> {
  const [brands, categories, subcategories, statuses, sizes] = await Promise.all([
    db.query<{ value: string }>(
      `select distinct brand_name as value
         from catalog_groups
        where brand_name is not null and brand_name <> ''
        order by brand_name asc`,
    ),
    db.query<{ value: string }>(
      `select distinct category_name as value
         from catalog_groups
        where category_name is not null and category_name <> ''
        order by category_name asc`,
    ),
    db.query<{ value: string }>(
      `select distinct subcategory_name as value
         from catalog_groups
        where subcategory_name is not null and subcategory_name <> ''
        order by subcategory_name asc`,
    ),
    db.query<{ value: string }>(
      `select distinct reconcile_status as value
         from catalog_groups
        where reconcile_status is not null and reconcile_status <> ''
        order by reconcile_status asc`,
    ),
    // sizeName is per-product (live_state_json -> 'products' -> [i] ->
    // 'sizeName'). Expand the JSONB array, pull the distinct non-empty
    // values, then sort by `length` first so short numeric-style sizes
    // (1g, 3.5g, 10mg) group together ahead of longer free-form labels.
    //
    // We collapse the distinct + order-by into an outer select over an
    // inner `select distinct trim(...) as value`, because
    //   (a) `jsonb_array_elements(...) p` itself exposes a column named
    //       `value`, so a bare `select distinct value` against that
    //       alongside our own `as value` alias is an ambiguous-column
    //       error in postgres — the prior shape failed at runtime with
    //       `column reference "value" is ambiguous` and 5xx'd
    //       /api/catalog/groups for every reviewer (issue #17), and
    //   (b) `select distinct` + `order by length(value)` is itself a
    //       postgres error ("ORDER BY expressions must appear in select
    //       list"), which would have masked the ambiguity bug above
    //       once it was fixed.
    db.query<{ value: string }>(
      `select v.value
         from (
           select distinct trim(p->>'sizeName') as value
             from catalog_groups cg,
                  lateral jsonb_array_elements(coalesce(cg.live_state_json->'products', '[]'::jsonb)) p
         ) v
        where v.value is not null and v.value <> ''
        order by length(v.value) asc, v.value asc`,
    ),
  ])
  return {
    brands: brands.rows.map((row) => row.value),
    categories: categories.rows.map((row) => row.value),
    reconcileStatuses: statuses.rows.map((row) => row.value),
    sizes: sizes.rows.map((row) => row.value),
    subcategories: subcategories.rows.map((row) => row.value),
  }
}

function buildCatalogWhere(filters: CatalogBrowserQuery): { values: unknown[]; whereSql: string } {
  const clauses: string[] = []
  const values: unknown[] = []

  if (filters.brand) {
    values.push(filters.brand)
    clauses.push(`cg.brand_name = $${values.length}`)
  }
  if (filters.category) {
    values.push(filters.category)
    clauses.push(`cg.category_name = $${values.length}`)
  }
  if (filters.subcategory) {
    values.push(filters.subcategory)
    clauses.push(`cg.subcategory_name = $${values.length}`)
  }
  if (filters.reconcileStatus) {
    values.push(filters.reconcileStatus)
    clauses.push(`cg.reconcile_status = $${values.length}`)
  }
  if (filters.size) {
    // Keep this group if any product's sizeName matches. Uses the
    // JSONB containment operator with a trimmed comparison; we don't
    // have an index on (live_state_json -> 'products' -> 'sizeName'),
    // so this scans live_state_json for matching rows — acceptable at
    // current catalog_groups row counts (~thousands).
    values.push(filters.size)
    clauses.push(`exists (
      select 1
        from jsonb_array_elements(coalesce(cg.live_state_json->'products', '[]'::jsonb)) p
       where trim(p->>'sizeName') = $${values.length}
    )`)
  }
  if (filters.search) {
    values.push(`%${filters.search}%`)
    clauses.push(`(cg.group_name ilike $${values.length} or coalesce(cg.brand_name, '') ilike $${values.length})`)
  }

  if (clauses.length === 0) {
    return { values, whereSql: '' }
  }

  return { values, whereSql: `where ${clauses.join(' and ')}` }
}

function mapProposalLineItem(row: LineItemRow): ProposalLineItem {
  const baselinePreview = buildTextPreview(row.baseline_value_json)
  const suggestedPreview = buildTextPreview(row.suggested_value_json)
  const editedPreview = buildTextPreview(row.edited_value_json ?? row.suggested_value_json)
  const effectivePreview = buildTextPreview(row.effective_value_json)

  return {
    activeDesiredStateRevisionId: row.active_desired_state_revision_id,
    approvalStatus: row.approval_status as ProposalLineItem['approvalStatus'],
    approvalUpdatedAt: toIsoString(row.approval_updated_at),
    approvedByUser: row.approved_by_user,
    baselineSnapshotId: row.baseline_snapshot_id,
    baselineValue: row.baseline_value_json,
    catalogGroupId: row.catalog_group_id,
    effectiveValue: row.effective_value_json,
    editedValue: row.edited_value_json,
    fieldPath: row.field_path as ProposalLineItem['fieldPath'],
    groupSummary: {
      brandName: null,
      categoryName: null,
      groupName: row.group_name,
      liveStateHash: row.live_state_hash,
      reconcileStatus: row.reconcile_status,
      subcategoryName: null,
    },
    lineItemId: row.id,
    notes: row.notes,
    rowId: row.proposal_row_id,
    suggestedValue: row.suggested_value_json,
    targetEntityId: row.target_entity_id,
    targetEntityType: row.target_entity_type as ProposalLineItem['targetEntityType'],
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

export function lineItemSummaryText(lineItem: ProposalLineItem): string {
  return `${lineItem.groupSummary.groupName}: ${lineItem.fieldPath} -> ${jsonValueToPreview(lineItem.effectiveValue)}`
}

function extractLiveStateProducts(liveState: JsonValue): LiveStateProductEntry[] {
  if (!liveState || typeof liveState !== 'object' || Array.isArray(liveState)) return []
  const productsValue = (liveState as Record<string, JsonValue>).products
  if (!Array.isArray(productsValue)) return []

  const entries: LiveStateProductEntry[] = []
  for (const candidate of productsValue) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const record = candidate as Record<string, JsonValue>
    const rawId = record.productId
    const productId = typeof rawId === 'number' ? rawId : Number(rawId)
    if (!Number.isFinite(productId) || productId <= 0 || !Number.isInteger(productId)) continue

    const rawName = record.name
    const rawTab = record.tab
    const rawPrice = record.price

    entries.push({
      productId,
      name: typeof rawName === 'string' ? rawName : null,
      tab: typeof rawTab === 'string' ? rawTab : null,
      price: typeof rawPrice === 'number' && Number.isFinite(rawPrice) ? rawPrice : null,
    })
  }
  return entries
}

function buildMarketEvidence(
  products: LiveStateProductEntry[],
  observations: LitalertsObservationRow[],
  effectiveListingsByProductId: Map<number, EffectiveMarketListing[]>,
): GroupProductMarketEvidence[] {
  if (products.length === 0) return []

  const obsByProductId = new Map<number, LitalertsObservationRow>()
  for (const row of observations) {
    const productId = typeof row.product_id === 'number' ? row.product_id : Number(row.product_id)
    if (!Number.isFinite(productId)) continue
    obsByProductId.set(productId, row)
  }

  const now = Date.now()

  return products.map((product) => {
    // Pull auto-promoted / reviewed listings for THIS variant. They're
    // keyed by Sweed catalog productId (== product.productId here).
    const effective = effectiveListingsByProductId.get(product.productId) ?? []
    const effectiveAsMatched: PendingPurchaseMarketListing[] = effective
      .map((listing) => projectEffectiveListing(listing))
      .filter((l): l is PendingPurchaseMarketListing => l !== null)

    const obs = obsByProductId.get(product.productId)
    if (!obs) {
      // No live observation, but we may still have auto-promoted /
      // reviewed structured matches for this variant — surface them
      // so pricing UI doesn't show "0 listings" for a group that has
      // a live verdict-set.
      const eligibleEffective = effectiveAsMatched.filter((l) => l.eligibleForPricing)
      const ePrices = eligibleEffective.map((l) => l.postTaxPrice).filter((v) => Number.isFinite(v))
      const avg = ePrices.length > 0 ? ePrices.reduce((s, v) => s + v, 0) / ePrices.length : null
      let med: number | null = null
      if (ePrices.length > 0) {
        const sorted = [...ePrices].sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        med = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
      }
      return {
        productId: product.productId,
        productName: product.name ?? `Product #${product.productId}`,
        productTab: product.tab,
        livePrice: product.price,
        capturedAt: null,
        freshness: effectiveAsMatched.length > 0 ? ('fresh' as const) : ('absent' as const),
        ageDays: null,
        availability: null,
        searchTermLabel: null,
        notes: null,
        brandName: null,
        listingCount: effectiveAsMatched.length,
        eligibleListingCount: eligibleEffective.length,
        averagePostTaxPrice: avg,
        medianPostTaxPrice: med,
        matchedListings: effectiveAsMatched,
      }
    }

    const capturedAtMs = obs.captured_at instanceof Date ? obs.captured_at.getTime() : new Date(obs.captured_at).getTime()
    const ageMs = Math.max(0, now - capturedAtMs)
    const ageDaysRaw = ageMs / (1000 * 60 * 60 * 24)
    const ageDays = Math.round(ageDaysRaw * 10) / 10
    const freshness: GroupProductMarketEvidence['freshness'] =
      ageMs <= 24 * 60 * 60 * 1000
        ? 'fresh'
        : ageMs <= 4 * 24 * 60 * 60 * 1000
          ? 'stale'
          : ageMs <= 7 * 24 * 60 * 60 * 1000
            ? 'very_stale'
            : 'expired'

    // Merge observation-derived matched listings with effective
    // (reviewed / auto-promoted) ones. Dedupe by listing URL when
    // present so we don't double-count the same row that appears in
    // both sources.
    const obsListings = extractMatchedListings(obs.evidence_json)
    const matchedListings = mergeMatchedListings(obsListings, effectiveAsMatched)
    const eligible = matchedListings.filter((listing) => listing.eligibleForPricing === true)
    const eligiblePrices = eligible.map((listing) => listing.postTaxPrice).filter((value) => Number.isFinite(value))

    const averagePostTaxPrice =
      eligiblePrices.length > 0 ? eligiblePrices.reduce((acc, value) => acc + value, 0) / eligiblePrices.length : null

    let medianPostTaxPrice: number | null = null
    if (eligiblePrices.length > 0) {
      const sorted = [...eligiblePrices].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      medianPostTaxPrice = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
    }

    return {
      productId: product.productId,
      productName: product.name ?? `Product #${product.productId}`,
      productTab: product.tab,
      livePrice: product.price,
      capturedAt: toIsoString(obs.captured_at),
      freshness,
      ageDays,
      availability: obs.availability,
      searchTermLabel: obs.search_term_label,
      notes: obs.notes,
      brandName: obs.brand_name,
      listingCount: Number(obs.listing_count) || 0,
      eligibleListingCount: Number(obs.pricing_eligible_listing_count) || 0,
      averagePostTaxPrice,
      medianPostTaxPrice,
      matchedListings,
    }
  })
}

/**
 * Coerce an EffectiveMarketListing (the auto-promoted /
 * reviewed-verdict shape from `catalogMarketMatchQueries`) into the
 * wire shape used by `GroupProductMarketEvidence.matchedListings`.
 * Listings whose price could not be parsed are dropped (they
 * contribute nothing useful to averages and would render as $NaN).
 */
function projectEffectiveListing(
  listing: EffectiveMarketListing,
): PendingPurchaseMarketListing | null {
  if (
    listing.preTaxPrice === null ||
    listing.postTaxPrice === null ||
    !Number.isFinite(listing.preTaxPrice) ||
    !Number.isFinite(listing.postTaxPrice)
  ) {
    return null
  }
  const normalized = {
    category: listing.category,
    distanceBand: listing.distanceBand,
    distanceMiles: listing.distanceMiles,
    dispensaryName: listing.dispensaryName || '—',
    eligibleForPricing: listing.eligibleForPricing,
    exclusionReason: listing.exclusionReason,
    imageUrl: listing.imageUrl,
    listingName: listing.listingName,
    matchTier: listing.matchTier,
    postTaxPrice: listing.postTaxPrice,
    preTaxPrice: listing.preTaxPrice,
    source: listing.source,
    url: listing.url,
  }
  const parsed = PendingPurchaseMarketListingSchema.safeParse(normalized)
  return parsed.success ? parsed.data : null
}

/**
 * Merge observation-derived listings with effective (auto-promoted /
 * reviewed) listings. Deduplicate by URL (when both sides have one)
 * so the same partner-API row landed by both pipelines doesn't
 * double-count. Effective listings win on conflict because their
 * matchTier reflects the reviewer's verdict rather than the
 * heuristic at observation-capture time.
 */
function mergeMatchedListings(
  observationListings: PendingPurchaseMarketListing[],
  effectiveListings: PendingPurchaseMarketListing[],
): PendingPurchaseMarketListing[] {
  if (effectiveListings.length === 0) return observationListings
  const effectiveUrls = new Set(effectiveListings.map((l) => l.url).filter((u): u is string => !!u))
  const merged: PendingPurchaseMarketListing[] = []
  for (const listing of observationListings) {
    if (listing.url && effectiveUrls.has(listing.url)) continue
    merged.push(listing)
  }
  merged.push(...effectiveListings)
  return merged
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
        typeof record.distanceMiles === 'number' && Number.isFinite(record.distanceMiles) ? record.distanceMiles : null,
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
