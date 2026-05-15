/**
 * Output adapter interface for the Catalog Update Engine.
 *
 * Output adapters apply approved changes to the appropriate domain tables
 * (pricing, promos, taxonomy, etc.) based on field paths.
 */

import type { Queryable } from '../../server/db/pool.js'
import type { CatalogChangeFieldPath, CatalogChangeLineItemPersisted } from '../domain/changes.js'

export interface ApplyContext {
  db: Queryable
  requestId: string
  appliedByUserId: number
  proposalBatchId: number
}

export interface CatalogChangeOutputAdapter {
  /**
   * Which field_paths this adapter is responsible for.
   * Can be exact paths or prefix-based.
   */
  supportsField(field: CatalogChangeFieldPath): boolean

  /**
   * Apply a set of approved line items. They will all have approvalStatus='approved'
   * and effectiveValue already resolved.
   */
  applyApprovedChanges(
    ctx: ApplyContext,
    changes: CatalogChangeLineItemPersisted[],
  ): Promise<void>
}
