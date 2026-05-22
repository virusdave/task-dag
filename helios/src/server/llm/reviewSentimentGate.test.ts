import { describe, expect, it } from 'vitest'

import { computeDegradedPass } from './reviewSentimentGate.js'

describe('computeDegradedPass (operator-settled heuristic from issue #13)', () => {
  // Per the issue spec:
  //   degraded_pass = (len(text) >= 50) AND (word_count(text) >= 10)

  it('returns false for short text (length < 50)', () => {
    expect(computeDegradedPass('short')).toBe(false)
    expect(computeDegradedPass('one two three four five six seven eight nine')).toBe(false)
  })

  it('returns false when text is long enough but has too few words', () => {
    // 60+ chars, 1 word (no separators).
    const text = 'x'.repeat(60)
    expect(text.length).toBeGreaterThanOrEqual(50)
    expect(computeDegradedPass(text)).toBe(false)
  })

  it('returns true when both length and word-count thresholds are met', () => {
    const text = 'I had a wonderful time and would recommend this place to anyone visiting nearby.'
    expect(text.length).toBeGreaterThanOrEqual(50)
    expect(text.trim().split(/\s+/).length).toBeGreaterThanOrEqual(10)
    expect(computeDegradedPass(text)).toBe(true)
  })

  it('returns false at exactly the boundary just below 10 words (9 words, > 50 chars)', () => {
    // 9 words, padded out to >50 chars.
    const text = 'one twoo three fourrr five six seven eight nineteenpadding'
    expect(text.length).toBeGreaterThanOrEqual(50)
    expect(text.trim().split(/\s+/).length).toBe(9)
    expect(computeDegradedPass(text)).toBe(false)
  })

  it('counts whitespace-delimited tokens (collapses multiple spaces / newlines)', () => {
    const text = 'I    had   a wonderful  time and would  recommend\n\nthis place to anyone.'
    expect(text.length).toBeGreaterThanOrEqual(50)
    expect(computeDegradedPass(text)).toBe(true)
  })
})
