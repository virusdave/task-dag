import type { QueryResultRow } from 'pg'

import type { HistoryEventsQuery, HistoryEventsResponse } from '../../../shared/contracts/api/history.js'
import type { JsonValue } from '../../../shared/contracts/common/json.js'
import { isUndoableAuditEventType } from '../../../shared/contracts/domain/undo.js'
import type { Queryable } from '../pool.js'
import { toIsoString } from './helpers.js'

interface HistoryRow extends QueryResultRow {
  actor_label: string
  created_at: Date
  entity_id: string
  entity_type: string
  event_type: string
  has_undo_payload: boolean
  id: number
  module_code: HistoryEventsResponse['items'][number]['module']
  payload_json: JsonValue
  scope_entity_id: string | null
  scope_entity_type: string | null
  undo_event_id: number | null
  undo_status: string | null
}

export async function listHistoryEvents(
  db: Queryable,
  filters: HistoryEventsQuery,
): Promise<HistoryEventsResponse> {
  const { values, whereSql } = buildHistoryWhere(filters)

  const result = await db.query<HistoryRow>(
    `
      select
        ae.id,
        ae.created_at,
        ae.module_code,
        ae.scope_entity_type,
        ae.scope_entity_id,
        ae.entity_type,
        ae.entity_id,
        ae.event_type,
        ae.payload_json,
        ae.undo_payload_json is not null as has_undo_payload,
        coalesce(u.name, ae.actor_type) as actor_label,
        ue.id as undo_event_id,
        ue.status as undo_status
      from audit_events ae
      left join users u on u.id = ae.actor_user_id
      left join undo_events ue on ue.original_event_id = ae.id
      ${whereSql}
      order by ae.created_at desc, ae.id desc
      limit $${values.length + 1}
    `,
    [...values, filters.pageSize],
  )

  const nextCursor = result.rows.length === filters.pageSize
    ? toIsoString(result.rows[result.rows.length - 1].created_at)
    : null

  return {
    filters,
    items: result.rows.map((row) => ({
      actorLabel: row.actor_label,
      createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
      entityId: row.entity_id,
      entityType: row.entity_type as HistoryEventsResponse['items'][number]['entityType'],
      eventId: row.id,
      eventType: row.event_type as HistoryEventsResponse['items'][number]['eventType'],
      module: row.module_code,
      payload: row.payload_json,
      scope: row.scope_entity_type && row.scope_entity_id
        ? {
            entityId: row.scope_entity_id,
            entityType: row.scope_entity_type,
          }
        : null,
      summaryText: buildSummaryText(row),
      undoAvailable: row.undo_event_id === null && row.has_undo_payload && isUndoableAuditEventType(row.event_type),
      undo: row.undo_event_id
        ? { status: normalizeUndoStatus(row.undo_status), undoEventId: row.undo_event_id }
        : null,
    })),
    nextCursor,
  }
}

function buildHistoryWhere(filters: HistoryEventsQuery): { values: unknown[]; whereSql: string } {
  const clauses: string[] = []
  const values: unknown[] = []

  if (filters.entityType) {
    values.push(filters.entityType)
    clauses.push(`ae.entity_type = $${values.length}`)
  }
  if (filters.entityId) {
    values.push(filters.entityId)
    clauses.push(`ae.entity_id = $${values.length}`)
  }
  if (filters.actorUserId) {
    values.push(filters.actorUserId)
    clauses.push(`ae.actor_user_id = $${values.length}`)
  }
  if (filters.eventType) {
    values.push(filters.eventType)
    clauses.push(`ae.event_type = $${values.length}`)
  }
  if (filters.module) {
    values.push(filters.module)
    clauses.push(`ae.module_code = $${values.length}`)
  }
  if (filters.scopeEntityType) {
    values.push(filters.scopeEntityType)
    clauses.push(`ae.scope_entity_type = $${values.length}`)
  }
  if (filters.scopeEntityId) {
    values.push(filters.scopeEntityId)
    clauses.push(`ae.scope_entity_id = $${values.length}`)
  }
  if (filters.beforeCreatedAt) {
    values.push(filters.beforeCreatedAt)
    clauses.push(`ae.created_at < $${values.length}::timestamptz`)
  }

  return {
    values,
    whereSql: clauses.length > 0 ? `where ${clauses.join(' and ')}` : '',
  }
}

function buildSummaryText(row: HistoryRow): string {
  const payload = row.payload_json
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const summary = typeof payload.summary === 'string' ? payload.summary : null
    const fieldPath = typeof payload.fieldPath === 'string' ? payload.fieldPath : null
    const proposalLineItemId = typeof payload.proposalLineItemId === 'number' ? payload.proposalLineItemId : null
    if (summary) {
      return summary
    }
    if (fieldPath && proposalLineItemId) {
      return `${row.event_type} on ${fieldPath} (#${proposalLineItemId})`
    }
  }

  return row.event_type
}

function normalizeUndoStatus(status: string | null): 'completed' | 'failed' | 'queued' | 'running' {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'running':
      return status
    default:
      return 'queued'
  }
}
