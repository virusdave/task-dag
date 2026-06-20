import { describe, expect, it } from 'vitest'

import type { FaqItemInput } from './faqContent.js'
import { buildFaqReviewBundle, resolveFaqReviewPlacement } from './faqReview.js'
import { fbusFaqSourceKey } from './faqSourceKey.js'

// A clean, sanitized-safe FAQ item (no raw-only terms, no .nyc host/brand).
function cleanItem(overrides: Partial<FaqItemInput> = {}): FaqItemInput {
  return {
    question: 'What are your store hours?',
    answer_raw: 'We are open daily from 9am to 9pm at our shop.',
    answer_sanitized: 'We are open daily from 9am to 9pm at our shop.',
    ...overrides,
  }
}

describe('resolveFaqReviewPlacement', () => {
  it('returns no_source_key for a null source key', () => {
    expect(resolveFaqReviewPlacement(null)).toEqual({ kind: 'no_source_key', sourceKey: null })
  })

  it('returns unknown_source_key for an unparseable key', () => {
    expect(resolveFaqReviewPlacement('not a key')).toEqual({
      kind: 'unknown_source_key',
      sourceKey: 'not a key',
    })
  })

  it('returns non_lp_source_key for a valid FBUS key whose slug is not an LP family', () => {
    const key = fbusFaqSourceKey('global')
    expect(resolveFaqReviewPlacement(key)).toEqual({
      kind: 'non_lp_source_key',
      sourceKey: key,
      familySlug: 'global',
    })
  })

  it('resolves an LP family key to its route patterns', () => {
    const key = fbusFaqSourceKey('compare')
    const placement = resolveFaqReviewPlacement(key)
    expect(placement.kind).toBe('lp_family')
    if (placement.kind === 'lp_family') {
      expect(placement.familyId).toBe('compare')
      expect(placement.sourceKey).toBe(key)
      expect(placement.routePatterns.length).toBeGreaterThan(0)
      expect(placement.canonicalRepresentativeRoute).toMatch(/^\//)
      expect(placement.indexabilityPolicy).toBeDefined()
    }
  })
})

describe('buildFaqReviewBundle', () => {
  it('reports a clean, approvable, warning-free set with both JSON-LD previews', () => {
    const items = [cleanItem()]
    const bundle = buildFaqReviewBundle({ items, sourceKey: null })
    expect(bundle.compliance.ok).toBe(true)
    expect(bundle.compliance.problems).toEqual([])
    expect(bundle.governance.ok).toBe(true)
    expect(bundle.governance.problems).toEqual([])
    expect(bundle.sanitizedHostLeakMarkers).toEqual([])
    expect(bundle.preview.rawJsonLd['@type']).toBe('FAQPage')
    expect(bundle.preview.sanitizedJsonLd['@type']).toBe('FAQPage')
  })

  it('flags an empty set as a compliance blocker', () => {
    const bundle = buildFaqReviewBundle({ items: [], sourceKey: null })
    expect(bundle.compliance.ok).toBe(false)
    expect(bundle.compliance.problems.some((p) => p.itemIndex === -1)).toBe(true)
  })

  it('surfaces sanitized-host leak markers on the question and sanitized answer only', () => {
    const items = [
      cleanItem({
        // A cannabis raw-only term leaks into the sanitized answer; the raw
        // answer carries the same term but must NOT be leak-flagged.
        answer_sanitized: 'Browse our cannabis selection online.',
        answer_raw: 'Browse our cannabis selection online.',
      }),
    ]
    const bundle = buildFaqReviewBundle({ items, sourceKey: fbusFaqSourceKey('compare') })
    const fields = bundle.sanitizedHostLeakMarkers.map((m) => m.field)
    expect(fields).toContain('answer_sanitized')
    expect(fields).not.toContain('answer_raw')
    // An FBUS set with a sanitized-answer leak is not approvable.
    expect(bundle.compliance.ok).toBe(false)
  })

  it('reports governance warnings (duplicate question) without them being compliance blockers', () => {
    const items = [cleanItem(), cleanItem()]
    const bundle = buildFaqReviewBundle({ items, sourceKey: null })
    expect(bundle.governance.ok).toBe(false)
    expect(bundle.governance.problems.some((p) => p.category === 'duplicate_question')).toBe(true)
    // Duplicate questions are advisory, not an approval blocker.
    expect(bundle.compliance.ok).toBe(true)
  })
})
