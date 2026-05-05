import type { QueryResultRow } from 'pg'

import {
  CommentRecordSchema,
  type CommentRecord,
  type HeliosModuleCode,
  type ScopeKind,
  type ScopeRef,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'

interface CommentRow extends QueryResultRow {
  id: number
  module_code: string
  scope_kind: string
  scope_ref: ScopeRef
  body: string
  author_user_id: number | null
  author_label: string | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

function toIso(value: Date | null): string | null {
  if (!value) {
    return null
  }
  return value.toISOString()
}

function mapCommentRow(row: CommentRow): CommentRecord {
  return CommentRecordSchema.parse({
    id: row.id,
    module: row.module_code,
    scopeKind: row.scope_kind,
    scopeRef: row.scope_ref,
    body: row.body,
    authorUserId: row.author_user_id,
    authorLabel: row.author_label,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: toIso(row.deleted_at),
  })
}

export interface ListCommentsInput {
  module: HeliosModuleCode
  scopeKind: ScopeKind
  scopeId: string
  brandId?: string | null
  itemKey?: string | null
  includeDeleted?: boolean
}

const SELECT_COMMENTS = `
  select c.id,
         c.module_code,
         c.scope_kind,
         c.scope_ref,
         c.body,
         c.author_user_id,
         coalesce(u.name, u.email) as author_label,
         c.created_at,
         c.updated_at,
         c.deleted_at
  from module_comments c
  left join users u on u.id = c.author_user_id
`

export async function listComments(db: Queryable, input: ListCommentsInput): Promise<CommentRecord[]> {
  const conditions: string[] = ['c.module_code = $1', 'c.scope_kind = $2', 'c.scope_ref->>\'id\' = $3']
  const params: unknown[] = [input.module, input.scopeKind, input.scopeId]
  if (input.brandId) {
    params.push(input.brandId)
    conditions.push(`c.scope_ref->>'brandId' = $${params.length}`)
  }
  if (input.itemKey) {
    params.push(input.itemKey)
    conditions.push(`c.scope_ref->>'itemKey' = $${params.length}`)
  }
  if (!input.includeDeleted) {
    conditions.push('c.deleted_at is null')
  }
  const sql = `${SELECT_COMMENTS} where ${conditions.join(' and ')} order by c.created_at asc, c.id asc`
  const result = await db.query<CommentRow>(sql, params)
  return result.rows.map(mapCommentRow)
}

export interface InsertCommentInput {
  module: HeliosModuleCode
  scopeKind: ScopeKind
  scopeRef: ScopeRef
  body: string
  authorUserId: number | null
}

export async function insertComment(db: Queryable, input: InsertCommentInput): Promise<CommentRecord> {
  const result = await db.query<CommentRow>(
    `
      with inserted as (
        insert into module_comments (module_code, scope_kind, scope_ref, body, author_user_id)
        values ($1, $2, $3::jsonb, $4, $5)
        returning id, module_code, scope_kind, scope_ref, body, author_user_id, created_at, updated_at, deleted_at
      )
      select i.*, coalesce(u.name, u.email) as author_label
      from inserted i
      left join users u on u.id = i.author_user_id
    `,
    [input.module, input.scopeKind, JSON.stringify(input.scopeRef), input.body, input.authorUserId],
  )
  return mapCommentRow(result.rows[0])
}

export async function softDeleteComment(
  db: Queryable,
  commentId: number,
  actingUserId: number,
): Promise<CommentRecord | null> {
  const result = await db.query<CommentRow>(
    `
      with updated as (
        update module_comments
        set deleted_at = now()
        where id = $1 and deleted_at is null
        returning id, module_code, scope_kind, scope_ref, body, author_user_id, created_at, updated_at, deleted_at
      )
      select u.*, coalesce(usr.name, usr.email) as author_label
      from updated u
      left join users usr on usr.id = u.author_user_id
    `,
    [commentId],
  )
  if (!result.rows[0]) {
    return null
  }
  void actingUserId
  return mapCommentRow(result.rows[0])
}

export const __test__ = { mapCommentRow }
