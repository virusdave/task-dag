import type { QueryResultRow } from 'pg'

import {
  AnnotationRecordSchema,
  type AnnotationKind,
  type AnnotationRecord,
  type HeliosModuleCode,
  type ScopeKind,
  type ScopeRef,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'

interface AnnotationRow extends QueryResultRow {
  id: number
  module_code: string
  scope_kind: string
  scope_ref: ScopeRef
  kind: string
  body: string
  author_user_id: number | null
  author_label: string | null
  created_at: Date
  updated_at: Date
  retracted_at: Date | null
}

function toIso(value: Date | null): string | null {
  if (!value) {
    return null
  }
  return value.toISOString()
}

function mapAnnotationRow(row: AnnotationRow): AnnotationRecord {
  return AnnotationRecordSchema.parse({
    id: row.id,
    module: row.module_code,
    scopeKind: row.scope_kind,
    scopeRef: row.scope_ref,
    kind: row.kind,
    body: row.body,
    authorUserId: row.author_user_id,
    authorLabel: row.author_label,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    retractedAt: toIso(row.retracted_at),
  })
}

export interface ListAnnotationsInput {
  module: HeliosModuleCode
  scopeKind: ScopeKind
  scopeId: string
  brandId?: string | null
  itemKey?: string | null
  kind?: AnnotationKind | null
  includeRetracted?: boolean
}

const SELECT_ANNOTATIONS = `
  select a.id,
         a.module_code,
         a.scope_kind,
         a.scope_ref,
         a.kind,
         a.body,
         a.author_user_id,
         coalesce(u.name, u.email) as author_label,
         a.created_at,
         a.updated_at,
         a.retracted_at
  from module_annotations a
  left join users u on u.id = a.author_user_id
`

export async function listAnnotations(
  db: Queryable,
  input: ListAnnotationsInput,
): Promise<AnnotationRecord[]> {
  const conditions: string[] = ['a.module_code = $1', 'a.scope_kind = $2', 'a.scope_ref->>\'id\' = $3']
  const params: unknown[] = [input.module, input.scopeKind, input.scopeId]
  if (input.brandId) {
    params.push(input.brandId)
    conditions.push(`a.scope_ref->>'brandId' = $${params.length}`)
  }
  if (input.itemKey) {
    params.push(input.itemKey)
    conditions.push(`a.scope_ref->>'itemKey' = $${params.length}`)
  }
  if (input.kind) {
    params.push(input.kind)
    conditions.push(`a.kind = $${params.length}`)
  }
  if (!input.includeRetracted) {
    conditions.push('a.retracted_at is null')
  }
  const sql = `${SELECT_ANNOTATIONS} where ${conditions.join(' and ')} order by a.created_at asc, a.id asc`
  const result = await db.query<AnnotationRow>(sql, params)
  return result.rows.map(mapAnnotationRow)
}

export interface InsertAnnotationInput {
  module: HeliosModuleCode
  scopeKind: ScopeKind
  scopeRef: ScopeRef
  kind: AnnotationKind
  body: string
  authorUserId: number | null
}

export async function insertAnnotation(
  db: Queryable,
  input: InsertAnnotationInput,
): Promise<AnnotationRecord> {
  const result = await db.query<AnnotationRow>(
    `
      with inserted as (
        insert into module_annotations (module_code, scope_kind, scope_ref, kind, body, author_user_id)
        values ($1, $2, $3::jsonb, $4, $5, $6)
        returning id, module_code, scope_kind, scope_ref, kind, body, author_user_id, created_at, updated_at, retracted_at
      )
      select i.*, coalesce(u.name, u.email) as author_label
      from inserted i
      left join users u on u.id = i.author_user_id
    `,
    [
      input.module,
      input.scopeKind,
      JSON.stringify(input.scopeRef),
      input.kind,
      input.body,
      input.authorUserId,
    ],
  )
  return mapAnnotationRow(result.rows[0])
}

export async function retractAnnotation(
  db: Queryable,
  annotationId: number,
  actingUserId: number,
): Promise<AnnotationRecord | null> {
  const result = await db.query<AnnotationRow>(
    `
      with updated as (
        update module_annotations
        set retracted_at = now()
        where id = $1 and retracted_at is null
        returning id, module_code, scope_kind, scope_ref, kind, body, author_user_id, created_at, updated_at, retracted_at
      )
      select u.*, coalesce(usr.name, usr.email) as author_label
      from updated u
      left join users usr on usr.id = u.author_user_id
    `,
    [annotationId],
  )
  if (!result.rows[0]) {
    return null
  }
  void actingUserId
  return mapAnnotationRow(result.rows[0])
}

export const __test__ = { mapAnnotationRow }
