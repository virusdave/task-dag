import { describe, expect, it } from 'vitest'

import { hasSanitizationChange, sanitizationDiff } from './sanitizationDiff.js'

describe('sanitizationDiff', () => {
  it('returns a single equal segment when raw === sanitized', () => {
    const segments = sanitizationDiff('we are open daily', 'we are open daily')
    expect(segments).toEqual([{ kind: 'equal', text: 'we are open daily' }])
    expect(hasSanitizationChange(segments)).toBe(false)
  })

  it('marks removed words that were stripped during sanitizing', () => {
    const segments = sanitizationDiff('buy cannabis flower here', 'buy products here')
    expect(segments).toEqual([
      { kind: 'equal', text: 'buy' },
      { kind: 'removed', text: 'cannabis flower' },
      { kind: 'added', text: 'products' },
      { kind: 'equal', text: 'here' },
    ])
    expect(hasSanitizationChange(segments)).toBe(true)
  })

  it('handles a pure deletion (sanitized drops trailing words)', () => {
    const segments = sanitizationDiff('shop our weed selection', 'shop our selection')
    expect(segments).toEqual([
      { kind: 'equal', text: 'shop our' },
      { kind: 'removed', text: 'weed' },
      { kind: 'equal', text: 'selection' },
    ])
  })

  it('handles a pure addition (sanitized appends words)', () => {
    const segments = sanitizationDiff('order online', 'order online for pickup')
    expect(segments).toEqual([
      { kind: 'equal', text: 'order online' },
      { kind: 'added', text: 'for pickup' },
    ])
  })

  it('treats an empty raw as all-added and empty sanitized as all-removed', () => {
    expect(sanitizationDiff('', 'brand new copy')).toEqual([
      { kind: 'added', text: 'brand new copy' },
    ])
    expect(sanitizationDiff('old copy gone', '')).toEqual([
      { kind: 'removed', text: 'old copy gone' },
    ])
  })

  it('collapses whitespace runs into single-space tokens', () => {
    const segments = sanitizationDiff('a   b\n\tc', 'a b c')
    expect(segments).toEqual([{ kind: 'equal', text: 'a b c' }])
  })

  it('falls back to a coarse removed/added diff when the token product exceeds the cap', () => {
    // ~600 distinct tokens each => 360k cells, over the 250k LCS cap.
    const raw = Array.from({ length: 600 }, (_, i) => `r${i}`).join(' ')
    const sanitized = Array.from({ length: 600 }, (_, i) => `s${i}`).join(' ')
    const segments = sanitizationDiff(raw, sanitized)
    expect(segments).toEqual([
      { kind: 'removed', text: raw },
      { kind: 'added', text: sanitized },
    ])
    expect(hasSanitizationChange(segments)).toBe(true)
  })

  it('preserves all sanitized words in reading order (added segments reconstruct sanitized)', () => {
    const raw = 'our cannabis dispensary sells premium flower and edibles downtown'
    const sanitized = 'our wellness shop sells premium products and treats downtown'
    const segments = sanitizationDiff(raw, sanitized)
    const reconstructedSanitized = segments
      .filter((s) => s.kind !== 'removed')
      .map((s) => s.text)
      .join(' ')
    expect(reconstructedSanitized).toBe(sanitized)
    const reconstructedRaw = segments
      .filter((s) => s.kind !== 'added')
      .map((s) => s.text)
      .join(' ')
    expect(reconstructedRaw).toBe(raw)
  })
})
