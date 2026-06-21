// Worker job for the prospective pending-purchase classifier's HINT FACT
// EXTRACTION pass (child FreshlyBakedNYC/automation#54, task C3).
//
// Runs the intent-classify + cited-fact extraction engine over the documents
// of one hint bundle and persists hint_intent / extraction_status /
// extracted_facts on each row, so the classifier (C4) can read precomputed
// facts and the generate route only has to carry a hintBundleId.
//
// Enqueued automatically when a document is added to a bundle (single-doc
// scope) and on demand from the admin re-extract route (bundle or single-doc
// scope, with optional force). Each document is processed independently: one
// failing document is recorded as `failed` and never aborts the rest of the
// pass.
//
// Satisfies: virusdave/top-level#33

import type { CatalogPendingPurchasesExtractHintFactsJobPayload } from '../../shared/contracts/index.js'
import { getPool } from '../../server/db/pool.js'
import {
  getPendingPurchaseHintDocumentPointer,
  listPendingPurchaseHintDocuments,
  recordPendingPurchaseHintDocumentExtraction,
} from '../../server/db/queries/pendingPurchaseHintQueries.js'
import { getHintDocumentStore } from '../../server/pendingPurchases/pendingPurchaseHintStore.js'
import { extractPendingPurchaseHintFacts } from '../pendingPurchases/hintFactExtraction.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

export async function runCatalogPendingPurchasesExtractHintFactsJob(
  _context: JobHandlerContext,
  payload: CatalogPendingPurchasesExtractHintFactsJobPayload,
): Promise<void> {
  const db = getPool()
  const force = payload.force ?? false
  const userId = payload.requestedByUserId ?? null

  const documents = await listPendingPurchaseHintDocuments(db, payload.hintBundleId)

  const targets = documents.filter((document) => {
    if (payload.hintDocumentId != null && document.hintDocumentId !== payload.hintDocumentId) {
      return false
    }
    // Re-extract pending/failed/skipped by default; already-extracted only
    // when the caller explicitly forces it.
    return force || document.extractionStatus !== 'extracted'
  })

  const store = getHintDocumentStore()

  let extracted = 0
  let failed = 0
  let skipped = 0
  for (const document of targets) {
    // The bytes live out-of-band (C2): fetch the pointer and read the blob
    // (integrity-verified) before extracting. A missing/unreadable blob is a
    // per-document `failed`, never an abort of the rest of the pass.
    let rawText: string
    try {
      const pointer = await getPendingPurchaseHintDocumentPointer(
        db,
        payload.hintBundleId,
        document.hintDocumentId,
      )
      if (pointer === null) {
        throw new Error('hint document pointer not found')
      }
      const blob = await store.read(pointer)
      rawText = blob.text
    } catch (error) {
      await recordPendingPurchaseHintDocumentExtraction(db, {
        hintDocumentId: document.hintDocumentId,
        hintIntent: null,
        extractionStatus: 'failed',
        extractionError: `failed to read hint document content: ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 500),
        extractedFacts: null,
        userId,
        force,
      })
      failed += 1
      continue
    }

    const outcome = await extractPendingPurchaseHintFacts({
      hintDocumentId: document.hintDocumentId,
      kind: document.kind,
      rawText,
    })
    await recordPendingPurchaseHintDocumentExtraction(db, {
      hintDocumentId: document.hintDocumentId,
      hintIntent: outcome.hintIntent,
      extractionStatus: outcome.extractionStatus,
      extractionError: outcome.extractionError,
      extractedFacts: outcome.extractedFacts,
      userId,
      force,
    })
    if (outcome.extractionStatus === 'extracted') {
      extracted += 1
    } else if (outcome.extractionStatus === 'failed') {
      failed += 1
    } else {
      skipped += 1
    }
  }

  console.info(
    `[extractHintFacts] bundle=${payload.hintBundleId} processed=${targets.length} ` +
      `extracted=${extracted} failed=${failed} skipped=${skipped}`,
  )
}
