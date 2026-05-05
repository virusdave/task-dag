import { describe, expect, it } from 'vitest'

import {
  buildHeliosModulePath,
  ScopeKindSchema,
  type ScopeKind,
} from '../../../shared/contracts/index.js'

const SCOPE_KINDS: ScopeKind[] = [
  'proposal_line_item',
  'pending_purchase_row',
  'pending_purchase_packet',
  'proposal_batch',
  'catalog_group',
  'catalog_brand',
  'catalog_item',
  'write_operation',
  'job',
]

describe('review-details route shape', () => {
  it('builds an APP_BASE_PATH-safe url under /catalog/review-details for each scope kind', () => {
    for (const scopeKind of SCOPE_KINDS) {
      const path = buildHeliosModulePath('catalog', `review-details/${scopeKind}/123`)
      expect(path).toBe(`/catalog/review-details/${scopeKind}/123`)
    }
  })

  it('ScopeKindSchema accepts every scope kind we route for', () => {
    for (const scopeKind of SCOPE_KINDS) {
      expect(ScopeKindSchema.parse(scopeKind)).toBe(scopeKind)
    }
  })

  it('ScopeKindSchema rejects unknown scope kinds', () => {
    expect(() => ScopeKindSchema.parse('not-a-scope')).toThrow()
  })
})
