import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Queryable } from '../pool.js'
import {
  deletePendingPurchaseHintDocument,
  loadExtractedPendingPurchaseHintFactsForBundle,
  loadExtractedPendingPurchaseHintGlossaryForBundle,
  loadPendingPurchaseHintOperatorNotesForBundle,
} from './pendingPurchaseHintQueries.js'

// The loader parses every stored `extracted_facts` JSONB blob with the current
// contract. It must keep flattening PRE-EXISTING v1 rows even after the
// contract advanced to v2 — otherwise a version bump would silently drop every
// hint already extracted before the bump. This test feeds the loader raw rows
// (as they come back from JSONB) through a fake Queryable so no DB is needed.

function citation(snippet: string) {
  return { page: null, lineStart: 1, lineEnd: 1, row: null, jsonPointer: null, snippet }
}

function productFact(factId: string, itemName: string) {
  return {
    factId,
    itemName,
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
    citation: citation(itemName),
  }
}

// A stored v1 payload: no `glossaryEntries` key at all (as it was persisted
// before v2 existed).
const v1Facts = {
  schemaVersion: 1,
  intent: 'canonical_sku_list',
  extractor: 'llm',
  model: 'anthropic.claude',
  facts: [productFact('f1', 'Blue Dream Preroll')],
  warnings: [],
}

// A stored v2 payload: product facts PLUS cited glossary evidence.
const v2Facts = {
  schemaVersion: 2,
  intent: 'free_text_description',
  extractor: 'llm',
  model: 'anthropic.claude',
  facts: [productFact('f1', 'Sunset Sherbet Flower')],
  glossaryEntries: [
    { factId: 'f2', term: 'FL', expansion: 'Flower', note: null, citation: citation('FL = Flower') },
  ],
  warnings: [],
}

function fakeDb(rows: Array<Record<string, unknown>>): Queryable {
  return {
    query: vi.fn(async () => ({ rows }) as never),
  }
}

function docRow(hintDocumentId: string, extractedFacts: unknown) {
  return {
    hint_document_id: hintDocumentId,
    bundle_public_id: 'pphbndl_demo',
    kind: 'distributor_menu',
    source_label: null,
    content_sha256: 'a'.repeat(64),
    extracted_facts: extractedFacts,
  }
}

