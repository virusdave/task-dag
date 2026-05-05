import type { QueryResultRow } from 'pg'

import type {
  CatalogHistoryApprovalItem,
  CatalogHistoryPendingPurchaseApplyItem,
  CatalogHistoryPendingPurchasePacketItem,
  CatalogHistoryProposalBatchItem,
  CatalogHistoryQuery,
  CatalogHistoryResponse,
  CatalogHistoryWriteOperationItem,
  JsonValue,
  JobStatus,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'
import { toIsoString } from './helpers.js'

interface ProposalBatchHistoryRow extends QueryResultRow {
  config_json: JsonValue
  created_at: Date
  created_by_user: string | null
  id: number
  job_id: number | null
  job_status: JobStatus | null
  line_item_count: number
  source: CatalogHistoryProposalBatchItem['source']
  status: CatalogHistoryProposalBatchItem['status']
  summary_json: JsonValue
  trigger_mode: CatalogHistoryProposalBatchItem['triggerMode']
  type: CatalogHistoryProposalBatchItem['type']
  row_count: number
}

interface WriteOperationHistoryRow extends QueryResultRow {
  attempt_count: number
  catalog_group_id: number
  created_at: Date
  error: string | null
  finished_at: Date | null
  group_name: string
  id: number
  job_id: number | null
  operation_type: CatalogHistoryWriteOperationItem['operationType']
  started_at: Date | null
  status: CatalogHistoryWriteOperationItem['status']
  trigger_actor_label: string | null
  trigger_event_id: number | null
  trigger_event_type: string | null
}

interface PendingPurchasePacketHistoryRow extends QueryResultRow {
  created_at: Date
  created_by_user: string | null
  generated_at: Date
  id: number
  import_file_name: string | null
  job_id: number | null
  job_status: JobStatus | null
  packet_title: string
  row_count: number
  site_labels_json: string[]
  source: CatalogHistoryPendingPurchasePacketItem['source']
  source_path: string | null
  status: CatalogHistoryPendingPurchasePacketItem['status']
  summary_json: JsonValue
}

interface PendingPurchaseApplyHistoryRow extends QueryResultRow {
  applied_row_count: number
  blocked_row_count: number
  created_at: Date
  failed_row_count: number
  finished_at: Date | null
  id: number
  job_id: number | null
  job_status: JobStatus | null
  packet_id: number
  packet_title: string
  requested_by_user: string | null
  selected_row_count: number
  started_at: Date | null
  status: CatalogHistoryPendingPurchaseApplyItem['status']
  summary_json: JsonValue
}

interface ProposalApprovalHistoryRow extends QueryResultRow {
  actor_label: string
  catalog_group_id: number | null
  created_at: Date
  event_type: CatalogHistoryApprovalItem['kind'] extends never ? never : string
  field_path: string | null
  group_name: string | null
  id: number
}

interface PendingPurchaseApprovalHistoryRow extends QueryResultRow {
  actor_label: string
  created_at: Date
  distributor_product_name: string | null
  id: number
  next_approval_status: string | null
  packet_id: number | null
  packet_title: string | null
  row_id: number | null
  site_label: string | null
}

export async function getCatalogHistory(
  db: Queryable,
  filters: CatalogHistoryQuery,
): Promise<CatalogHistoryResponse> {
  const [proposalBatchItems, approvalItems, writeOperationItems, pendingPurchasePacketItems, pendingPurchaseApplyItems] =
    await Promise.all([
      listProposalBatchHistory(db, filters.sectionLimit),
      listApprovalHistory(db, filters.sectionLimit),
      listWriteOperationHistory(db, filters.sectionLimit),
      listPendingPurchasePacketHistory(db, filters.sectionLimit),
      listPendingPurchaseApplyHistory(db, filters.sectionLimit),
    ])

  return {
    approvalItems,
    filters,
    pendingPurchaseApplyItems,
    pendingPurchasePacketItems,
    proposalBatchItems,
    writeOperationItems,
  }
}

async function listProposalBatchHistory(
  db: Queryable,
  sectionLimit: number,
): Promise<CatalogHistoryProposalBatchItem[]> {
  const result = await db.query<ProposalBatchHistoryRow>(
    `
      select
        pb.id,
        pb.type,
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
      order by pb.created_at desc, pb.id desc
      limit $1
    `,
    [sectionLimit],
  )

  return result.rows.map((row) => {
    const requestedGroupCount = readIntegerField(row.summary_json, 'requestedGroupCount')
      ?? readCatalogGroupCountFromConfig(row.config_json)
    const generatedGroupCount = readIntegerField(row.summary_json, 'generatedGroupCount')
    const generatedLineItemCount = readIntegerField(row.summary_json, 'generatedLineItemCount')
    const importFileName = readStringField(row.config_json, 'importFileName')
    const sourcePath = readStringField(row.config_json, 'sourcePath')

    return {
      batchId: row.id,
      createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
      createdByUser: row.created_by_user,
      generatedGroupCount,
      generatedLineItemCount,
      importFileName,
      jobId: row.job_id,
      jobStatus: row.job_status,
      lineItemCount: row.line_item_count,
      requestedGroupCount,
      rowCount: row.row_count,
      source: row.source,
      sourcePath,
      status: row.status,
      summaryText: buildProposalBatchSummary({
        generatedGroupCount,
        generatedLineItemCount,
        requestedGroupCount,
        rowCount: row.row_count,
        source: row.source,
        status: row.status,
        summaryJson: row.summary_json,
        type: row.type,
      }),
      triggerMode: row.trigger_mode,
      type: row.type,
    }
  })
}

async function listWriteOperationHistory(
  db: Queryable,
  sectionLimit: number,
): Promise<CatalogHistoryWriteOperationItem[]> {
  const result = await db.query<WriteOperationHistoryRow>(
    `
      select
        wo.id,
        wo.catalog_group_id,
        cg.group_name,
        wo.operation_type,
        wo.status,
        wo.attempt_count,
        wo.trigger_event_id,
        wo.job_id,
        wo.error,
        wo.started_at,
        wo.finished_at,
        wo.created_at,
        ae.event_type as trigger_event_type,
        coalesce(trigger_user.name, ae.actor_type) as trigger_actor_label
      from write_operations wo
      inner join catalog_groups cg on cg.id = wo.catalog_group_id
      left join audit_events ae on ae.id = wo.trigger_event_id
      left join users trigger_user on trigger_user.id = ae.actor_user_id
      order by wo.created_at desc, wo.id desc
      limit $1
    `,
    [sectionLimit],
  )

  return result.rows.map((row) => ({
    attemptCount: row.attempt_count,
    catalogGroupId: row.catalog_group_id,
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    error: row.error,
    finishedAt: toIsoString(row.finished_at),
    groupName: row.group_name,
    jobId: row.job_id,
    operationType: row.operation_type,
    startedAt: toIsoString(row.started_at),
    status: row.status,
    summaryText: buildWriteOperationSummary(row),
    triggerActorLabel: row.trigger_actor_label,
    triggerEventId: row.trigger_event_id,
    triggerEventType: row.trigger_event_type,
    writeOperationId: row.id,
  }))
}

async function listPendingPurchasePacketHistory(
  db: Queryable,
  sectionLimit: number,
): Promise<CatalogHistoryPendingPurchasePacketItem[]> {
  const result = await db.query<PendingPurchasePacketHistoryRow>(
    `
      select
        ppp.id,
        ppp.packet_title,
        ppp.source,
        ppp.status,
        ppp.import_file_name,
        ppp.source_path,
        ppp.generated_at,
        ppp.site_labels_json,
        ppp.summary_json,
        ppp.created_at,
        ppp.job_id,
        jq.status as job_status,
        creator.name as created_by_user,
        count(ppr.id)::int as row_count
      from pending_purchase_packets ppp
      left join pending_purchase_rows ppr on ppr.packet_id = ppp.id
      left join job_queue jq on jq.id = ppp.job_id
      left join users creator on creator.id = ppp.created_by_user_id
      group by ppp.id, jq.status, creator.name
      order by ppp.generated_at desc, ppp.id desc
      limit $1
    `,
    [sectionLimit],
  )

  return result.rows.map((row) => ({
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    createdByUser: row.created_by_user,
    generatedAt: toIsoString(row.generated_at) ?? new Date(0).toISOString(),
    importFileName: row.import_file_name,
    jobId: row.job_id,
    jobStatus: row.job_status,
    packetId: row.id,
    packetTitle: row.packet_title,
    rowCount: row.row_count,
    siteLabels: row.site_labels_json,
    source: row.source,
    sourcePath: row.source_path,
    status: row.status,
    summaryText: buildPendingPurchasePacketSummary(row),
  }))
}

async function listPendingPurchaseApplyHistory(
  db: Queryable,
  sectionLimit: number,
): Promise<CatalogHistoryPendingPurchaseApplyItem[]> {
  const result = await db.query<PendingPurchaseApplyHistoryRow>(
    `
      select
        ppar.id,
        ppar.packet_id,
        ppp.packet_title,
        ppar.job_id,
        jq.status as job_status,
        ppar.status,
        ppar.selected_row_count,
        ppar.applied_row_count,
        ppar.blocked_row_count,
        ppar.failed_row_count,
        ppar.summary_json,
        ppar.started_at,
        ppar.finished_at,
        ppar.created_at,
        requester.name as requested_by_user
      from pending_purchase_apply_requests ppar
      inner join pending_purchase_packets ppp on ppp.id = ppar.packet_id
      left join job_queue jq on jq.id = ppar.job_id
      left join users requester on requester.id = ppar.requested_by_user_id
      order by ppar.created_at desc, ppar.id desc
      limit $1
    `,
    [sectionLimit],
  )

  return result.rows.map((row) => ({
    appliedRowCount: row.applied_row_count,
    blockedRowCount: row.blocked_row_count,
    failedRowCount: row.failed_row_count,
    finishedAt: toIsoString(row.finished_at),
    jobId: row.job_id,
    jobStatus: row.job_status,
    packetId: row.packet_id,
    packetTitle: row.packet_title,
    requestId: row.id,
    requestedAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    requestedByUser: row.requested_by_user,
    selectedRowCount: row.selected_row_count,
    startedAt: toIsoString(row.started_at),
    status: row.status,
    summaryText: buildPendingPurchaseApplySummary(row),
  }))
}

async function listApprovalHistory(
  db: Queryable,
  sectionLimit: number,
): Promise<CatalogHistoryApprovalItem[]> {
  const [proposalResult, pendingPurchaseResult] = await Promise.all([
    db.query<ProposalApprovalHistoryRow>(
      `
        select
          ae.id,
          ae.created_at,
          ae.event_type,
          coalesce(u.name, ae.actor_type) as actor_label,
          pli.catalog_group_id,
          cg.group_name,
          ae.payload_json ->> 'fieldPath' as field_path
        from audit_events ae
        left join users u on u.id = ae.actor_user_id
        left join proposal_line_items pli on ae.entity_id ~ '^[0-9]+$' and pli.id = ae.entity_id::bigint
        left join catalog_groups cg on cg.id = pli.catalog_group_id
        where ae.event_type in ('proposal.line_item.approved', 'proposal.line_item.rejected')
        order by ae.created_at desc, ae.id desc
        limit $1
      `,
      [sectionLimit],
    ),
    db.query<PendingPurchaseApprovalHistoryRow>(
      `
        select
          ae.id,
          ae.created_at,
          coalesce(u.name, ae.actor_type) as actor_label,
          ppr.id as row_id,
          ppr.packet_id,
          ppp.packet_title,
          ppr.distributor_product_name,
          ppr.site_label,
          ae.payload_json ->> 'nextApprovalStatus' as next_approval_status
        from audit_events ae
        left join users u on u.id = ae.actor_user_id
        left join pending_purchase_rows ppr on ae.entity_id ~ '^[0-9]+$' and ppr.id = ae.entity_id::bigint
        left join pending_purchase_packets ppp on ppp.id = ppr.packet_id
        where ae.event_type = 'pending_purchase.row.approval_updated'
        order by ae.created_at desc, ae.id desc
        limit $1
      `,
      [sectionLimit],
    ),
  ])

  const proposalItems = proposalResult.rows.map<CatalogHistoryApprovalItem>((row) => {
    const decision: CatalogHistoryApprovalItem['decision'] = row.event_type === 'proposal.line_item.approved' ? 'approved' : 'rejected'
    const itemLabel = row.group_name ?? `Catalog group #${row.catalog_group_id ?? 'unknown'}`

    return {
      actorLabel: row.actor_label,
      catalogGroupId: row.catalog_group_id,
      catalogGroupName: row.group_name,
      createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
      decision,
      eventId: row.id,
      fieldPath: row.field_path,
      itemLabel,
      kind: 'proposal_line_item',
      packetId: null,
      packetTitle: null,
      rowId: null,
      siteLabel: null,
      summaryText: buildProposalApprovalSummary(itemLabel, row.field_path, decision),
    }
  })

  const pendingPurchaseItems = pendingPurchaseResult.rows.map<CatalogHistoryApprovalItem>((row) => {
    const decision = normalizeApprovalDecision(row.next_approval_status)
    const itemLabel = row.distributor_product_name ?? `Pending-purchase row #${row.row_id ?? 'unknown'}`

    return {
      actorLabel: row.actor_label,
      catalogGroupId: null,
      catalogGroupName: null,
      createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
      decision,
      eventId: row.id,
      fieldPath: null,
      itemLabel,
      kind: 'pending_purchase_row',
      packetId: row.packet_id,
      packetTitle: row.packet_title,
      rowId: row.row_id,
      siteLabel: row.site_label,
      summaryText: buildPendingPurchaseApprovalSummary(itemLabel, row.site_label, decision),
    }
  })

  return [...proposalItems, ...pendingPurchaseItems]
    .sort((left, right) => {
      const timeDelta = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      if (timeDelta !== 0) {
        return timeDelta
      }
      return right.eventId - left.eventId
    })
    .slice(0, sectionLimit)
}

function buildProposalBatchSummary(input: {
  generatedGroupCount: number | null
  generatedLineItemCount: number | null
  requestedGroupCount: number | null
  rowCount: number
  source: CatalogHistoryProposalBatchItem['source']
  status: CatalogHistoryProposalBatchItem['status']
  summaryJson: JsonValue
  type: CatalogHistoryProposalBatchItem['type']
}): string {
  const errorMessage = readStringField(input.summaryJson, 'error')
  if (errorMessage) {
    return errorMessage
  }

  if (input.source === 'import') {
    return `Imported ${pluralize(input.rowCount, 'group')} into the ${input.type} review queue.`
  }

  const requestedLabel = input.requestedGroupCount ?? input.generatedGroupCount ?? input.rowCount
  const lineItemLabel = input.generatedLineItemCount ?? input.rowCount
  if (input.status === 'draft') {
    return `Queued ${input.type} generation for ${pluralize(requestedLabel, 'group')}.`
  }

  return `Generated ${input.type} proposals for ${pluralize(requestedLabel, 'group')} and ${pluralize(lineItemLabel, 'line item')}.`
}

function buildWriteOperationSummary(row: WriteOperationHistoryRow): string {
  if (row.status === 'verified_mismatch') {
    return `Verification mismatch after ${row.operation_type} for ${row.group_name}.`
  }
  if (row.status === 'failed') {
    return row.error ?? `${capitalize(row.operation_type)} failed for ${row.group_name}.`
  }
  if (row.status === 'queued') {
    return `Queued ${row.operation_type} for ${row.group_name}.`
  }
  if (row.status === 'running') {
    return `Running ${row.operation_type} for ${row.group_name}.`
  }

  return `${capitalize(row.operation_type)} succeeded for ${row.group_name}.`
}

function buildPendingPurchasePacketSummary(row: PendingPurchasePacketHistoryRow): string {
  const summaryFromJson = readStringField(row.summary_json, 'summary')
  if (summaryFromJson) {
    return summaryFromJson
  }

  const siteLabel = row.site_labels_json.length > 0 ? row.site_labels_json.join(', ') : 'configured sites'
  if (row.source === 'generated') {
    return `Generated ${pluralize(row.row_count, 'pending-purchase row')} across ${siteLabel}.`
  }

  return `Imported ${pluralize(row.row_count, 'pending-purchase row')} into ${row.packet_title}.`
}

function buildPendingPurchaseApplySummary(row: PendingPurchaseApplyHistoryRow): string {
  const summaryText = readStringField(row.summary_json, 'summaryText')
  if (summaryText) {
    return summaryText
  }
  if (row.status === 'queued') {
    return `Queued apply for ${pluralize(row.selected_row_count, 'approved row')}.`
  }
  if (row.status === 'running') {
    return `Applying ${pluralize(row.selected_row_count, 'approved row')} from ${row.packet_title}.`
  }

  return [
    `${pluralize(row.applied_row_count, 'row')} applied`,
    `${pluralize(row.blocked_row_count, 'row')} blocked`,
    `${pluralize(row.failed_row_count, 'row')} failed`,
  ].join(' · ')
}

function buildProposalApprovalSummary(
  itemLabel: string,
  fieldPath: string | null,
  decision: CatalogHistoryApprovalItem['decision'],
): string {
  const fieldLabel = fieldPath ?? 'proposal field'
  if (decision === 'approved') {
    return `Approved ${fieldLabel} for ${itemLabel}.`
  }

  return `Rejected ${fieldLabel} for ${itemLabel}.`
}

function buildPendingPurchaseApprovalSummary(
  itemLabel: string,
  siteLabel: string | null,
  decision: CatalogHistoryApprovalItem['decision'],
): string {
  const scopedItemLabel = siteLabel ? `${itemLabel} (${siteLabel})` : itemLabel
  if (decision === 'approved') {
    return `Approved ${scopedItemLabel} for live apply.`
  }
  if (decision === 'rejected') {
    return `Rejected ${scopedItemLabel}.`
  }

  return `Returned ${scopedItemLabel} to pending review.`
}

function normalizeApprovalDecision(value: string | null): CatalogHistoryApprovalItem['decision'] {
  switch (value) {
    case 'approved':
    case 'rejected':
      return value
    default:
      return 'pending'
  }
}

function readCatalogGroupCountFromConfig(value: JsonValue): number | null {
  const objectValue = readObjectValue(value)
  const catalogGroupIds = objectValue?.catalogGroupIds
  if (!Array.isArray(catalogGroupIds)) {
    return null
  }

  return catalogGroupIds.length
}

function readIntegerField(value: JsonValue, key: string): number | null {
  const objectValue = readObjectValue(value)
  const candidate = objectValue?.[key]
  return typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : null
}

function readStringField(value: JsonValue, key: string): string | null {
  const objectValue = readObjectValue(value)
  const candidate = objectValue?.[key]
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : null
}

function readObjectValue(value: JsonValue): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value
}
