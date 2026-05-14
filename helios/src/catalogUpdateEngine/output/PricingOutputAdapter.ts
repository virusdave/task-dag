/**
 * Output adapter for applying pricing changes.
 *
 * Takes approved pricing changes and applies them to the appropriate pricing tables.
 */

import type {
  CatalogChangeOutputAdapter,
  ApplyContext,
} from './CatalogChangeOutputAdapter.js'
import type {
  CatalogChangeFieldPath,
  CatalogChangeLineItemPersisted,
} from '../domain/changes.js'
import type { PricingLadder } from '../domain/entities.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'

export class PricingOutputAdapter implements CatalogChangeOutputAdapter {
  supportsField(field: CatalogChangeFieldPath): boolean {
    return field.group === 'pricing'
  }

  async applyApprovedChanges(
    ctx: ApplyContext,
    changes: CatalogChangeLineItemPersisted[],
  ): Promise<void> {
    // Group changes by target entity
    const changesByEntity = new Map<string, CatalogChangeLineItemPersisted[]>()
    for (const change of changes) {
      const key = `${change.target.entityType}:${change.target.entityId ?? 'null'}`
      if (!changesByEntity.has(key)) {
        changesByEntity.set(key, [])
      }
      changesByEntity.get(key)!.push(change)
    }

    // Apply changes per entity
    for (const [entityKey, entityChanges] of changesByEntity) {
      await this.applyPricingChangesForEntity(ctx, entityKey, entityChanges)
    }

    // Audit
    await appendAuditEvent(ctx.db, {
      actorType: 'user',
      actorUserId: ctx.appliedByUserId,
      entityId: String(ctx.proposalBatchId),
      entityType: 'proposal_batch',
      eventType: 'catalog.pricing.changes_applied',
      module: 'catalog',
      payload: {
        proposalBatchId: ctx.proposalBatchId,
        appliedChangeCount: changes.length,
        entityCount: changesByEntity.size,
      },
      requestId: ctx.requestId,
      undoPayload: null,
    })
  }

  private async applyPricingChangesForEntity(
    ctx: ApplyContext,
    entityKey: string,
    changes: CatalogChangeLineItemPersisted[],
  ): Promise<void> {
    // TODO: Implement actual pricing table updates
    // For now, just log what would be applied
    for (const change of changes) {
      if (change.field.path === 'pricing.ladder') {
        const ladder = change.effectiveValue as PricingLadder
        // Would update pricing ladder table here
        console.log(
          `Would apply pricing ladder for ${entityKey}:`,
          ladder.entries.length,
          'entries',
        )
      } else if (change.field.path === 'pricing.basePrice') {
        const price = change.effectiveValue as number
        // Would update base price here
        console.log(`Would apply base price for ${entityKey}:`, price)
      }
    }

    // Audit per-entity application
    await appendAuditEvent(ctx.db, {
      actorType: 'user',
      actorUserId: ctx.appliedByUserId,
      entityId: entityKey,
      entityType: 'catalog_entity',
      eventType: 'catalog.pricing.entity_updated',
      module: 'catalog',
      payload: {
        entityKey,
        changeCount: changes.length,
        changes: changes.map((c) => ({
          fieldPath: c.field.path,
          baselineValue: c.baselineValue,
          effectiveValue: c.effectiveValue,
        })),
      },
      requestId: ctx.requestId,
      undoPayload: null,
    })
  }
}
