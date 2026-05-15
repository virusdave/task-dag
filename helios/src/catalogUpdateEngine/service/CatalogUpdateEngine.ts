/**
 * Central Catalog Update Engine service.
 *
 * Accepts catalog update batches from input adapters, persists them to the database
 * (reusing proposal_* tables and catalog_groups infrastructure), and coordinates
 * applying approved changes via output adapters.
 */

import type { Queryable } from '../../server/db/pool.js'
import type {
  CatalogUpdateBatchDraft,
  CatalogProposalRowDraft,
} from '../domain/proposals.js'
import type {
  CatalogChangeLineItemPersisted,
  CatalogChangeFieldPath,
} from '../domain/changes.js'
import type { CatalogTargetRef } from '../domain/entities.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { sha256, stableJsonStringify } from '../../shared/util/hash.js'

const BATCH_INSERT_SIZE = 250

export interface CreateBatchResult {
  proposalBatchId: number
  auditEventId: number
  importedRowCount: number
  importedLineItemCount: number
}

export interface ApplyBatchResult {
  appliedLineItemCount: number
  auditEventId: number
}

interface PreparedRow {
  draft: CatalogProposalRowDraft
  catalogGroupId?: number
  snapshotId?: number
  liveStateHash: string
  liveStateJson: string
  merchandisingContextJson: string
  evidenceJson: string
}

export class CatalogUpdateEngine {
  constructor(private db: Queryable) {}

  /**
   * Create a new catalog update batch from a draft, persisting to database.
   */
  async createBatch(
    batchDraft: CatalogUpdateBatchDraft,
    requestId: string,
  ): Promise<CreateBatchResult> {
    // 1) Insert proposal_batches
    const proposalBatchId = await this.insertProposalBatch(batchDraft)

    // 2) Prepare rows and ensure catalog_groups/snapshots where needed
    const preparedRows = this.prepareRows(batchDraft.rows)
    const catalogGroupIdMap = await this.ensureCatalogGroups(preparedRows)
    const snapshotIdMap = await this.ensureCatalogGroupSnapshots(preparedRows, catalogGroupIdMap)

    // Enrich prepared rows with IDs
    for (const row of preparedRows) {
      if (row.draft.target.entityType === 'catalog_group' && row.draft.target.externalKey) {
        const key = `${row.draft.target.externalKey.provider}:${row.draft.target.externalKey.id}`
        row.catalogGroupId = catalogGroupIdMap.get(key)
        if (row.catalogGroupId) {
          row.snapshotId = snapshotIdMap.get(row.catalogGroupId)
        }
      }
    }

    // 3) Insert proposal_rows
    const rowIdMap = await this.insertProposalRows(proposalBatchId, preparedRows)

    // 4) Insert proposal_line_items
    await this.insertProposalLineItems(preparedRows, rowIdMap, catalogGroupIdMap)

    const importedRowCount = preparedRows.length
    const importedLineItemCount = preparedRows.reduce(
      (sum, row) => sum + row.draft.lineItems.length,
      0,
    )

    // 5) Audit
    const auditEventId = await appendAuditEvent(this.db, {
      actorType: 'system',
      actorUserId: batchDraft.createdByUserId,
      entityId: String(proposalBatchId),
      entityType: 'proposal_batch',
      eventType: 'catalog.update_batch.created',
      module: 'catalog',
      payload: {
        triggerType: batchDraft.triggerType,
        type: batchDraft.type,
        summary: batchDraft.summary,
        config: batchDraft.config,
        importedRowCount,
        importedLineItemCount,
      },
      requestId,
      undoPayload: null,
    })

    return { proposalBatchId, auditEventId, importedRowCount, importedLineItemCount }
  }

  /**
   * Apply approved changes from a batch via output adapters.
   * This is a placeholder - full implementation requires output adapter integration.
   */
  async applyApprovedBatch(
    proposalBatchId: number,
    appliedByUserId: number,
    requestId: string,
  ): Promise<ApplyBatchResult> {
    // TODO: Load approved line items, dispatch to output adapters
    // For now, just audit the apply event
    const auditEventId = await appendAuditEvent(this.db, {
      actorType: 'user',
      actorUserId: appliedByUserId,
      entityId: String(proposalBatchId),
      entityType: 'proposal_batch',
      eventType: 'catalog.update_batch.applied',
      module: 'catalog',
      payload: { proposalBatchId },
      requestId,
      undoPayload: null,
    })

    return { appliedLineItemCount: 0, auditEventId }
  }

