import type { QueryResultRow } from 'pg'

import {
  parseCatalogGroupIdFromModuleScope,
  type AuditEntityType,
  type AuditEventType,
  type HeliosModuleCode,
  type HeliosModuleScope,
  type JsonValue,
} from '../../shared/contracts/index.js'
import type { Queryable } from '../db/pool.js'

interface AuditEventInsertRow extends QueryResultRow {
  id: number
}

export interface AppendAuditEventInput {
  actorType: 'system' | 'user'
  actorUserId: number | null
  entityId: string
  entityType: AuditEntityType
  eventType: AuditEventType
  module: HeliosModuleCode
  payload: JsonValue
  requestId: string | null
  scope?: HeliosModuleScope | null
  undoPayload: JsonValue | null
}

export async function appendAuditEvent(
  db: Queryable,
  input: AppendAuditEventInput,
): Promise<number> {
  const catalogGroupId = parseCatalogGroupIdFromModuleScope(input.module, input.scope)

  const result = await db.query<AuditEventInsertRow>(
    `
      insert into audit_events (
        actor_type,
        actor_user_id,
        module_code,
        scope_entity_type,
        scope_entity_id,
        catalog_group_id,
        event_type,
        entity_type,
        entity_id,
        payload_json,
        undo_payload_json,
        request_id
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
      returning id
    `,
    [
      input.actorType,
      input.actorUserId,
      input.module,
      input.scope?.entityType ?? null,
      input.scope?.entityId ?? null,
      catalogGroupId,
      input.eventType,
      input.entityType,
      input.entityId,
      JSON.stringify(input.payload),
      input.undoPayload === null ? null : JSON.stringify(input.undoPayload),
      input.requestId,
    ],
  )

  return result.rows[0].id
}
