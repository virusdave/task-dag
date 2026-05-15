import type { QueryResultRow } from 'pg'

import type {
  CatalogBrowserQuery,
  CatalogBrowserResponse,
  GroupDetailResponse,
  JsonValue,
  ProposalLineItem,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'
import { buildEmptyGroupRecentSales, loadRecentSalesForGroups } from '../../catalog/liveRecentSales.js'
import { buildTextPreview, jsonValueToPreview, toIsoString } from './helpers.js'

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

export async function listCatalogGroups(
  db: Queryable,
  filters: CatalogBrowserQuery,
): Promise<CatalogBrowserResponse> {
  const { values, whereSql } = buildCatalogWhere(filters)
  const pageOffset = (filters.page - 1) * filters.pageSize

  const [itemsResult, countResult] = await Promise.all([
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
        order by cg.updated_at desc, cg.id desc
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

  const [snapshotResult, lineItemsResult, desiredStateResult, writeOperationsResult, llmRunsResult, jobsResult, auditsResult] =
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
    ])

  let recentSalesIssue: string | null = null
  let recentSales = buildEmptyGroupRecentSales(group.live_state_json)
  try {
    recentSales =
      (await loadRecentSalesForGroups([{ catalogGroupId, liveState: group.live_state_json }])).get(catalogGroupId) ?? recentSales
  } catch (error) {
    recentSalesIssue =
      error instanceof Error ? `Recent sales velocity is unavailable right now: ${error.message}` : 'Recent sales velocity is unavailable right now.'
  }

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
