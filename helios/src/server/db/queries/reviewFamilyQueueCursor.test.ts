import { describe, expect, it } from 'vitest'

import type { ReviewFamilyQueueQuery } from '../../../shared/contracts/index.js'
import {
  InvalidReviewCursorError,
  decodeReviewCursor,
  encodeReviewCursor,
  hashReviewFilters,
} from './reviewFamilyQueueCursor.js'

function filters(overrides: Partial<ReviewFamilyQueueQuery> = {}): ReviewFamilyQueueQuery {
  return { limit: 12, ...overrides }
}

describe('review family queue cursor', () => {
  it('round-trips a cursor under matching filters', () => {
    const f = filters({ search: 'roapz' })
    const token = encodeReviewCursor({
      hasDrift: true,
      brand: 'Acme',
      category: 'Flower',
      subcategory: 'Indica',
      filters: f,
    })
    const decoded = decodeReviewCursor(token, f)
    expect(decoded).toMatchObject({
      v: 1,
      familyKeyVersion: 1,
      hasDrift: true,
      brand: 'Acme',
      category: 'Flower',
      subcategory: 'Indica',
    })
  })

  it('preserves null brand/category/subcategory distinctly from empty string', () => {
    const f = filters()
    const token = encodeReviewCursor({
      hasDrift: false,
      brand: null,
      category: '',
      subcategory: null,
      filters: f,
    })
    const decoded = decodeReviewCursor(token, f)
    expect(decoded.brand).toBeNull()
    expect(decoded.category).toBe('')
    expect(decoded.subcategory).toBeNull()
  })

  it('rejects a cursor minted under different filters', () => {
    const token = encodeReviewCursor({
      hasDrift: false,
      brand: 'Acme',
      category: null,
      subcategory: null,
      filters: filters({ search: 'a' }),
    })
    expect(() => decodeReviewCursor(token, filters({ search: 'b' }))).toThrow(InvalidReviewCursorError)
  })

  it('treats limit as irrelevant to the cursor lineage', () => {
    const a = hashReviewFilters(filters({ search: 'x', limit: 5 }))
    const b = hashReviewFilters(filters({ search: 'x', limit: 25 }))
    expect(a).toBe(b)
  })

  it('rejects a malformed cursor', () => {
    expect(() => decodeReviewCursor('!!!not-base64-json!!!', filters())).toThrow(InvalidReviewCursorError)
  })

  it('rejects a structurally-invalid cursor payload', () => {
    const bogus = Buffer.from(JSON.stringify({ v: 2, nope: true }), 'utf8').toString('base64url')
    expect(() => decodeReviewCursor(bogus, filters())).toThrow(InvalidReviewCursorError)
  })
})
