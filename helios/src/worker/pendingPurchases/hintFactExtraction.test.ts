import { describe, expect, it } from 'vitest'

import {
  PendingPurchaseHintExtractedFactsSchema,
  PendingPurchaseHintFactSchema,
} from '../../shared/contracts/index.js'
import {
  extractPendingPurchaseHintFacts,
  inferHintIntentFromKind,
  tryParseSweedPurchaseOrderJson,
} from './hintFactExtraction.js'

// A representative Sweed `store.purchase.order.get` position.
function sweedPosition(index: number) {
  return {
    id: 9000 + index,
    distributorProduct: {
      id: 5000 + index,
      name: `Curaleaf Pr(Pre-Roll) Blue Dream ${index}`,
      product: { id: 7000 + index, name: `Blue Dream PR ${index}` },
    },
    orderPositionIntegrationData: { wholesalePrice: 12.5 + index },
    orderPositionQty: 24 + index,
    extendedAmount: (12.5 + index) * (24 + index),
  }
}

describe('inferHintIntentFromKind', () => {
  it('maps each document kind to a deterministic fallback intent', () => {
    expect(inferHintIntentFromKind('sibling_purchase_order')).toBe('ordered_items_expectation')
    expect(inferHintIntentFromKind('distributor_menu')).toBe('canonical_sku_list')
    expect(inferHintIntentFromKind('operator_note')).toBe('free_text_description')
    expect(inferHintIntentFromKind('other')).toBe('free_text_description')
  })
})

describe('tryParseSweedPurchaseOrderJson', () => {
  it('recognizes a bare PO object with positions', () => {
    const json = JSON.stringify({ id: 151113, positions: [sweedPosition(0), sweedPosition(1)] })
    const parsed = tryParseSweedPurchaseOrderJson(json)
    expect(parsed).not.toBeNull()
    expect(parsed?.positions).toHaveLength(2)
  })

  it('unwraps common RPC envelopes ({data}/{result})', () => {
    const json = JSON.stringify({ result: { positions: [sweedPosition(0)] } })
    expect(tryParseSweedPurchaseOrderJson(json)?.positions).toHaveLength(1)
  })

  it('returns null for non-JSON text', () => {
    expect(tryParseSweedPurchaseOrderJson('we ordered a bunch of 2g AIO vapes')).toBeNull()
  })

  it('returns null for JSON without a recognizable positions array', () => {
    expect(tryParseSweedPurchaseOrderJson(JSON.stringify({ foo: 'bar' }))).toBeNull()
    // An array of arbitrary objects without distributorProduct is not a PO.
    expect(tryParseSweedPurchaseOrderJson(JSON.stringify([{ a: 1 }, { b: 2 }]))).toBeNull()
  })

  it('rejects positions that lack a PO-specific field (identity alone is not a PO)', () => {
    const json = JSON.stringify({
      positions: [{ distributorProduct: { id: 5, name: 'Some product' } }],
    })
    expect(tryParseSweedPurchaseOrderJson(json)).toBeNull()
  })

  it('rejects positions that lack product identity (a bare quantity list is not a PO)', () => {
    const json = JSON.stringify({ positions: [{ distributorProduct: {}, qty: 5 }] })
    expect(tryParseSweedPurchaseOrderJson(json)).toBeNull()
  })

  it('does not treat blank-string id/qty as a real PO (no numeric coercion to 0)', () => {
    // Blank strings must NOT coerce to 0 and masquerade as identity + qty.
    const json = JSON.stringify({
      positions: [{ distributorProduct: { id: '' }, qty: '', extendedAmount: '  ' }],
    })
    expect(tryParseSweedPurchaseOrderJson(json)).toBeNull()
  })

  it('preserves a non-numeric string vendor id without coercion', () => {
    const json = JSON.stringify({
      positions: [{ distributorProduct: { id: '00123', name: 'X' }, qty: 2 }],
    })
    const parsed = tryParseSweedPurchaseOrderJson(json)
    expect(parsed).not.toBeNull()
    expect(parsed?.positions[0]?.parsed.distributorProduct?.id).toBe('00123')
  })

  it('preserves the raw (uncoerced) value in the citation snippet', async () => {
    // A zero-padded string id must not be coerced to a number in the snippet.
    const json = JSON.stringify({
      positions: [{ id: 1, distributorProduct: { id: '00123', name: 'Padded id vape' }, qty: 3 }],
    })
    const outcome = await extractPendingPurchaseHintFacts({
      hintDocumentId: 'pphdoc_2026-06-21_000000_eeeeee',
      kind: 'sibling_purchase_order',
      rawText: json,
    })
    const fact = outcome.extractedFacts!.facts[0]!
    expect(fact.citation.snippet).toContain('00123')
  })
})

