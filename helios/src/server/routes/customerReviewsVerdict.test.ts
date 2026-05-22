import { describe, expect, it } from 'vitest'

import { verdictMakesFreePrerollEligible } from './customerReviews.js'

describe('verdictMakesFreePrerollEligible (issue #13, A4 gating)', () => {
  it('returns true for strong-with-text', () => {
    expect(verdictMakesFreePrerollEligible('strong-with-text', null)).toBe(true)
    expect(verdictMakesFreePrerollEligible('strong-with-text', false)).toBe(true)
    expect(verdictMakesFreePrerollEligible('strong-with-text', true)).toBe(true)
  })

  it('returns true ONLY when verdict=error AND degraded_pass=true', () => {
    expect(verdictMakesFreePrerollEligible('error', true)).toBe(true)
    expect(verdictMakesFreePrerollEligible('error', false)).toBe(false)
    expect(verdictMakesFreePrerollEligible('error', null)).toBe(false)
  })

  it('returns false for any non-eligible verdict', () => {
    for (const verdict of [
      'strong-no-text',
      'lukewarm',
      'negative',
    ] as const) {
      expect(verdictMakesFreePrerollEligible(verdict, true)).toBe(false)
      expect(verdictMakesFreePrerollEligible(verdict, false)).toBe(false)
      expect(verdictMakesFreePrerollEligible(verdict, null)).toBe(false)
    }
  })

  it('returns false when verdict is NULL (gate skipped)', () => {
    expect(verdictMakesFreePrerollEligible(null, null)).toBe(false)
    expect(verdictMakesFreePrerollEligible(null, true)).toBe(false)
  })
})
