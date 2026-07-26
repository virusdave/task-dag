import { describe, expect, it } from 'vitest'

import {
  orderedRefinementScope,
  refinementScopeLimit,
  updateRefinementScope,
} from './PendingPurchasesPage.js'

describe('pending-purchase refinement scope selection', () => {
  it('unions a whole family with individual rows and deduplicates overlaps', () => {
    const family = ['family-1', 'family-2', 'family-3']
    const withFamily = updateRefinementScope(new Set(), family, true, 30)
    expect(withFamily).not.toBeNull()
    const withIndividuals = updateRefinementScope(withFamily!, ['family-2', 'other-1', 'other-2'], true, 30)

    expect([...withIndividuals!]).toEqual(['family-1', 'family-2', 'family-3', 'other-1', 'other-2'])
  })

  it('removes included family rows without removing unrelated selections', () => {
    const selected = new Set(['family-1', 'family-2', 'other-1'])
    const next = updateRefinementScope(selected, ['family-1', 'family-2', 'family-3'], false, 30)

    expect([...next!]).toEqual(['other-1'])
  })

  it('rejects additions above the cap while removals remain available', () => {
    const thirty = new Set(Array.from({ length: 30 }, (_, index) => `row-${index}`))
    expect(updateRefinementScope(thirty, ['row-30'], true, 30)).toBeNull()
    expect(updateRefinementScope(thirty, ['row-0'], false, 30)?.size).toBe(29)
  })

  it('orders the submitted scope by visible row order and prunes stale ids', () => {
    const rows = [{ rowLineageId: 'row-2' }, { rowLineageId: null }, { rowLineageId: 'row-1' }]
    const selected = new Set(['row-1', 'stale', 'row-2'])

    expect(orderedRefinementScope(rows, selected)).toEqual(['row-2', 'row-1'])
  })

  it('requires a provably smaller retry scope', () => {
    expect(refinementScopeLimit(null, null)).toBe(30)
    expect(refinementScopeLimit('smaller_scope', 12)).toBe(11)
    expect(refinementScopeLimit('smaller_scope', 1)).toBe(0)
    expect(refinementScopeLimit('smaller_scope', null)).toBe(0)
  })
})
