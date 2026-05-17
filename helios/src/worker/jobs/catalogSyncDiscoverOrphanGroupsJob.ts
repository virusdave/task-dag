/**
 * catalog.sync.discover_orphan_groups
 *
 * Maintenance job triggered by the "Images & Barcodes" page's
 * "Fix cache" button (or scheduled / manually). Finds in-stock
 * product ids that are present in `stock_variant_state` but absent
 * from every cached `catalog_groups.live_state_json.products` array,
 * resolves their `productGroupId` via `store.product.get`, and for
 * each newly-discovered group creates a placeholder `catalog_groups`
 * row plus enqueues a forced `catalog.sync.group_detail` job so the
 * normal sync pipeline fills in real live state.
 *
 * The job is intentionally NOT clever about parallelism: it walks
 * orphan products with a small bounded fan-out (4) to keep Sweed
 * load reasonable. All Sweed calls run inside the per-job session
 * opened by `withSweedSession()` (see runtime/jobRegistry.ts), so
 * the dealer context is private to this job.
 */

import { z } from 'zod'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type CatalogSyncDiscoverOrphanGroupsJobPayload,
} from '../../shared/contracts/index.js'
import { buildCatalogGroupModuleScope } from '../../shared/contracts/index.js'
import { sha256, stableJsonStringify } from '../../shared/util/hash.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { enqueueJob } from '../../server/jobs/enqueueJob.js'
import { getOptionalSweedSessionConcurrencyKey } from '../../server/jobs/concurrency.js'
import { normalizeCatalogGroupDetail } from '../catalog/liveState.js'
import { getProductDetail, getProductGroupDetail } from '../sweed/client.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

const PRODUCT_FETCH_CONCURRENCY = 4

const OrphanProductRowSchema = z.object({ product_id: z.coerce.number().int() })

const SweedProductSummarySchema = z
  .object({
    id: z.coerce.number().int(),
    productGroupId: z
      .union([z.coerce.number().int(), z.string().trim().min(1)])
      .nullable()
      .optional(),
  })
  .passthrough()

const SweedProductDetailWrappedSchema = z
  .object({ product: SweedProductSummarySchema })
  .passthrough()
  .transform((value) => value.product)

const SweedProductDetailSchema = z.union([SweedProductDetailWrappedSchema, SweedProductSummarySchema])

interface DiscoveredGroup {
  sweedGroupId: number
  catalogGroupId: number
}

export async function runCatalogSyncDiscoverOrphanGroupsJob(
  context: JobHandlerContext,
  payload: CatalogSyncDiscoverOrphanGroupsJobPayload,
): Promise<void> {
  const siteDealerIds =
    payload.siteDealerIds.length > 0
      ? payload.siteDealerIds
      : HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)

  const orphanProductIds = await loadOrphanInStockProductIds(siteDealerIds)
  if (orphanProductIds.length === 0) {
    return
  }

  const productIdToSweedGroupId = new Map<number, number>()
  const warnings: string[] = []

  let cursor = 0
  const runners = Math.min(PRODUCT_FETCH_CONCURRENCY, orphanProductIds.length)
  await Promise.all(
    Array.from({ length: runners }, async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= orphanProductIds.length) {
          return
        }
        const productId = orphanProductIds[index]!
        try {
          const detail = SweedProductDetailSchema.parse(await getProductDetail(productId))
          const sweedGroupId = coerceOptionalInt(detail.productGroupId)
          if (sweedGroupId !== null) {
            productIdToSweedGroupId.set(productId, sweedGroupId)
          } else {
            warnings.push(`Product ${productId} has no productGroupId.`)
          }
        } catch (error) {
          warnings.push(`Failed to resolve productGroupId for product ${productId}: ${describeError(error)}`)
        }
      }
    }),
  )

  const distinctSweedGroupIds = [...new Set(productIdToSweedGroupId.values())].sort((a, b) => a - b)
  const discovered: DiscoveredGroup[] = []
  for (const sweedGroupId of distinctSweedGroupIds) {
    try {
      const groupDetail = await getProductGroupDetail(sweedGroupId)
      const liveState = normalizeCatalogGroupDetail(groupDetail)
      const catalogGroupId = await upsertPlaceholderCatalogGroup(sweedGroupId, liveState)
      discovered.push({ sweedGroupId, catalogGroupId })
    } catch (error) {
      warnings.push(`Failed to fetch/upsert group ${sweedGroupId}: ${describeError(error)}`)
    }
  }

  // Enqueue a forced detail sync for each discovered group so the
  // normal sync pipeline replaces the placeholder with real data.
  const earlyRunAt = new Date(Date.now() - 60_000)
  for (const { catalogGroupId } of discovered) {
    const scope = buildCatalogGroupModuleScope(catalogGroupId)
    await enqueueJob(getPool(), {
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `catalog.sync.group_detail:${catalogGroupId}`,
      jobType: 'catalog.sync.group_detail',
      module: 'catalog',
      payload: {
        catalogGroupId,
        forceLiveRefresh: true,
        requestedByUserId: payload.requestedByUserId ?? null,
        trigger: 'discovered_orphan_group',
      },
      requestedByUserId: payload.requestedByUserId ?? null,
      runAt: earlyRunAt,
      scope,
    })
  }

  if (warnings.length > 0) {
    console.warn(
      `[catalog.sync.discover_orphan_groups] job ${context.id} completed with ${warnings.length} warning(s):\n  - ` +
        warnings.slice(0, 20).join('\n  - '),
    )
  }
}