describe('loadExtractedPendingPurchaseHintFactsForBundle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('flattens facts from a stored v1 row after the contract advanced to v2', async () => {
    const db = fakeDb([docRow('pphdoc_2026-06-21_000001_ab12cd', v1Facts)])
    const result = await loadExtractedPendingPurchaseHintFactsForBundle(db, 'pphbndl_demo')
    expect(result).toHaveLength(1)
    expect(result[0]?.fact.factId).toBe('f1')
    expect(result[0]?.fact.itemName).toBe('Blue Dream Preroll')
  })

  it('flattens product facts from a v2 row (glossary evidence is a separate surface)', async () => {
    const db = fakeDb([docRow('pphdoc_2026-06-21_000002_ab12ce', v2Facts)])
    const result = await loadExtractedPendingPurchaseHintFactsForBundle(db, 'pphbndl_demo')
    expect(result).toHaveLength(1)
    expect(result[0]?.fact.factId).toBe('f1')
  })

  it('skips (does not throw) a row whose payload fails the contract', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDb([
      docRow('pphdoc_2026-06-21_000003_ab12cf', { schemaVersion: 99, garbage: true }),
      docRow('pphdoc_2026-06-21_000004_ab12d0', v1Facts),
    ])
    const result = await loadExtractedPendingPurchaseHintFactsForBundle(db, 'pphbndl_demo')
    expect(result).toHaveLength(1)
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('loadExtractedPendingPurchaseHintGlossaryForBundle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('flattens glossary entries from a v2 row with the cited-id context', async () => {
    const db = fakeDb([docRow('pphdoc_2026-06-21_000002_ab12ce', v2Facts)])
    const result = await loadExtractedPendingPurchaseHintGlossaryForBundle(db, 'pphbndl_demo')
    expect(result).toHaveLength(1)
    expect(result[0]?.entry.factId).toBe('f2')
    expect(result[0]?.entry.term).toBe('FL')
    expect(result[0]?.entry.expansion).toBe('Flower')
    expect(result[0]?.hintDocumentId).toBe('pphdoc_2026-06-21_000002_ab12ce')
  })

  it('returns [] for a stored v1 row (no glossaryEntries key)', async () => {
    const db = fakeDb([docRow('pphdoc_2026-06-21_000001_ab12cd', v1Facts)])
    const result = await loadExtractedPendingPurchaseHintGlossaryForBundle(db, 'pphbndl_demo')
    expect(result).toEqual([])
  })

  it('skips (does not throw) a row whose payload fails the contract', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDb([
      docRow('pphdoc_2026-06-21_000003_ab12cf', { schemaVersion: 99, garbage: true }),
      docRow('pphdoc_2026-06-21_000004_ab12d0', v2Facts),
    ])
    const result = await loadExtractedPendingPurchaseHintGlossaryForBundle(db, 'pphbndl_demo')
    expect(result).toHaveLength(1)
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('loadPendingPurchaseHintOperatorNotesForBundle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function operatorNotePointerRow(overrides: Record<string, unknown> = {}) {
    return {
      hint_document_id: 'pphdoc_2026-07-09_013737_186fed',
      source_label: 'operator note',
      content_sha256: '18'.padEnd(64, '6'),
      storage_backend: 'fs',
      storage_uri: 'fs://pending-purchase-hints/18/6f/186fed.txt',
      byte_size: '395',
      ...overrides,
    }
  }

  it('maps each row to a labelled blob pointer (coercing byte_size to a number)', async () => {
    const db = fakeDb([operatorNotePointerRow()])
    const result = await loadPendingPurchaseHintOperatorNotesForBundle(db, 'pphbndl_demo')
    expect(result).toEqual([
      {
        hintDocumentId: 'pphdoc_2026-07-09_013737_186fed',
        sourceLabel: 'operator note',
        pointer: {
          contentSha256: '18'.padEnd(64, '6'),
          storageBackend: 'fs',
          storageUri: 'fs://pending-purchase-hints/18/6f/186fed.txt',
          byteSize: 395,
        },
      },
    ])
    expect(typeof result[0]?.pointer.byteSize).toBe('number')
  })

  it("scopes the query to kind = 'operator_note' (external hints stay untrusted)", async () => {
    const query = vi.fn(async () => ({ rows: [] }) as never)
    const db = { query } as unknown as Queryable
    await loadPendingPurchaseHintOperatorNotesForBundle(db, 'pphbndl_demo')
    const sql = query.mock.calls[0]![0] as string
    expect(sql).toMatch(/kind = 'operator_note'/)
    expect(query.mock.calls[0]![1]).toEqual(['pphbndl_demo'])
  })

  it('returns [] when the bundle has no operator notes', async () => {
    const db = fakeDb([])
    const result = await loadPendingPurchaseHintOperatorNotesForBundle(db, 'pphbndl_demo')
    expect(result).toEqual([])
  })
})

describe('deletePendingPurchaseHintDocument', () => {
  it('retains operator notes as immutable packet-generation history', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [{ kind: 'operator_note' }] })
    const result = await deletePendingPurchaseHintDocument(
      { query } as unknown as Queryable,
      'pphbndl_demo',
      'pphdoc_demo',
    )
    expect(result).toBe('retained_operator_note')
    expect(query.mock.calls[0]![0]).toMatch(/d\.kind <> 'operator_note'/)
  })

  it('still deletes external hint documents', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [] })
    const result = await deletePendingPurchaseHintDocument(
      { query } as unknown as Queryable,
      'pphbndl_demo',
      'pphdoc_demo',
    )
    expect(result).toBe('deleted')
    expect(query).toHaveBeenCalledOnce()
  })
})