  private async insertProposalBatch(draft: CatalogUpdateBatchDraft): Promise<number> {
    const result = await this.db.query<{ id: number }>(
      `
        insert into proposal_batches (
          type,
          source,
          trigger_mode,
          status,
          summary_json,
          config_json,
          job_id,
          created_by_user_id
        )
        values ($1, $2, $3, 'ready', $4::jsonb, $5::jsonb, $6, $7)
        returning id
      `,
      [
        draft.type,
        draft.source,
        draft.triggerMode,
        JSON.stringify(draft.summary),
        JSON.stringify({
          dealerId: draft.dealerId,
          siteId: draft.siteId,
          triggerType: draft.triggerType,
          ...draft.config,
        }),
        draft.jobId ?? null,
        draft.createdByUserId,
      ],
    )

    return result.rows[0].id
  }

  private prepareRows(rows: CatalogProposalRowDraft[]): PreparedRow[] {
    return rows.map((draft) => {
      const liveState = this.buildLiveState(draft.target)
      return {
        draft,
        liveStateHash: sha256(stableJsonStringify(liveState)),
        liveStateJson: JSON.stringify(liveState),
        merchandisingContextJson: JSON.stringify(draft.merchandisingContext ?? {}),
        evidenceJson: JSON.stringify(draft.evidence ?? {}),
      }
    })
  }

  private buildLiveState(target: CatalogTargetRef): Record<string, unknown> {
    return {
      entityType: target.entityType,
      entityId: target.entityId,
      externalKey: target.externalKey ?? null,
      hierarchy: target.hierarchy,
      msoAnnotation: target.msoAnnotation ?? null,
    }
  }

  private async ensureCatalogGroups(rows: PreparedRow[]): Promise<Map<string, number>> {
    const groupRows = rows.filter(
      (r) => r.draft.target.entityType === 'catalog_group' && r.draft.target.externalKey,
    )

    if (groupRows.length === 0) {
      return new Map()
    }

    const catalogGroupIdMap = new Map<string, number>()

    for (const batch of this.chunkArray(groupRows, BATCH_INSERT_SIZE)) {
      const values: unknown[] = []
      const tuples = batch.map((row, index) => {
        const offset = index * 7
        const externalKey = row.draft.target.externalKey!
        const sweedGroupId =
          externalKey.provider === 'sweed' ? Number(externalKey.id) : null

        if (!sweedGroupId) {
          throw new Error(
            `Only sweed provider is currently supported for catalog_groups. Got: ${externalKey.provider}`,
          )
        }

        values.push(
          sweedGroupId,
          row.draft.rowTitle,
          row.draft.rowTitle,
          row.liveStateJson,
          row.liveStateHash,
          new Date().toISOString(),
        )

        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}::jsonb, $${offset + 5}, 'unknown', $${offset + 6}::timestamptz, $${offset + 6}::timestamptz)`
      })

      const result = await this.db.query<{ id: number; sweed_group_id: number }>(
        `
          insert into catalog_groups (
            sweed_group_id,
            group_name,
            group_full_name,
            live_state_json,
            live_state_hash,
            reconcile_status,
            last_synced_at,
            last_seen_at
          )
          values ${tuples.join(', ')}
          on conflict (sweed_group_id) do update
          set group_name = excluded.group_name,
              group_full_name = excluded.group_full_name,
              live_state_json = excluded.live_state_json,
              live_state_hash = excluded.live_state_hash,
              last_synced_at = excluded.last_synced_at,
              last_seen_at = excluded.last_seen_at,
              updated_at = now()
          returning id, sweed_group_id
        `,
        values,
      )

      for (const row of result.rows) {
        catalogGroupIdMap.set(`sweed:${row.sweed_group_id}`, row.id)
      }
    }

    return catalogGroupIdMap
  }

  private async ensureCatalogGroupSnapshots(
    rows: PreparedRow[],
    catalogGroupIdMap: Map<string, number>,
  ): Promise<Map<number, number>> {
    const snapshotIdMap = new Map<number, number>()
    const rowsWithGroups = rows.filter((r) => r.catalogGroupId !== undefined)

    if (rowsWithGroups.length === 0) {
      return snapshotIdMap
    }

    for (const batch of this.chunkArray(rowsWithGroups, BATCH_INSERT_SIZE)) {
      const values: unknown[] = []
      const tuples = batch
        .filter((r) => r.catalogGroupId !== undefined)
        .map((row, index) => {
          const offset = index * 3
          values.push(row.catalogGroupId!, row.liveStateJson, row.liveStateHash)
          return `($${offset + 1}, 'sync', $${offset + 2}::jsonb, $${offset + 3})`
        })

      if (tuples.length === 0) continue

      const result = await this.db.query<{ id: number; catalog_group_id: number }>(
        `
          insert into catalog_group_snapshots (catalog_group_id, source, state_json, state_hash)
          values ${tuples.join(', ')}
          returning id, catalog_group_id
        `,
        values,
      )

      for (const row of result.rows) {
        snapshotIdMap.set(row.catalog_group_id, row.id)
      }
    }

    return snapshotIdMap
  }

  private async insertProposalRows(
    proposalBatchId: number,
    rows: PreparedRow[],
  ): Promise<Map<string, number>> {
    const rowIdMap = new Map<string, number>()

    for (const batch of this.chunkArray(rows, BATCH_INSERT_SIZE)) {
      const values: unknown[] = []
      const tuples = batch.map((row, index) => {
        const offset = index * 7
        values.push(
          proposalBatchId,
          row.catalogGroupId ?? null,
          row.draft.target.entityType,
          row.draft.target.entityId ?? null,
          row.snapshotId ?? null,
          row.draft.rowTitle,
          row.merchandisingContextJson,
          row.evidenceJson,
        )

        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::jsonb, $${offset + 8}::jsonb)`
      })

