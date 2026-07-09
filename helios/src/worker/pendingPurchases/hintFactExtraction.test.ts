import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PendingPurchaseHintExtractedFactsSchema,
  PendingPurchaseHintFactSchema,
} from '../../shared/contracts/index.js'
import {
  extractPendingPurchaseHintFacts,
  inferHintIntentFromKind,
  tryParseSweedPurchaseOrderJson,
} from './hintFactExtraction.js'

// Mutable env the mocked getWorkerEnv returns; reset before each LLM test.
const mockEnv = {
  bedrockMantleBaseUrl: 'https://gateway.test/v1',
  bedrockMantleBearerToken: 'token-test' as string | null,
  llmRequestTimeoutMs: 120_000,
}

vi.mock('../config/env.js', () => ({
  getWorkerEnv: () => mockEnv,
}))

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

describe('extractPendingPurchaseHintFacts — LLM glossary extraction', () => {
  beforeEach(() => {
    mockEnv.bedrockMantleBearerToken = 'token-test'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // The orchestrator makes two LLM calls: intent classification (user payload
  // has {documentKind, hintDocument}) then fact extraction (user payload has
  // {numberedLines}). Route each to the right canned response by payload shape.
  function stubExtractionFetch(
    extractionBody: unknown,
    intent: string = 'free_text_description',
  ) {
    const fetchMock = vi.fn(async (_url: unknown, init: { body: string }) => {
      const request = JSON.parse(init.body) as { messages: Array<{ content: string }> }
      const userPayload = JSON.parse(request.messages[1]?.content ?? '{}') as Record<string, unknown>
      const responseBody = 'numberedLines' in userPayload ? extractionBody : { intent }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(responseBody) } }] }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('persists a glossary-only doc as extracted with cited glossary evidence and zero product facts', async () => {
    stubExtractionFetch({
      facts: [],
      glossary: [
        { term: 'PR', expansion: 'Preroll', note: 'vendor abbreviation', lineStart: 1, lineEnd: 1 },
        {
          term: 'METRC',
          expansion: 'Marijuana Enforcement Tracking Reporting Compliance',
          note: null,
          lineStart: 2,
          lineEnd: 2,
        },
      ],
      warnings: [],
    })

    const outcome = await extractPendingPurchaseHintFacts({
      hintDocumentId: 'pphdoc_2026-06-21_000000_111111',
      kind: 'operator_note',
      rawText: 'PR = Preroll\nMETRC = Marijuana Enforcement Tracking Reporting Compliance',
    })

    expect(outcome.extractionStatus).toBe('extracted')
    expect(outcome.extractionError).toBeNull()
    const facts = outcome.extractedFacts!
    expect(facts.extractor).toBe('llm')
    // A glossary-only document carries evidence, not zero (it is no longer lost).
    expect(facts.facts).toHaveLength(0)
    expect(facts.glossaryEntries).toHaveLength(2)

    const [pr, metrc] = facts.glossaryEntries
    expect(pr!.factId).toBe('f1')
    expect(pr!.term).toBe('PR')
    expect(pr!.expansion).toBe('Preroll')
    expect(pr!.note).toBe('vendor abbreviation')
    // Snippet is derived SERVER-SIDE from the cited source lines.
    expect(pr!.citation.snippet).toBe('PR = Preroll')
    expect(pr!.citation.lineStart).toBe(1)
    expect(pr!.citation.lineEnd).toBe(1)
    expect(metrc!.factId).toBe('f2')
    expect(metrc!.expansion).toBe('Marijuana Enforcement Tracking Reporting Compliance')

    // Round-trips through the persisted contract.
    expect(() => PendingPurchaseHintExtractedFactsSchema.parse(facts)).not.toThrow()
  })

  it('drops glossary entries with a missing or out-of-range citation', async () => {
    stubExtractionFetch({
      facts: [],
      glossary: [
        { term: 'PR', expansion: 'Preroll', note: null, lineStart: 1, lineEnd: 1 },
        // Out-of-range line (the doc has a single line) → dropped, not invented.
        { term: 'FL', expansion: 'Flower', note: null, lineStart: 99, lineEnd: 99 },
        // No citation at all → dropped.
        { term: 'GG', expansion: 'Gorilla Glue', note: null, lineStart: null, lineEnd: null },
      ],
      warnings: [],
    })

    const outcome = await extractPendingPurchaseHintFacts({
      hintDocumentId: 'pphdoc_2026-06-21_000000_222222',
      kind: 'operator_note',
      rawText: 'PR = Preroll',
    })

    expect(outcome.extractionStatus).toBe('extracted')
    const facts = outcome.extractedFacts!
    expect(facts.glossaryEntries).toHaveLength(1)
    expect(facts.glossaryEntries[0]!.term).toBe('PR')
    expect(facts.warnings.join(' ')).toMatch(/glossary entry\(ies\) dropped for missing\/out-of-range/i)
  })

  it('drops a glossary entry that lacks a term or an expansion', async () => {
    stubExtractionFetch({
      facts: [],
      glossary: [
        // Blank expansion normalizes to null → dropped (no inferred expansion).
        { term: 'PR', expansion: '', note: null, lineStart: 1, lineEnd: 1 },
        // Blank term → dropped.
        { term: '', expansion: 'Flower', note: null, lineStart: 1, lineEnd: 1 },
      ],
      warnings: [],
    })

    const outcome = await extractPendingPurchaseHintFacts({
      hintDocumentId: 'pphdoc_2026-06-21_000000_444444',
      kind: 'operator_note',
      rawText: 'PR = Preroll',
    })

    expect(outcome.extractionStatus).toBe('extracted')
    expect(outcome.extractedFacts!.glossaryEntries).toHaveLength(0)
    expect(outcome.extractedFacts!.facts).toHaveLength(0)
    expect(outcome.extractedFacts!.warnings.join(' ')).toMatch(/missing term\/expansion/i)
  })

  it('extracts a mixed product + glossary doc sharing one fN id namespace', async () => {
    stubExtractionFetch(
      {
        facts: [{ itemName: 'Blue Dream Preroll', quantity: 24, quantityBasis: 'ordered_units', lineStart: 2, lineEnd: 2 }],
        glossary: [{ term: 'PR', expansion: 'Preroll', note: null, lineStart: 1, lineEnd: 1 }],
        warnings: [],
      },
      'canonical_sku_list',
    )

    const outcome = await extractPendingPurchaseHintFacts({
      hintDocumentId: 'pphdoc_2026-06-21_000000_333333',
      kind: 'distributor_menu',
      rawText: 'PR = Preroll\nBlue Dream PR x24',
    })

    expect(outcome.extractionStatus).toBe('extracted')
    const facts = outcome.extractedFacts!
    expect(facts.facts).toHaveLength(1)
    expect(facts.facts[0]!.factId).toBe('f1')
    expect(facts.facts[0]!.itemName).toBe('Blue Dream Preroll')
    expect(facts.glossaryEntries).toHaveLength(1)
    // Glossary ids CONTINUE the product-fact namespace so a cited id is unique.
    expect(facts.glossaryEntries[0]!.factId).toBe('f2')
    expect(facts.glossaryEntries[0]!.citation.snippet).toBe('PR = Preroll')

    // The unique-across-both-namespaces contract invariant holds.
    expect(() => PendingPurchaseHintExtractedFactsSchema.parse(facts)).not.toThrow()
  })

  it('extracts an empty glossary when the doc defines no abbreviations', async () => {
    stubExtractionFetch({
      facts: [{ itemName: 'Blue Dream 3.5g', lineStart: 1, lineEnd: 1 }],
      glossary: [],
      warnings: [],
    })

    const outcome = await extractPendingPurchaseHintFacts({
      hintDocumentId: 'pphdoc_2026-06-21_000000_555555',
      kind: 'distributor_menu',
      rawText: 'Blue Dream 3.5g',
    })

    expect(outcome.extractionStatus).toBe('extracted')
    expect(outcome.extractedFacts!.facts).toHaveLength(1)
    expect(outcome.extractedFacts!.glossaryEntries).toEqual([])
  })
})
