import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../pool.js'
import { insertComment, listComments, softDeleteComment } from './commentsQueries.js'

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
  id: 7,
  module_code: 'catalog',
  scope_kind: 'catalog_brand',
  scope_ref: { id: 42 },
  body: 'hello world',
  author_user_id: 11,
  author_label: 'Alice',
  created_at: new Date('2026-05-05T00:00:00.000Z'),
  updated_at: new Date('2026-05-05T00:00:00.000Z'),
  deleted_at: null,
}

describe('commentsQueries', () => {
  it('insertComment binds module + scope + body + author', async () => {
    const { db, calls } = buildMockDb([baseRow])
    const result = await insertComment(db, {
      module: 'catalog',
      scopeKind: 'catalog_brand',
      scopeRef: { id: 42 },
      body: 'hello world',
      authorUserId: 11,
    })
    expect(result.id).toBe(7)
    expect(result.body).toBe('hello world')
    expect(calls[0].params).toEqual(['catalog', 'catalog_brand', JSON.stringify({ id: 42 }), 'hello world', 11])
  })

  it('listComments filters by module + scopeKind + scopeId and excludes deleted by default', async () => {
    const { db, calls } = buildMockDb([baseRow])
    const result = await listComments(db, {
      module: 'catalog',
      scopeKind: 'catalog_brand',
      scopeId: '42',
    })
    expect(result).toHaveLength(1)
    expect(calls[0].text).toContain('c.module_code = $1')
    expect(calls[0].text).toContain("scope_ref->>'id' = $3")
    expect(calls[0].text).toContain('c.deleted_at is null')
    expect(calls[0].params).toEqual(['catalog', 'catalog_brand', '42'])
  })

  it('listComments includes deleted when requested', async () => {
    const { db, calls } = buildMockDb([baseRow])
    await listComments(db, {
      module: 'catalog',
      scopeKind: 'catalog_brand',
      scopeId: '42',
      includeDeleted: true,
    })
    expect(calls[0].text).not.toContain('c.deleted_at is null')
  })

  it('softDeleteComment returns the soft-deleted record when found', async () => {
    const deletedRow = { ...baseRow, deleted_at: new Date('2026-05-05T01:00:00.000Z') }
    const { db } = buildMockDb([deletedRow])
    const result = await softDeleteComment(db, 7, 11)
    expect(result?.id).toBe(7)
    expect(result?.deletedAt).not.toBeNull()
  })

  it('softDeleteComment returns null when not found', async () => {
    const { db } = buildMockDb([])
    const result = await softDeleteComment(db, 9999, 11)
    expect(result).toBeNull()
  })
})
