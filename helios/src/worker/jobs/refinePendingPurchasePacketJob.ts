import type { CatalogPendingPurchasesRefineJobPayload } from '../../shared/contracts/index.js'
import {
  createDeterministicPendingPurchaseCandidateRevision,
  markPendingPurchaseRefinementTurnFailed,
} from '../../server/db/queries/pendingPurchaseRefinementQueries.js'
import { withTransaction } from '../../server/db/tx.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

/**
 * Deterministic skeleton for pending-purchase packet refinement.
 *
 * This deliberately does not call an LLM yet. It verifies the persisted turn's
 * target snapshot is still current and materializes a candidate revision by
 * copying existing row lineages only. Later leaves can replace the no-op copy
 * with a validated patch application step without changing the route/job
 * serialization or apply-gating contract.
 */
export async function runCatalogPendingPurchasesRefineJob(
  _context: JobHandlerContext,
  payload: CatalogPendingPurchasesRefineJobPayload,
): Promise<void> {
  try {
    await withTransaction(async (db) => {
      await createDeterministicPendingPurchaseCandidateRevision(db, payload.refinementTurnId)
    })
  } catch (error) {
    await withTransaction(async (db) => {
      await markPendingPurchaseRefinementTurnFailed(
        db,
        payload.refinementTurnId,
        error instanceof Error ? error.message : 'Pending-purchase refinement failed.',
      )
    })
    throw error
  }
}
