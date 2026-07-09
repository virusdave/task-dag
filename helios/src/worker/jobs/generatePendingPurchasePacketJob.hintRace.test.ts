import { describe, expect, it } from 'vitest'

import type { Queryable } from '../../server/db/pool.js'
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

// Route queries by SQL shape: the status roll-up (count(*) filter ...) vs the
// facts-load select. Cast through unknown to satisfy the full pg QueryResult
// shape without a first-party `any` (banned by the pre-commit gate).
function stubDb(progress: unknown[], facts: unknown[]): Queryable {
  return {
    query: (sql: string) => {
      const rows = PROGRESS_SQL_MARK.test(sql) ? progress : facts
      return Promise.resolve({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] })
    },
  } as unknown as Queryable
}

describe('buildClassifierHintFacts hint-extraction race handling', () => {
  it('returns [] when no bundle is attached', async () => {
    const facts = await buildClassifierHintFacts(stubDb([], []), null)
    expect(facts).toEqual([])
  })

  it('defers (RetryableWorkerError) while any document is still extracting', async () => {
    const db = stubDb([progressRow({ total: 1, pending: 1 })], [])
    await expect(buildClassifierHintFacts(db, 'pphint_2026-07-07_224300_accfaf')).rejects.toBeInstanceOf(
      RetryableWorkerError,
    )
  })

  it('returns the flattened facts once extraction is complete', async () => {
    const db = stubDb([progressRow({ total: 1, pending: 0, extracted: 1 })], [validFactsDocumentRow()])
    const facts = await buildClassifierHintFacts(db, 'pphint_2026-07-07_224300_accfaf')
    expect(facts).toHaveLength(1)
    expect(facts[0]?.citedId).toBe('pphdoc_2026-07-07_224306_b08cbb#f1')
    expect(facts[0]?.fact.brand).toBe('Lil Lefty')
  })

  it('degrades gracefully (returns []) when all documents are terminal but yielded no usable facts', async () => {
    // A glossary / acronym-expansion / free-text hint the product-fact
    // extractor cannot represent (FreshlyBakedNYC/automation#69), or an
    // extraction that failed/skipped, must NOT abort the operator's whole
    // packet run: generation proceeds without hint evidence.
    const db = stubDb([progressRow({ total: 1, pending: 0, failed: 1 })], [])
    const facts = await buildClassifierHintFacts(db, 'pphint_2026-07-07_224300_accfaf')
    expect(facts).toEqual([])
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
