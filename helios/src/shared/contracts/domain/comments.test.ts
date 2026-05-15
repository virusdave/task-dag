import { describe, expect, it } from 'vitest'

import {
  AnnotationRecordSchema,
  CommentRecordSchema,
  ScopeRefSchema,
  CommentsCreateBodySchema,
  AnnotationsCreateBodySchema,
} from '../index.js'

describe('ScopeRefSchema', () => {
  it('accepts a numeric id', () => {
    expect(ScopeRefSchema.parse({ id: 42 })).toEqual({ id: 42 })
  })

  it('accepts a string id with brand and item context', () => {
    expect(
      ScopeRefSchema.parse({ id: 'abc', brandId: 17, itemKey: 'sku-1' }),
    ).toEqual({ id: 'abc', brandId: 17, itemKey: 'sku-1' })
  })

  it('rejects an empty id string', () => {
    expect(() => ScopeRefSchema.parse({ id: '' })).toThrow()
  })
})

describe('CommentRecordSchema', () => {
  it('parses a valid comment record', () => {
    const result = CommentRecordSchema.parse({
      id: 1,
      module: 'catalog',
      scopeKind: 'catalog_brand',
      scopeRef: { id: 42 },
      body: 'hello',
      authorUserId: 11,
      authorLabel: 'Alice',
      createdAt: '2026-05-05T00:00:00Z',
      updatedAt: '2026-05-05T00:00:00Z',
      deletedAt: null,
    })
    expect(result.body).toBe('hello')
  })
})

describe('AnnotationRecordSchema', () => {
  it('parses a valid mso annotation', () => {
    const result = AnnotationRecordSchema.parse({
      id: 1,
      module: 'catalog',
      scopeKind: 'catalog_brand',
      scopeRef: { id: 42 },
      kind: 'mso',
      body: 'MSO note',
      authorUserId: 11,
      authorLabel: 'Alice',
      createdAt: '2026-05-05T00:00:00Z',
      updatedAt: '2026-05-05T00:00:00Z',
      retractedAt: null,
    })
    expect(result.kind).toBe('mso')
  })

  it('rejects an invalid kind', () => {
    expect(() =>
      AnnotationRecordSchema.parse({
        id: 1,
        module: 'catalog',
        scopeKind: 'catalog_brand',
        scopeRef: { id: 42 },
        kind: 'not-a-kind',
        body: 'oops',
        authorUserId: null,
        authorLabel: null,
        createdAt: '2026-05-05T00:00:00Z',
        updatedAt: '2026-05-05T00:00:00Z',
        retractedAt: null,
      }),
    ).toThrow()
  })
})

describe('CommentsCreateBodySchema', () => {
  it('accepts a minimal valid body', () => {
    const parsed = CommentsCreateBodySchema.parse({
      module: 'catalog',
      scopeKind: 'pending_purchase_row',
      scopeRef: { id: 9 },
      body: 'Looks fine',
    })
    expect(parsed.body).toBe('Looks fine')
  })

  it('rejects an empty body', () => {
    expect(() =>
      CommentsCreateBodySchema.parse({
        module: 'catalog',
        scopeKind: 'pending_purchase_row',
        scopeRef: { id: 9 },
        body: '   ',
      }),
    ).toThrow()
  })
})

describe('AnnotationsCreateBodySchema', () => {
  it('requires kind', () => {
    expect(() =>
      AnnotationsCreateBodySchema.parse({
        module: 'catalog',
        scopeKind: 'catalog_brand',
        scopeRef: { id: 42 },
        body: 'no kind',
      }),
    ).toThrow()
  })
})