      const result = await this.db.query<{
        id: number
        target_entity_type: string
        target_entity_id: number | null
      }>(
        `
          insert into proposal_rows (
            proposal_batch_id,
            catalog_group_id,
            target_entity_type,
            target_entity_id,
            baseline_snapshot_id,
            row_title,
            merchandising_context_json,
            evidence_json
          )
          values ${tuples.join(', ')}
          returning id, target_entity_type, target_entity_id
        `,
        values,
      )

      batch.forEach((row, index) => {
        const dbRow = result.rows[index]
        const key = `${dbRow.target_entity_type}:${dbRow.target_entity_id ?? 'null'}`
        rowIdMap.set(key, dbRow.id)
      })
    }

    return rowIdMap
  }

  private async insertProposalLineItems(
    rows: PreparedRow[],
    rowIdMap: Map<string, number>,
    catalogGroupIdMap: Map<string, number>,
  ): Promise<void> {
    const allLineItems: Array<{
      rowKey: string
      catalogGroupId: number | null
      lineItem: CatalogChangeLineItemDraft
    }> = []

    for (const row of rows) {
      const rowKey = `${row.draft.target.entityType}:${row.draft.target.entityId ?? 'null'}`
      for (const lineItem of row.draft.lineItems) {
        allLineItems.push({
          rowKey,
          catalogGroupId: row.catalogGroupId ?? null,
          lineItem,
        })
      }
    }

    for (const batch of this.chunkArray(allLineItems, BATCH_INSERT_SIZE)) {
      const values: unknown[] = []
      const tuples = batch.map((item, index) => {
        const offset = index * 10
        const rowId = rowIdMap.get(item.rowKey)
        if (!rowId) {
          throw new Error(`Missing row ID for key: ${item.rowKey}`)
        }

        values.push(
          rowId,
          item.catalogGroupId,
          item.lineItem.target.entityType,
          item.lineItem.target.entityId ?? null,
          item.lineItem.field.path,
          JSON.stringify(item.lineItem.baselineValue),
          JSON.stringify(item.lineItem.suggestedValue),
          JSON.stringify(item.lineItem.suggestedValue), // effective = suggested initially
          item.lineItem.notes ?? null,
          JSON.stringify(item.lineItem.validationIssues ?? []),
        )

        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}::jsonb, $${offset + 7}::jsonb, null, $${offset + 8}::jsonb, 'pending', 1, $${offset + 9}, $${offset + 10}::jsonb)`
      })

      await this.db.query(
        `
          insert into proposal_line_items (
            proposal_row_id,
            catalog_group_id,
            target_entity_type,
            target_entity_id,
            field_path,
            baseline_value_json,
            suggested_value_json,
            edited_value_json,
            effective_value_json,
            approval_status,
            version,
            notes,
            validation_issues_json
          )
          values ${tuples.join(', ')}
        `,
        values,
      )
    }
  }

  private chunkArray<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size))
    }
    return chunks
  }
}
