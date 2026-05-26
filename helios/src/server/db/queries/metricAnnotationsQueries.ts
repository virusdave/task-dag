import type { QueryResultRow } from 'pg'

import {
  MetricAnnotationRecordSchema,
  type MetricAnnotationRecord,
  type MetricAnnotationScope,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'

interface MetricAnnotationRow extends QueryResultRow {
  id: string
  author: string
  created_at: Date
  updated_at: Date
  t_start: Date
  t_end: Date | null
  title: string
  body: string
  tag: string | null
  scope: string
  deleted_at: Date | null
}

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}

function mapRow(row: MetricAnnotationRow): MetricAnnotationRecord {
  return MetricAnnotationRecordSchema.parse({
    id: row.id,
    author: row.author,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    tStart: row.t_start.toISOString(),
    tEnd: toIso(row.t_end),
    title: row.title,
    body: row.body,
    tag: row.tag,
    scope: row.scope,
    deletedAt: toIso(row.deleted_at),
  })
}

const SELECT_COLUMNS = `
  id, author, created_at, updated_at, t_start, t_end,
  title, body, tag, scope, deleted_at
`

export interface ListMetricAnnotationsInput {
  from?: Date | null
  to?: Date | null
  scope?: MetricAnnotationScope | null
  includeDeleted?: boolean
}

/**
 * List annotations whose `[t_start, coalesce(t_end, t_start)]` range
 * intersects the `[from, to]` window. Both bounds are optional — an
 * unbounded read returns every (non-deleted) annotation.
 *
 * Range-vs-range overlap test:
 *   row_range ∩ filter_range ≠ ∅
 *   ⇔ row.t_start <= filter.to AND coalesce(row.t_end, row.t_start) >= filter.from
 */
export async function listMetricAnnotations(
  db: Queryable,
  input: ListMetricAnnotationsInput,
): Promise<MetricAnnotationRecord[]> {
  const conditions: string[] = []
  const params: unknown[] = []
  if (!input.includeDeleted) {
    conditions.push('deleted_at is null')
  }
  if (input.scope) {
    params.push(input.scope)
    conditions.push(`scope = $${params.length}`)
  }
  if (input.to) {
    params.push(input.to)
    conditions.push(`t_start <= $${params.length}`)
  }
  if (input.from) {
    params.push(input.from)
    conditions.push(`coalesce(t_end, t_start) >= $${params.length}`)
  }
  const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''
  const sql = `select ${SELECT_COLUMNS} from metric_annotations ${where} order by t_start asc, id asc`
  const result = await db.query<MetricAnnotationRow>(sql, params)
  return result.rows.map(mapRow)
}

export interface InsertMetricAnnotationInput {
  author: string
  tStart: Date
  tEnd: Date | null
  title: string
  body: string
  tag: string | null
  scope: MetricAnnotationScope
}

export async function insertMetricAnnotation(
  db: Queryable,
  input: InsertMetricAnnotationInput,
): Promise<MetricAnnotationRecord> {
  const result = await db.query<MetricAnnotationRow>(
    `insert into metric_annotations
       (author, t_start, t_end, title, body, tag, scope)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${SELECT_COLUMNS}`,
    [input.author, input.tStart, input.tEnd, input.title, input.body, input.tag, input.scope],
  )
  const row = result.rows[0]
  if (!row) {
    throw new Error('metric_annotations insert returned no row')
  }
  return mapRow(row)
}

export interface PatchMetricAnnotationInput {
  tStart?: Date
  tEnd?: Date | null
  title?: string
  body?: string
  tag?: string | null
  scope?: MetricAnnotationScope
}

export async function patchMetricAnnotation(
  db: Queryable,
  id: string,
  input: PatchMetricAnnotationInput,
): Promise<MetricAnnotationRecord | null> {
  const sets: string[] = []
  const params: unknown[] = []
  function setField(column: string, value: unknown): void {
    params.push(value)
    sets.push(`${column} = $${params.length}`)
  }
  if (input.tStart !== undefined) setField('t_start', input.tStart)
  if (input.tEnd !== undefined) setField('t_end', input.tEnd)
  if (input.title !== undefined) setField('title', input.title)
  if (input.body !== undefined) setField('body', input.body)
  if (input.tag !== undefined) setField('tag', input.tag)
  if (input.scope !== undefined) setField('scope', input.scope)
  if (sets.length === 0) {
    // No-op patch — just return the current row.
    return getMetricAnnotationById(db, id)
  }
  setField('updated_at', new Date())
  params.push(id)
  const sql = `update metric_annotations set ${sets.join(', ')}
               where id = $${params.length} and deleted_at is null
               returning ${SELECT_COLUMNS}`
  const result = await db.query<MetricAnnotationRow>(sql, params)
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

/**
 * Soft-delete. Returns `true` if a non-deleted row matched and was
 * marked deleted, `false` if the id was unknown or already deleted.
 */
export async function softDeleteMetricAnnotation(
  db: Queryable,
  id: string,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update metric_annotations
        set deleted_at = now(), updated_at = now()
      where id = $1 and deleted_at is null
      returning id`,
    [id],
  )
  return result.rowCount !== null && result.rowCount > 0
}

export async function getMetricAnnotationById(
  db: Queryable,
  id: string,
): Promise<MetricAnnotationRecord | null> {
  const result = await db.query<MetricAnnotationRow>(
    `select ${SELECT_COLUMNS} from metric_annotations where id = $1`,
    [id],
  )
  const row = result.rows[0]
  return row ? mapRow(row) : null
}
