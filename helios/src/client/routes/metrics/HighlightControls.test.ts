// Unit tests for the pure `buildStructuredHighlightMatcher` helper
// shipped from `HighlightControls.tsx`. We DON'T import the React
// component here — those would need jsdom — and the only behaviour the
// task spec asks us to lock down is the matcher's truth table:
//   * empty selection + empty free-text → null
//   * AND across two dimensions
//   * OR within a dimension
//   * combination with free-text AND
import { describe, expect, it } from 'vitest'
import {
  buildStructuredHighlightMatcher,
  type HighlightDimensionSpec,
  type HighlightSelectionState,
} from './HighlightControls.js'

interface FakePoint {
  readonly id: string
  readonly brand: string
  readonly size: string
}

const brandDim: HighlightDimensionSpec<FakePoint> = {
  id: 'brand',
  label: 'Brand',
  getOptions: () => [],
  pointKey: (p) => [p.brand],
}

const sizeDim: HighlightDimensionSpec<FakePoint> = {
  id: 'size',
  label: 'Size',
  getOptions: () => [],
  pointKey: (p) => [p.size],
}

const DIMS = [brandDim, sizeDim] as const

const state = (entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]>): HighlightSelectionState =>
  new Map(entries.map(([k, vs]) => [k, new Set(vs)]))

const cresco1g: FakePoint = { id: 'a', brand: 'cresco', size: '1g' }
const cresco35g: FakePoint = { id: 'b', brand: 'cresco', size: '3.5g' }
const stiiizy1g: FakePoint = { id: 'c', brand: 'stiiizy', size: '1g' }
const cookies1g: FakePoint = { id: 'd', brand: 'cookies', size: '1g' }

describe('buildStructuredHighlightMatcher', () => {
  it('returns null when no chips picked and free-text is empty', () => {
    expect(buildStructuredHighlightMatcher(DIMS, state([]), '')).toBeNull()
    expect(buildStructuredHighlightMatcher(DIMS, state([]), '   ')).toBeNull()
  })

  it('treats a dim with an empty selection set the same as no entry', () => {
    // Defensive: a caller could plausibly leave a dimension key in
    // the map after the user un-toggled its last chip. The matcher
    // must still consider that dimension non-constraining.
    expect(
      buildStructuredHighlightMatcher(DIMS, state([['brand', []]]), ''),
    ).toBeNull()
  })

  it('ANDs across two dimensions: Brand=cresco AND Size=1g', () => {
    const m = buildStructuredHighlightMatcher(
      DIMS,
      state([
        ['brand', ['cresco']],
        ['size', ['1g']],
      ]),
      '',
    )
    expect(m).not.toBeNull()
    expect(m!(cresco1g)).toBe(true)
    expect(m!(cresco35g)).toBe(false) // cresco but wrong size
    expect(m!(stiiizy1g)).toBe(false) // 1g but wrong brand
    expect(m!(cookies1g)).toBe(false) // neither
  })

  it('ORs within a single dimension: Brand∈{cresco, stiiizy}', () => {
    const m = buildStructuredHighlightMatcher(
      DIMS,
      state([['brand', ['cresco', 'stiiizy']]]),
      '',
    )
    expect(m).not.toBeNull()
    expect(m!(cresco1g)).toBe(true)
    expect(m!(cresco35g)).toBe(true)
    expect(m!(stiiizy1g)).toBe(true)
    expect(m!(cookies1g)).toBe(false)
  })

  it('ANDs the free-text matcher with the structured matcher', () => {
    // Brand=cresco (structured) AND free-text "1g"
    const m = buildStructuredHighlightMatcher(
      DIMS,
      state([['brand', ['cresco']]]),
      '1g',
    )
    expect(m).not.toBeNull()
    expect(m!(cresco1g)).toBe(true)
    expect(m!(cresco35g)).toBe(false) // free-text fails (no "1g")
    expect(m!(stiiizy1g)).toBe(false) // structured fails (wrong brand)
  })

  it('free-text alone activates the matcher with substring + multi-term AND semantics', () => {
    const m = buildStructuredHighlightMatcher(DIMS, state([]), 'cresco 1g')
    expect(m).not.toBeNull()
    expect(m!(cresco1g)).toBe(true) // both terms present
    expect(m!(cresco35g)).toBe(false) // "1g" missing
    expect(m!(stiiizy1g)).toBe(false) // "cresco" missing
  })

  it('free-text is case-insensitive', () => {
    const m = buildStructuredHighlightMatcher(DIMS, state([]), 'CRESCO')!
    expect(m(cresco1g)).toBe(true)
    expect(m(stiiizy1g)).toBe(false)
  })
})
