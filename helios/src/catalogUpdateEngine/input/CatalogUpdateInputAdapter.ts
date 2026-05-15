/**
 * Input adapter interface for the Catalog Update Engine.
 *
 * Input adapters transform trigger-specific payloads (purchases, repricing, promos, etc.)
 * into unified CatalogUpdateBatchDraft objects that can be persisted and reviewed.
 */

import type { Queryable } from '../../server/db/pool.js'
import type {
  CatalogUpdateBatchDraft,
  CatalogUpdateTriggerType,
} from '../domain/proposals.js'

export interface CatalogUpdateTriggerContext {
  db: Queryable
  requestId: string
  dealerId: number
  siteId?: number | null
  createdByUserId: number | null
  jobId?: number | null
}

export interface CatalogUpdateInputAdapter<TTriggerPayload> {
  triggerType: CatalogUpdateTriggerType

  /**
   * Prepare a catalog update batch from trigger-specific payload.
   */
  prepareBatch(
    ctx: CatalogUpdateTriggerContext,
    payload: TTriggerPayload,
  ): Promise<CatalogUpdateBatchDraft>
}
