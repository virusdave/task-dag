import type { QueryResultRow } from 'pg'

import type { ReviewLineItemListQuery, ReviewLineItemListResponse } from '../../../shared/contracts/api/review.js'
import type { JsonValue, ProposalLineItem } from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'
import { buildTextPreview, toIsoString } from './helpers.js'

interface ReviewRow extends QueryResultRow {
  active_desired_state_revision_id: number | null
  approval_status: string
  approval_updated_at: Date | null
  approved_by_user: string | null
  baseline_snapshot_id: number | null
  baseline_value_json: JsonValue
  batch_created_at: Date
  batch_id: number
  batch_status: string
  batch_type: string
  brand_name: string | null
  catalog_group_id: number
  category_name: string | null
  effective_value_json: JsonValue
  edited_value_json: JsonValue | null
  field_path: string
  group_name: string
  id: number
  live_state_hash: string
  notes: string | null
  proposal_row_id: number
  reconcile_status: string
  subcategory_name: string | null
  suggested_value_json: JsonValue
  target_entity_id: number
  target_entity_type: string
  validation_issues_json: Array<{ code: string; detail: string; severity: 'error' | 'warning' }>
  version: number
}

export async function listReviewLineItems(
  db: Queryable,
  filters: ReviewLineItemListQuery,
): Promise<ReviewLineItemListResponse> {
  const { values, whereSql } = buildReviewWhere(filters)
  const pageOffset = (filters.page - 1) * filters.pageSize

  const [itemsResult, countResult] = await Promise.all([
    db.query<ReviewRow>(
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
          pb.id as batch_id,
          pb.type as batch_type,
          pb.status as batch_status,
          pb.created_at as batch_created_at,
          cg.group_name,
          cg.brand_name,
          cg.category_name,
          cg.subcategory_name,
          cg.reconcile_status,
          cg.live_state_hash,
          approver.name as approved_by_user,
          ds.id as active_desired_state_revision_id
        from proposal_line_items pli
        inner join proposal_rows pr on pr.id = pli.proposal_row_id
        inner join proposal_batches pb on pb.id = pr.proposal_batch_id
        inner join catalog_groups cg on cg.id = pli.catalog_group_id
        left join users approver on approver.id = pli.approved_by_user_id
        left join desired_state_revisions ds on ds.proposal_line_item_id = pli.id and ds.active = true
        ${whereSql}
        order by pb.created_at desc, pli.updated_at desc, pli.id desc
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

  const batchSummary = itemsResult.rows[0]
    ? {
        batchId: itemsResult.rows[0].batch_id,
        createdAt: toIsoString(itemsResult.rows[0].batch_created_at) ?? new Date(0).toISOString(),
        status: itemsResult.rows[0].batch_status,
        type: itemsResult.rows[0].batch_type,
      }
    : null

  return {
    batchSummary,
    filters,
    items: itemsResult.rows.map((row) => mapReviewLineItem(row)),
    totalCount: countResult.rows[0]?.total_count ?? 0,
  }
}

function buildReviewWhere(filters: ReviewLineItemListQuery): { values: unknown[]; whereSql: string } {
  const clauses: string[] = []
  const values: unknown[] = []

  if (filters.batchStatus) {
    values.push(filters.batchStatus)
    clauses.push(`pb.status = $${values.length}`)
  } else {
    clauses.push(`pb.status = 'ready'`)
  }

  if (filters.proposalType) {
    values.push(filters.proposalType)
    clauses.push(`pb.type = $${values.length}`)
  }
  if (filters.approvalStatus) {
    values.push(filters.approvalStatus)
    clauses.push(`pli.approval_status = $${values.length}`)
  }
  if (filters.hasValidationIssues) {
    clauses.push(`jsonb_array_length(pli.validation_issues_json) > 0`)
  }
  if (filters.driftOnly) {
    clauses.push(`cg.reconcile_status = 'drifted'`)
  }
  if (filters.search) {
    values.push(`%${filters.search}%`)
    clauses.push(`(cg.group_name ilike $${values.length} or coalesce(cg.brand_name, '') ilike $${values.length})`)
  }

  return {
    values,
    whereSql: clauses.length > 0 ? `where ${clauses.join(' and ')}` : '',
  }
}

function mapReviewLineItem(row: ReviewRow): ProposalLineItem {
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
