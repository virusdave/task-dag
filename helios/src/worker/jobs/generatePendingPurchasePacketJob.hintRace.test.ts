import { afterEach, describe, expect, it } from 'vitest'

import type { Queryable } from '../../server/db/pool.js'
import {
  _setHintDocumentStoreForTests,
  type HintBlob,
  type HintBlobPointer,
  type HintDocumentStore,
} from '../../server/pendingPurchases/pendingPurchaseHintStore.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import { buildClassifierHintFacts } from './generatePendingPurchasePacketJob.js'

// Regression coverage for the hint-extraction enqueue race: a packet-generation
// job is frequently queued by the same operator action that just added a hint
// document, before the async C3 extraction job has written its facts. The job
// must DEFER (retryable) while extraction is pending, and only fail loud once
// every document is terminal but produced no facts.

const PROGRESS_SQL_MARK = /count\(\*\) filter/

function progressRow(input: {
  total: number
  pending: number
  extracted?: number
  failed?: number
  skipped?: number
}) {
  return {
    total: input.total,
    pending: input.pending,
    extracted: input.extracted ?? 0,
    failed: input.failed ?? 0,
    skipped: input.skipped ?? 0,
  }
}

function validFactsDocumentRow() {
  return {
    hint_document_id: 'pphdoc_2026-07-07_224306_b08cbb',
    bundle_public_id: 'pphint_2026-07-07_224300_accfaf',
    kind: 'operator_note',
    source_label: null,
    content_sha256: 'a'.repeat(64),
    extracted_facts: {
      schemaVersion: 1,
      intent: 'free_text_description',
      extractor: 'llm',
      model: 'mistral.mistral-large-3-675b-instruct',
      facts: [
        {
          factId: 'f1',
          itemName: 'Lil Lefty',
          sku: null,
          vendorProductCode: null,
          brand: 'Lil Lefty',
          strain: null,
          prevalence: null,
          category: 'preroll',
          subcategory: 'infused',
          size: '1g',
          packCount: null,
          wholesalePrice: null,
          wholesalePriceBasis: null,
          quantity: null,
          quantityBasis: null,
          citation: {
            page: null,
            lineStart: 1,
            lineEnd: 1,
            row: null,
            jsonPointer: null,
            snippet: 'Lil Lefty brand 1g infused prerolls.',
          },
        },
      ],
      warnings: [],
    },
  }
}

// A glossary-only extracted document (issue #69): zero product facts, one
// cited acronym expansion. The product-fact loader flattens nothing from it;
// the glossary loader flattens the METRC expansion.
function glossaryOnlyDocumentRow() {
  return {
    hint_document_id: 'pphdoc_2026-07-07_224306_b08cbb',
    bundle_public_id: 'pphint_2026-07-07_224300_accfaf',
    kind: 'operator_note',
    source_label: null,
    content_sha256: 'a'.repeat(64),
    extracted_facts: {
      schemaVersion: 2,
      intent: 'free_text_description',
      extractor: 'llm',
      model: 'mistral.mistral-large-3-675b-instruct',
      facts: [],
      glossaryEntries: [
        {
          factId: 'f1',
          term: 'METRC',
          expansion: 'Marijuana Enforcement Tracking Reporting Compliance',
          note: null,
          citation: {
            page: null,
            lineStart: 1,
            lineEnd: 1,
            row: null,
            jsonPointer: null,
            snippet: 'METRC = Marijuana Enforcement Tracking Reporting Compliance',
          },
        },
      ],
      warnings: [],
    },
  }
}

const OPERATOR_NOTE_SQL_MARK = /kind = 'operator_note'/

// One operator_note pointer row as returned by
// loadPendingPurchaseHintOperatorNotesForBundle.
function operatorNoteRow(input: { sha: string; sourceLabel?: string | null; byteSize?: number }) {
  return {
    hint_document_id: `pphdoc_2026-07-09_013737_${input.sha.slice(0, 6)}`,
    source_label: input.sourceLabel ?? null,
    content_sha256: input.sha,
    storage_backend: 'fs',
    storage_uri: `fs://pending-purchase-hints/${input.sha.slice(0, 2)}/${input.sha.slice(2, 4)}/${input.sha}.txt`,
    byte_size: input.byteSize ?? 128,
  }
}