describe('extractPendingPurchaseHintFacts — deterministic Sweed PO path', () => {
  it('maps every position to a cited fact without calling the LLM', async () => {
    const json = JSON.stringify({ id: 151113, positions: [sweedPosition(0), sweedPosition(1)] })
    const outcome = await extractPendingPurchaseHintFacts({
      hintDocumentId: 'pphdoc_2026-06-21_000000_aaaaaa',
      kind: 'sibling_purchase_order',
      rawText: json,
    })

    expect(outcome.extractionStatus).toBe('extracted')
    expect(outcome.extractionError).toBeNull()
    expect(outcome.hintIntent).toBe('ordered_items_expectation')
    expect(outcome.extractedFacts).not.toBeNull()
    const facts = outcome.extractedFacts!
    expect(facts.extractor).toBe('deterministic-sweed-po')
    expect(facts.model).toBeNull()
    expect(facts.facts).toHaveLength(2)

    const [first] = facts.facts
    expect(first!.factId).toBe('f1')
    expect(first!.itemName).toBe('Curaleaf Pr(Pre-Roll) Blue Dream 0')
    expect(first!.vendorProductCode).toBe('5000')
    expect(first!.wholesalePrice).toBe(12.5)
    expect(first!.wholesalePriceBasis).toBe('unit')
    expect(first!.quantity).toBe(24)
    expect(first!.quantityBasis).toBe('ordered_units')
    expect(first!.citation.jsonPointer).toBe('/positions/0')
    expect(first!.citation.row).toBe(1)
    expect(first!.citation.snippet.length).toBeGreaterThan(0)

    // The whole payload round-trips through the persisted contract.
    expect(() => PendingPurchaseHintExtractedFactsSchema.parse(facts)).not.toThrow()
  })

  it('falls back to the line total when no unit wholesale price is present', async () => {
    const json = JSON.stringify({
      positions: [
        {
          id: 1,
          distributorProduct: { id: 'ABC-1', name: 'Mystery vape' },
          extendedAmount: 240,
        },
      ],
    })
    const outcome = await extractPendingPurchaseHintFacts({
      hintDocumentId: 'pphdoc_2026-06-21_000000_bbbbbb',
      kind: 'sibling_purchase_order',
      rawText: json,
    })
    const fact = outcome.extractedFacts!.facts[0]!
    expect(fact.wholesalePrice).toBe(240)
    expect(fact.wholesalePriceBasis).toBe('line_total')
    expect(fact.vendorProductCode).toBe('ABC-1')
  })

  it('handles many positions deterministically (generative)', async () => {
    for (let count = 1; count <= 25; count += 1) {
      const positions = Array.from({ length: count }, (_, index) => sweedPosition(index))
      const json = JSON.stringify({ positions })
      const outcome = await extractPendingPurchaseHintFacts({
        hintDocumentId: 'pphdoc_2026-06-21_000000_cccccc',
        kind: 'sibling_purchase_order',
        rawText: json,
      })
      expect(outcome.extractionStatus).toBe('extracted')
      const facts = outcome.extractedFacts!.facts
      expect(facts).toHaveLength(count)
      // factIds are sequential f1..fN and each carries a positional citation.
      facts.forEach((fact, index) => {
        expect(fact.factId).toBe(`f${index + 1}`)
        expect(fact.citation.row).toBe(index + 1)
        expect(fact.citation.jsonPointer).toBe(`/positions/${index}`)
      })
    }
  })

  it('skips empty/whitespace-only documents without failing', async () => {
    const outcome = await extractPendingPurchaseHintFacts({
      hintDocumentId: 'pphdoc_2026-06-21_000000_dddddd',
      kind: 'operator_note',
      rawText: '   \n\t  ',
    })
    expect(outcome.extractionStatus).toBe('skipped')
    expect(outcome.extractedFacts).toBeNull()
    expect(outcome.hintIntent).toBe('free_text_description')
  })

  it('fails closed (not a thrown abort) when a Sweed PO exceeds the contract cap', async () => {
    // 5001 positions > the contract's 5000-fact cap: the deterministic path
    // must return `failed`, not throw and abort the bundle job.
    const positions = Array.from({ length: 5001 }, (_, index) => sweedPosition(index))
    const outcome = await extractPendingPurchaseHintFacts({
      hintDocumentId: 'pphdoc_2026-06-21_000000_ffffff',
      kind: 'sibling_purchase_order',
      rawText: JSON.stringify({ positions }),
    })
    expect(outcome.extractionStatus).toBe('failed')
    expect(outcome.extractedFacts).toBeNull()
    expect(outcome.extractionError).toMatch(/validation/i)
  })
})

