import { describe, expect, it } from 'vitest'

import { compileSeoBundle } from './compile.js'
import type { FaqSet } from './contracts.js'
import {
  buildFaqHybridBundleInput,
  FB_NYC_FAQ_ROUTE,
  FB_NYC_FAQ_WIDGET_ID,
} from './faqHybridSyncBundleInput.js'

function globalFaqSet(overrides: Partial<FaqSet> = {}): FaqSet {
  return {
    faq_set_id: 'faq_global_01',
    scope: 'all',
    approval_id: 'appr_global_01',
    items: [
      {
        question: 'How does the rewards program work?',
        answer_raw: 'You earn points per dollar on cannabis purchases.',
        answer_sanitized: 'You earn points per dollar on purchases.',
      },
    ],
    ...overrides,
  }
}

describe('buildFaqHybridBundleInput', () => {
  it('places the global loyalty-FAQ widget when the global set is approved', () => {
    const set = globalFaqSet()
    const input = buildFaqHybridBundleInput({
      approvedFaqSets: [set],
      globalFaqSetId: set.faq_set_id,
    })

    expect(input.widgets).toHaveLength(1)
    const widget = input.widgets[0]!
    expect(widget.widget_id).toBe(FB_NYC_FAQ_WIDGET_ID)
    expect(widget.type).toBe('SEOFAQFold')
    // Widget scope must match the set scope (consistency.ts) and the route
    // is the canonical loyalty-faq route.
    expect(widget.scope).toBe('all')
    if (widget.type === 'SEOFAQFold') {
      expect(widget.faq_set_id).toBe(set.faq_set_id)
      expect(widget.route_patterns).toEqual([FB_NYC_FAQ_ROUTE])
    }
    expect(input.content.faq_sets).toEqual([set])
    expect(input.policy.rules).toEqual([])
  })

  it('compiles to a cross-consistent bundle (no dangling refs)', () => {
    const set = globalFaqSet()
    const input = buildFaqHybridBundleInput({
      approvedFaqSets: [set],
      globalFaqSetId: set.faq_set_id,
    })
    // compileSeoBundle runs the full consistency check; it throws on any
    // dangling ref / scope mismatch.
    expect(() => compileSeoBundle(input)).not.toThrow()
  })

  it('omits the widget when the global set is not approved (null id)', () => {
    const input = buildFaqHybridBundleInput({
      approvedFaqSets: [],
      globalFaqSetId: null,
    })
    expect(input.widgets).toEqual([])
    expect(() => compileSeoBundle(input)).not.toThrow()
  })

  it('omits the widget when globalFaqSetId is not among the approved sets', () => {
    // e.g. a stale id whose set was edited back to draft after planning.
    const someOtherSet = globalFaqSet({ faq_set_id: 'faq_other_01' })
    const input = buildFaqHybridBundleInput({
      approvedFaqSets: [someOtherSet],
      globalFaqSetId: 'faq_global_missing',
    })
    expect(input.widgets).toEqual([])
    // Still ships the approved set in content (ledger-covered), just no widget.
    expect(input.content.faq_sets).toEqual([someOtherSet])
    expect(() => compileSeoBundle(input)).not.toThrow()
  })
})