// Route queries by SQL shape: the status roll-up (count(*) filter ...), the
// operator-note pointer select (kind = 'operator_note'), and the facts/glossary
// select (everything else). Cast through unknown to satisfy the full pg
// QueryResult shape without a first-party `any` (banned by the pre-commit gate).
function stubDb(progress: unknown[], facts: unknown[], operatorNotes: unknown[] = []): Queryable {
  return {
    query: (sql: string) => {
      const rows = PROGRESS_SQL_MARK.test(sql)
        ? progress
        : OPERATOR_NOTE_SQL_MARK.test(sql)
          ? operatorNotes
          : facts
      return Promise.resolve({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] })
    },
  } as unknown as Queryable
}

// A blob store stub that returns text keyed by the pointer's contentSha256, so
// tests can wire operator-note pointers → verbatim guidance text.
function stubStore(textBySha: Record<string, string>): HintDocumentStore {
  return {
    put: () => {
      throw new Error('stubStore.put is not used in these tests')
    },
    read: (pointer: HintBlobPointer): Promise<HintBlob> => {
      const text = textBySha[pointer.contentSha256]
      if (text === undefined) {
        throw new Error(`stubStore has no text for ${pointer.contentSha256}`)
      }
      return Promise.resolve({
        contentSha256: pointer.contentSha256,
        text,
        byteSize: Buffer.byteLength(text, 'utf8'),
      })
    },
  }
}

