import { describe, expect, it } from 'vitest'

import { summarizeMapping } from './catalogFamilyMarketMatchQueries.js'

// The mapping roll-up is the honest brand-mapping surface for the T2 audit
// header (issue #58): it must never silently collapse a mixed / unmapped family
// into a reassuring "mapped".
describe('summarizeMapping', () => {
  it('reports no-brand when there are no spellings', () => {
    expect(summarizeMapping([])).toBe('no-brand')
  })

  it('passes through a single uniform state', () => {
    expect(summarizeMapping([{ state: 'mapped' }])).toBe('mapped')
    expect(summarizeMapping([{ state: 'mapped' }, { state: 'mapped' }])).toBe('mapped')
    expect(summarizeMapping([{ state: 'operator-says-none' }])).toBe('operator-says-none')
  })

  it('treats any single unmapped-ish state (non mapped / non explicit-null) as unmapped', () => {
    expect(summarizeMapping([{ state: 'unmapped' }])).toBe('unmapped')
  })

  it('reports mixed when spellings disagree', () => {
    expect(summarizeMapping([{ state: 'mapped' }, { state: 'unmapped' }])).toBe('mixed')
    expect(summarizeMapping([{ state: 'mapped' }, { state: 'operator-says-none' }])).toBe('mixed')
  })
})
