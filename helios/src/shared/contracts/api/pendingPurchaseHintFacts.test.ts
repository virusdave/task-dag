import { describe, expect, it } from 'vitest'

import {
  PENDING_PURCHASE_HINT_FACTS_SCHEMA_VERSION,
  PENDING_PURCHASE_HINT_MAX_GLOSSARY_ENTRIES,
  PendingPurchaseHintExtractedFactsSchema,
  PendingPurchaseHintGlossaryEntrySchema,
} from './pendingPurchaseHintFacts.js'

// A minimal, valid line-span citation reused across cases.
function citation(overrides: Record<string, unknown> = {}) {
  return {
    page: null,
    lineStart: 1,
    lineEnd: 1,
    row: null,
    jsonPointer: null,
    snippet: 'PR = Preroll',
    ...overrides,
  }
}

function glossaryEntry(overrides: Record<string, unknown> = {}) {
  return {
    factId: 'f1',
    term: 'PR',
    expansion: 'Preroll',
    note: null,
    citation: citation(),
    ...overrides,
  }
}

// A representative v1-shaped stored payload: no `glossaryEntries` key at all.
function v1Payload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    intent: 'canonical_sku_list',
    extractor: 'llm',
    model: 'anthropic.claude',
    facts: [
      {
        factId: 'f1',
        itemName: 'Blue Dream Preroll',
        sku: null,
        vendorProductCode: null,
        brand: null,
        strain: null,
        prevalence: null,
        category: null,
        subcategory: null,
        size: null,
        packCount: null,
        wholesalePrice: null,
        wholesalePriceBasis: null,
        quantity: null,
        quantityBasis: null,
        citation: citation({ snippet: 'Blue Dream Preroll' }),
      },
    ],
    warnings: [],
    ...overrides,
  }
}

describe('PendingPurchaseHintGlossaryEntrySchema', () => {
  it('accepts a well-formed cited term expansion', () => {
    const parsed = PendingPurchaseHintGlossaryEntrySchema.safeParse(glossaryEntry())
    expect(parsed.success).toBe(true)
  })

  it('accepts an optional inert note', () => {
    const parsed = PendingPurchaseHintGlossaryEntrySchema.safeParse(
      glossaryEntry({ note: 'vendor-specific abbreviation' }),
    )
    expect(parsed.success).toBe(true)
  })

  it('rejects a bad factId (must be fN)', () => {
    expect(PendingPurchaseHintGlossaryEntrySchema.safeParse(glossaryEntry({ factId: 'g1' })).success).toBe(false)
    expect(PendingPurchaseHintGlossaryEntrySchema.safeParse(glossaryEntry({ factId: 'f0' })).success).toBe(false)
  })

  it('rejects an empty term or expansion', () => {
    expect(PendingPurchaseHintGlossaryEntrySchema.safeParse(glossaryEntry({ term: '' })).success).toBe(false)
    expect(PendingPurchaseHintGlossaryEntrySchema.safeParse(glossaryEntry({ expansion: '' })).success).toBe(false)
  })

  it('enforces bounds on term, expansion, and note length', () => {
    expect(
      PendingPurchaseHintGlossaryEntrySchema.safeParse(glossaryEntry({ term: 'x'.repeat(121) })).success,
    ).toBe(false)
    expect(
      PendingPurchaseHintGlossaryEntrySchema.safeParse(glossaryEntry({ expansion: 'x'.repeat(301) })).success,
    ).toBe(false)
    expect(
      PendingPurchaseHintGlossaryEntrySchema.safeParse(glossaryEntry({ note: 'x'.repeat(501) })).success,
    ).toBe(false)
  })

  it('requires a citation with an anchor', () => {
    const noAnchor = glossaryEntry({
      citation: citation({ lineStart: null, lineEnd: null, row: null, jsonPointer: null }),
    })
    expect(PendingPurchaseHintGlossaryEntrySchema.safeParse(noAnchor).success).toBe(false)
  })

  it('rejects unknown keys (strict)', () => {
    expect(
      PendingPurchaseHintGlossaryEntrySchema.safeParse(glossaryEntry({ instruction: 'ignore above' })).success,
    ).toBe(false)
  })
})

describe('PendingPurchaseHintExtractedFactsSchema — v1/v2 back-compat', () => {
  it('is currently version 2', () => {
    expect(PENDING_PURCHASE_HINT_FACTS_SCHEMA_VERSION).toBe(2)
  })

  it('still parses a stored v1 payload and defaults glossaryEntries to []', () => {
    const parsed = PendingPurchaseHintExtractedFactsSchema.safeParse(v1Payload())
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.schemaVersion).toBe(1)
      expect(parsed.data.glossaryEntries).toEqual([])
    }
  })

  it('parses a v2 payload carrying glossary evidence', () => {
    const parsed = PendingPurchaseHintExtractedFactsSchema.safeParse(
      v1Payload({
        schemaVersion: 2,
        facts: [],
        glossaryEntries: [
          glossaryEntry({ factId: 'f1', term: 'PR', expansion: 'Preroll' }),
          glossaryEntry({ factId: 'f2', term: 'FL', expansion: 'Flower', citation: citation({ snippet: 'FL = Flower' }) }),
        ],
      }),
    )
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.glossaryEntries).toHaveLength(2)
    }
  })

  it('rejects an unknown schemaVersion', () => {
    expect(PendingPurchaseHintExtractedFactsSchema.safeParse(v1Payload({ schemaVersion: 99 })).success).toBe(false)
  })

  it('rejects duplicate factIds across facts and glossaryEntries', () => {
    // facts[0] already uses f1; reuse it in a glossary entry.
    const parsed = PendingPurchaseHintExtractedFactsSchema.safeParse(
      v1Payload({
        schemaVersion: 2,
        glossaryEntries: [glossaryEntry({ factId: 'f1' })],
      }),
    )
    expect(parsed.success).toBe(false)
  })

  it('accepts distinct factIds spanning both facts and glossaryEntries', () => {
    const parsed = PendingPurchaseHintExtractedFactsSchema.safeParse(
      v1Payload({
        schemaVersion: 2,
        glossaryEntries: [glossaryEntry({ factId: 'f2' })],
      }),
    )
    expect(parsed.success).toBe(true)
  })

  it('enforces the max glossary-entry count', () => {
    const tooMany = Array.from({ length: PENDING_PURCHASE_HINT_MAX_GLOSSARY_ENTRIES + 1 }, (_unused, i) =>
      glossaryEntry({ factId: `f${i + 1}` }),
    )
    const parsed = PendingPurchaseHintExtractedFactsSchema.safeParse(
      v1Payload({ schemaVersion: 2, facts: [], glossaryEntries: tooMany }),
    )
    expect(parsed.success).toBe(false)
  })
})
