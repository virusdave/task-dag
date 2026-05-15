/**
 * Proposal batch and row structures for the Catalog Update Engine.
 *
 * These types represent collections of proposed changes organized by trigger type,
 * ready to be persisted into proposal_batches, proposal_rows, and proposal_line_items.
 */

import type { CatalogTargetRef } from './entities.js'
import type { CatalogChangeLineItemDraft } from './changes.js'

export type CatalogUpdateTriggerType =
  | 'purchase'
  | 'repricing'
  | 'promo'
  | 'market'
  | 'maintenance'
  | 'error_correction'

export type CatalogUpdateBatchType =
  | 'pricing'
  | 'promo'
  | 'taxonomy'
  | 'attributes'
  | 'description' // existing description updates
  | 'mixed' // multiple types in one batch

/**
 * Draft batch of catalog updates, before persistence.
 */
export interface CatalogUpdateBatchDraft {
  type: CatalogUpdateBatchType
  triggerType: CatalogUpdateTriggerType
  source: string // e.g. 'auto-reprice-v1', 'promotion-csv-import'
  triggerMode: 'auto' | 'manual' | 'import' // maps to proposal_batches.trigger_mode
  dealerId: number
  siteId?: number | null
  createdByUserId: number | null
  jobId?: number | null
  summary: Record<string, unknown> // aggregated stats, counts, etc.
  config: Record<string, unknown> // job config, thresholds, ML version, etc.
  rows: CatalogProposalRowDraft[]
}

/**
 * Draft proposal row representing changes to a single catalog entity.
 */
export interface CatalogProposalRowDraft {
  // Ties back to catalog_groups where appropriate
  target: CatalogTargetRef
  rowTitle: string // shown in list ("Brand - Product - Size")
  merchandisingContext?: Record<string, unknown> // for proposal_rows.merchandising_context_json
  evidence?: Record<string, unknown> // for proposal_rows.evidence_json
  lineItems: CatalogChangeLineItemDraft[]
}

/**
 * Persisted batch with database ID.
 */
export interface CatalogUpdateBatchPersisted extends CatalogUpdateBatchDraft {
  id: number
  status: 'draft' | 'ready' | 'applied' | 'cancelled'
  createdAt: Date
  updatedAt: Date
}