describe('buildClassifierHintFacts hint-extraction race handling', () => {
  afterEach(() => {
    _setHintDocumentStoreForTests(null)
  })

  it('returns empty evidence when no bundle is attached', async () => {
    const evidence = await buildClassifierHintFacts(stubDb([], []), null)
    expect(evidence).toEqual({ hintFacts: [], glossaryEntries: [], operatorGuidance: [] })
  })

  it('defers (RetryableWorkerError) while any document is still extracting', async () => {
    const db = stubDb([progressRow({ total: 1, pending: 1 })], [])
    await expect(buildClassifierHintFacts(db, 'pphint_2026-07-07_224300_accfaf')).rejects.toBeInstanceOf(
      RetryableWorkerError,
    )
  })

  it('returns the flattened facts once extraction is complete', async () => {
    const db = stubDb([progressRow({ total: 1, pending: 0, extracted: 1 })], [validFactsDocumentRow()])
    const { hintFacts, glossaryEntries } = await buildClassifierHintFacts(
      db,
      'pphint_2026-07-07_224300_accfaf',
    )
    expect(hintFacts).toHaveLength(1)
    expect(hintFacts[0]?.citedId).toBe('pphdoc_2026-07-07_224306_b08cbb#f1')
    expect(hintFacts[0]?.fact.brand).toBe('Lil Lefty')
    expect(glossaryEntries).toEqual([])
  })

  it('flattens glossary entries and feeds them even when there are no product facts', async () => {
    // The exact issue #69 shape: a glossary-only hint document (no product
    // facts). It must NOT degrade to no-evidence — the glossary is fed to C4.
    const db = stubDb(
      [progressRow({ total: 1, pending: 0, extracted: 1 })],
      [glossaryOnlyDocumentRow()],
    )
    const { hintFacts, glossaryEntries } = await buildClassifierHintFacts(
      db,
      'pphint_2026-07-07_224300_accfaf',
    )
    expect(hintFacts).toEqual([])
    expect(glossaryEntries).toHaveLength(1)
    expect(glossaryEntries[0]?.citedId).toBe('pphdoc_2026-07-07_224306_b08cbb#f1')
    expect(glossaryEntries[0]?.term).toBe('METRC')
    expect(glossaryEntries[0]?.expansion).toMatch(/Enforcement/)
  })

  it('degrades gracefully (returns empty evidence) when all documents are terminal but yielded nothing usable', async () => {
    // A hint the extractor could not represent at all, or an extraction that
    // failed/skipped, must NOT abort the operator's whole packet run:
    // generation proceeds without hint evidence.
    const db = stubDb([progressRow({ total: 1, pending: 0, failed: 1 })], [])
    const evidence = await buildClassifierHintFacts(db, 'pphint_2026-07-07_224300_accfaf')
    expect(evidence).toEqual({ hintFacts: [], glossaryEntries: [], operatorGuidance: [] })
  })

  it('feeds verbatim operator-note guidance even with zero facts and zero glossary (issue #69)', async () => {
    // The real #69 failure: an operator_note like "MZ is Moony Zooties, an
    // existing brand" extracts to 0 facts / 0 glossary. It must NOT degrade to
    // no-evidence — the verbatim note is TRUSTED guidance fed to C4.
    const sha = 'b'.repeat(64)
    const noteText = 'MZ is Moony Zooties, an existing brand. There should be no new brands created here.'
    _setHintDocumentStoreForTests(stubStore({ [sha]: noteText }))
    const db = stubDb(
      [progressRow({ total: 1, pending: 0, extracted: 1 })],
      [],
      [operatorNoteRow({ sha, sourceLabel: 'operator note' })],
    )
    const { hintFacts, glossaryEntries, operatorGuidance } = await buildClassifierHintFacts(
      db,
      'pphint_2026-07-07_224300_accfaf',
    )
    expect(hintFacts).toEqual([])
    expect(glossaryEntries).toEqual([])
    expect(operatorGuidance).toHaveLength(1)
    expect(operatorGuidance[0]?.text).toBe(noteText)
    expect(operatorGuidance[0]?.sourceLabel).toBe('operator note')
    expect(operatorGuidance[0]?.hintDocumentId).toMatch(/^pphdoc_/)
  })

  it('carries operator guidance alongside extracted product facts', async () => {
    const sha = 'c'.repeat(64)
    _setHintDocumentStoreForTests(stubStore({ [sha]: 'ship as existing brands' }))
    const db = stubDb(
      [progressRow({ total: 2, pending: 0, extracted: 2 })],
      [validFactsDocumentRow()],
      [operatorNoteRow({ sha })],
    )
    const { hintFacts, operatorGuidance } = await buildClassifierHintFacts(
      db,
      'pphint_2026-07-07_224300_accfaf',
    )
    expect(hintFacts).toHaveLength(1)
    expect(operatorGuidance).toHaveLength(1)
    expect(operatorGuidance[0]?.text).toBe('ship as existing brands')
  })

  it('fails loud when an operator-note blob cannot be read (never degrades silently)', async () => {
    // A missing / unreadable / integrity-failed blob for a trusted operator
    // note must abort — generating without the operator's guidance would
    // silently recreate the incident.
    _setHintDocumentStoreForTests(stubStore({})) // no text for any sha → throws
    const db = stubDb(
      [progressRow({ total: 1, pending: 0, extracted: 1 })],
      [],
      [operatorNoteRow({ sha: 'd'.repeat(64) })],
    )
    await expect(
      buildClassifierHintFacts(db, 'pphint_2026-07-07_224300_accfaf'),
    ).rejects.toThrow(/no text for/)
  })

  it('fails loud (non-retryable) when an attached bundle resolves to zero documents', async () => {
    // total === 0 is a missing / fully-removed / mistyped bundle id — an
    // operator error — not a legitimately empty-facts bundle, so it stays a
    // hard failure rather than silently generating without the requested hint.
    const db = stubDb([progressRow({ total: 0, pending: 0 })], [])
    const promise = buildClassifierHintFacts(db, 'pphint_2026-07-07_224300_accfaf')
    await expect(promise).rejects.toThrow(/no documents/)
    await expect(promise).rejects.not.toBeInstanceOf(RetryableWorkerError)
  })
})
