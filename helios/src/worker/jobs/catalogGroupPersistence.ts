import type { QueryResultRow } from 'pg'

import type { ReconcileStatus } from '../../shared/contracts/domain/catalog.js'
import type { JsonValue } from '../../shared/contracts/common/json.js'
import { sha256, stableJsonStringify } from '../../shared/util/hash.js'
import type { Queryable } from '../../server/db/pool.js'
import type { NormalizedCatalogGroupLiveState } from '../catalog/liveState.js'

type SnapshotSource = 'post_write' | 'pre_write' | 'sync' | 'undo'

export interface CatalogGroupRecord {
  catalogGroupId: number
  liveState: JsonValue
  liveStateHash: string
  reconcileStatus: ReconcileStatus
  sweedGroupId: number
}

interface CatalogGroupRow extends QueryResultRow {
  id: number
  live_state_hash: string
  live_state_json: JsonValue
  reconcile_status: ReconcileStatus
  sweed_group_id: number
}

interface SnapshotInsertRow extends QueryResultRow {
  id: number
}

export function hashLiveState(liveState: NormalizedCatalogGroupLiveState): string {
  return sha256(stableJsonStringify(liveState))
}

export async function getCatalogGroupRecord(
  db: Queryable,
  catalogGroupId: number,
  options?: { forUpdate?: boolean },
): Promise<CatalogGroupRecord> {
  const result = await db.query<CatalogGroupRow>(
    `
      select id, sweed_group_id, live_state_json, live_state_hash, reconcile_status
      from catalog_groups
      where id = $1
      ${options?.forUpdate ? 'for update' : ''}
    `,
    [catalogGroupId],
  )

  const row = result.rows[0]
  if (!row) {
    throw new Error(`Catalog group ${catalogGroupId} not found.`)
  }

  return {
    catalogGroupId: row.id,
    liveState: row.live_state_json,
    liveStateHash: row.live_state_hash,
    reconcileStatus: row.reconcile_status,
    sweedGroupId: row.sweed_group_id,
  }
}

export async function insertCatalogGroupSnapshot(
  db: Queryable,
  input: {
    catalogGroupId: number
    source: SnapshotSource
    stateHash: string
    stateJson: NormalizedCatalogGroupLiveState
  },
): Promise<number> {
  const result = await db.query<SnapshotInsertRow>(
    `
      insert into catalog_group_snapshots (catalog_group_id, source, state_json, state_hash)
      values ($1, $2, $3::jsonb, $4)
      returning id
    `,
    [input.catalogGroupId, input.source, JSON.stringify(input.stateJson), input.stateHash],
  )

  return result.rows[0].id
}

export async function updateCatalogGroupLiveState(
  db: Queryable,
  input: {
    catalogGroupId: number
    driftedAt: Date | null
    liveState: NormalizedCatalogGroupLiveState
    liveStateHash: string
    reconcileStatus: ReconcileStatus
    syncedAt?: Date
  },
): Promise<void> {
  const syncedAt = input.syncedAt ?? new Date()

  await db.query(
    `
      update catalog_groups
      set group_name = $2,
          group_full_name = $3,
          brand_name = $4,
          category_name = $5,
          subcategory_name = $6,
          strain_name = $7,
          product_tabs_json = $8::jsonb,
          live_state_json = $9::jsonb,
          live_state_hash = $10,
          reconcile_status = $11,
          last_synced_at = $12,
          last_seen_at = $12,
          drifted_at = $13,
          updated_at = now()
      where id = $1
    `,
    [
      input.catalogGroupId,
      input.liveState.groupName,
      input.liveState.groupFullName,
      input.liveState.brand,
      input.liveState.category,
      input.liveState.subcategory,
      input.liveState.strain,
      JSON.stringify(input.liveState.productTabs),
      JSON.stringify(input.liveState),
      input.liveStateHash,
      input.reconcileStatus,
      syncedAt,
      input.driftedAt,
    ],
  )
}