async function loadOrphanInStockProductIds(siteDealerIds: number[]): Promise<number[]> {
  const result = await getPool().query<{ product_id: number }>(
    `
      with covered as (
        select distinct ((p.value->>'productId')::bigint) as product_id
        from catalog_groups cg
        cross join lateral jsonb_array_elements(
          coalesce(cg.live_state_json->'products', '[]'::jsonb)
        ) as p(value)
        where cg.deleted_at is null
      )
      select distinct svs.product_id
      from stock_variant_state svs
      left join covered c on c.product_id = svs.product_id
      where svs.is_on_stock = true
        and svs.site_dealer_id = any($1::bigint[])
        and c.product_id is null
      order by svs.product_id
    `,
    [siteDealerIds],
  )
  return result.rows.map((row) => OrphanProductRowSchema.parse(row).product_id)
}

async function upsertPlaceholderCatalogGroup(
  sweedGroupId: number,
  liveState: ReturnType<typeof normalizeCatalogGroupDetail>,
): Promise<number> {
  const liveStateHash = sha256(stableJsonStringify(liveState))
  const productTabs = liveState.productTabs

  return withTransaction(async (db) => {
    const result = await db.query<{ id: number }>(
      `
        insert into catalog_groups (
          sweed_group_id,
          group_name,
          group_full_name,
          brand_name,
          category_name,
          subcategory_name,
          strain_name,
          product_tabs_json,
          live_state_json,
          live_state_hash,
          reconcile_status,
          last_synced_at,
          last_seen_at,
          needs_reanalysis_at,
          needs_reanalysis_reason
        ) values (
          $1, $2, $3, $4, $5, $6, $7,
          $8::jsonb, $9::jsonb, $10,
          'in_sync', now(), now(),
          now(), 'discovered_orphan_group'
        )
        on conflict (sweed_group_id) do update
          set group_name = excluded.group_name,
              group_full_name = excluded.group_full_name,
              brand_name = excluded.brand_name,
              category_name = excluded.category_name,
              subcategory_name = excluded.subcategory_name,
              strain_name = excluded.strain_name,
              product_tabs_json = excluded.product_tabs_json,
              live_state_json = excluded.live_state_json,
              live_state_hash = excluded.live_state_hash,
              last_synced_at = excluded.last_synced_at,
              last_seen_at = excluded.last_seen_at,
              needs_reanalysis_at = now(),
              needs_reanalysis_reason = 'discovered_orphan_group',
              updated_at = now()
        returning id
      `,
      [
        sweedGroupId,
        liveState.groupName,
        liveState.groupFullName,
        liveState.brand,
        liveState.category,
        liveState.subcategory,
        liveState.strain,
        JSON.stringify(productTabs),
        JSON.stringify(liveState),
        liveStateHash,
      ],
    )
    return result.rows[0].id
  })
}

function coerceOptionalInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) {
      return parsed
    }
  }
  return null
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
