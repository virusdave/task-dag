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

  await projectCatalogGroupProducts(db, input.catalogGroupId, input.liveState)
}

/**
 * Maintain the `catalog_group_products` projection (migration 078, Phase B
 * of top-level#16) alongside the catalog_groups column projection above, so
 * the family-grouped review queue can group/sort/paginate by product
 * `sizeName` without cracking `live_state_json` per row.
 *
 * This is a skinny, write-on-change projection of `live_state_json.products`:
 *  - upsert one row per product, updating ONLY when a projected column
 *    actually changed (`IS DISTINCT FROM`), so an unchanged re-sync writes
 *    zero rows (no dead-tuple churn / WAL — canon §3);
 *  - delete rows for products that have left the group.
 *
 * It runs on the same `Queryable` as the catalog_groups update. Callers MUST
 * pass a transaction client (all do today, via `withTransaction`): the
 * catalog_groups row lock then serialises concurrent same-group syncs and
 * keeps the blob and this projection atomically consistent. Called with a
 * plain pool it would be two un-serialised statements and could leave the
 * projection stale relative to the blob.
 */
async function projectCatalogGroupProducts(
  db: Queryable,
  catalogGroupId: number,
  liveState: NormalizedCatalogGroupLiveState,
): Promise<void> {
  const ordinals: number[] = []
  const names: Array<string | null> = []
  const tabs: Array<string | null> = []
  const sizeNames: Array<string | null> = []
  const prices: Array<number | null> = []
  // De-dupe by productId (last occurrence wins, mirroring the unique PK).
  // Production live_state never has duplicate productIds, but a duplicate
  // would make `insert … on conflict do update` fail ("cannot affect row a
  // second time"), so guard against it rather than trust the upstream blob.
  const indexByProductId = new Map<number, number>()
  const productIds: number[] = []

  liveState.products.forEach((product, index) => {
    // Skip products without a usable id — they can't be keyed or joined.
    if (!Number.isFinite(product.productId) || product.productId <= 0) return
    const name = product.name ?? null
    const tab = product.tab ?? null
    const sizeName = product.sizeName ?? null
    const price = typeof product.price === 'number' && Number.isFinite(product.price) ? product.price : null
    const existing = indexByProductId.get(product.productId)
    if (existing !== undefined) {
      ordinals[existing] = index
      names[existing] = name
      tabs[existing] = tab
      sizeNames[existing] = sizeName
      prices[existing] = price
      return
    }
    indexByProductId.set(product.productId, productIds.length)
    productIds.push(product.productId)
    ordinals.push(index)
    names.push(name)
    tabs.push(tab)
    sizeNames.push(sizeName)
    prices.push(price)
  })

  if (productIds.length > 0) {
    await db.query(
      `
        insert into catalog_group_products
          (catalog_group_id, product_id, ordinal, name, tab, size_name, price, updated_at)
        select $1, t.product_id, t.ordinal, t.name, t.tab, t.size_name, t.price, now()
        from unnest($2::bigint[], $3::int[], $4::text[], $5::text[], $6::text[], $7::numeric[])
          as t(product_id, ordinal, name, tab, size_name, price)
        on conflict (catalog_group_id, product_id) do update
          set ordinal   = excluded.ordinal,
              name      = excluded.name,
              tab       = excluded.tab,
              size_name = excluded.size_name,
              price     = excluded.price,
              updated_at = now()
          where catalog_group_products.ordinal   is distinct from excluded.ordinal
             or catalog_group_products.name      is distinct from excluded.name
             or catalog_group_products.tab       is distinct from excluded.tab
             or catalog_group_products.size_name is distinct from excluded.size_name
             or catalog_group_products.price     is distinct from excluded.price
      `,
      [catalogGroupId, productIds, ordinals, names, tabs, sizeNames, prices],
    )
  }

  // Drop projection rows for products that are no longer in the group. With
  // an empty product list this deletes all of the group's rows (correct: a
  // group with no products projects nothing). `<> all('{}')` is vacuously
  // true, so the empty-array case still deletes everything.
  await db.query(
    `
      delete from catalog_group_products
      where catalog_group_id = $1
        and product_id <> all($2::bigint[])
    `,
    [catalogGroupId, productIds],
  )
}