describe('PendingPurchaseHintFactSchema contract guards', () => {
  const baseFact = {
    factId: 'f1',
    itemName: 'Blue Dream PR',
    sku: null,
    vendorProductCode: '5000',
    brand: null,
    strain: null,
    prevalence: null,
    category: null,
    subcategory: null,
    size: null,
    packCount: null,
    wholesalePrice: 12.5,
    wholesalePriceBasis: 'unit' as const,
    quantity: 24,
    quantityBasis: 'ordered_units' as const,
    citation: {
      page: null,
      lineStart: null,
      lineEnd: null,
      row: 1,
      jsonPointer: '/positions/0',
      snippet: '{"id":9000}',
    },
  }

  it('accepts a well-formed fact', () => {
    expect(() => PendingPurchaseHintFactSchema.parse(baseFact)).not.toThrow()
  })

  it('rejects a non-sequential / malformed factId', () => {
    expect(() => PendingPurchaseHintFactSchema.parse({ ...baseFact, factId: 'x1' })).toThrow()
    expect(() => PendingPurchaseHintFactSchema.parse({ ...baseFact, factId: 'f0' })).toThrow()
  })

  it('rejects unknown extra fields (strict)', () => {
    expect(() =>
      PendingPurchaseHintFactSchema.parse({ ...baseFact, instruction: 'ignore previous' }),
    ).toThrow()
  })

  it('rejects a negative wholesale price', () => {
    expect(() => PendingPurchaseHintFactSchema.parse({ ...baseFact, wholesalePrice: -1 })).toThrow()
  })

  it('rejects a contentless fact (citation only)', () => {
    const contentless = {
      ...baseFact,
      itemName: null,
      sku: null,
      vendorProductCode: null,
      packCount: null,
      wholesalePrice: null,
      wholesalePriceBasis: null,
      quantity: null,
      quantityBasis: null,
    }
    expect(() => PendingPurchaseHintFactSchema.parse(contentless)).toThrow()
  })

  it('requires price and basis to be both set or both null', () => {
    expect(() =>
      PendingPurchaseHintFactSchema.parse({ ...baseFact, wholesalePrice: 5, wholesalePriceBasis: null }),
    ).toThrow()
    expect(() =>
      PendingPurchaseHintFactSchema.parse({ ...baseFact, wholesalePrice: null, wholesalePriceBasis: 'unit' }),
    ).toThrow()
  })

  it('enforces citation anchor and ordered line span', () => {
    // No anchor at all (all positional fields null) is rejected.
    expect(() =>
      PendingPurchaseHintFactSchema.parse({
        ...baseFact,
        citation: { ...baseFact.citation, row: null, jsonPointer: null },
      }),
    ).toThrow()
    // lineEnd < lineStart is rejected.
    expect(() =>
      PendingPurchaseHintFactSchema.parse({
        ...baseFact,
        citation: { ...baseFact.citation, lineStart: 5, lineEnd: 2, row: null, jsonPointer: null },
      }),
    ).toThrow()
    // A lone lineStart without lineEnd is rejected.
    expect(() =>
      PendingPurchaseHintFactSchema.parse({
        ...baseFact,
        citation: { ...baseFact.citation, lineStart: 3, lineEnd: null },
      }),
    ).toThrow()
  })
})
