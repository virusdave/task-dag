import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../pool.js'
import { insertAnnotation, listAnnotations, retractAnnotation } from './annotationsQueries.js'

function buildMockDb(rows: Array<Record<string, unknown>>): { db: Queryable; calls: Array<{ text: string; params: unknown[] | undefined }> } {
  const calls: Array<{ text: string; params: unknown[] | undefined }> = []
  const db: Queryable = {
    async query<TResult extends QueryResultRow>(text: string, params?: unknown[]) {
      calls.push({ text, params })
      return {
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: rows.length,
        rows: rows as unknown as TResult[],
      } as QueryResult<TResult>
    },
  }
  return { db, calls }
}

const baseRow = {
  id: 3,
  module_code: 'catalog',
  scope_kind: 'catalog_brand',
  scope_ref: { id: 42 },
  kind: 'mso',
  body: 'MSO context here',
  author_user_id: 11,
  author_label: 'Alice',
  created_at: new Date('2026-05-05T00:00:00.000Z'),
  updated_at: new Date('2026-05-05T00:00:00.000Z'),
  retracted_at: null,
}

describe('annotationsQueries', () => {
  it('insertAnnotation binds module + scope + kind + body + author', async () => {
    const { db, calls } = buildMockDb([baseRow])
    const result = await insertAnnotation(db, {
      module: 'catalog',
      scopeKind: 'catalog_brand',
      scopeRef: { id: 42 },
      kind: 'mso',
      body: 'MSO context here',
      authorUserId: 11,
    })
    expect(result.kind).toBe('mso')
    expect(result.id).toBe(3)
    expect(calls[0].params).toEqual([
      'catalog',
      'catalog_brand',
      JSON.stringify({ id: 42 }),
      'mso',
      'MSO context here',
      11,
    ])
  })

  it('listAnnotations filters by kind when provided and excludes retracted by default', async () => {
    const { db, calls } = buildMockDb([baseRow])
    await listAnnotations(db, {
      module: 'catalog',
      scopeKind: 'catalog_brand',
      scopeId: '42',
      kind: 'mso',
    })
    expect(calls[0].text).toContain('a.kind = $4')
    expect(calls[0].text).toContain('a.retracted_at is null')
  })

  it('retractAnnotation returns null when not found', async () => {
    const { db } = buildMockDb([])
    const result = await retractAnnotation(db, 9999, 11)
    expect(result).toBeNull()
  })

  it('retractAnnotation returns the retracted record when found', async () => {
    const retracted = { ...baseRow, retracted_at: new Date('2026-05-05T01:00:00.000Z') }
    const { db } = buildMockDb([retracted])
    const result = await retractAnnotation(db, 3, 11)
    expect(result?.retractedAt).not.toBeNull()
  })
})
