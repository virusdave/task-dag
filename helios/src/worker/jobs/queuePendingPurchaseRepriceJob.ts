import { randomUUID } from 'node:crypto'

import type { QueryResultRow } from 'pg'

import type { CatalogPendingPurchasesQueueRepriceJobPayload } from '../../shared/contracts/index.js'
import { DEFAULT_PRICING_GENERATOR_MODEL, DEFAULT_PRICING_PROMPT_VERSION } from '../../shared/domain/pricingGeneration.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool, type Queryable } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { enqueueJob } from '../../server/jobs/enqueueJob.js'
import { DependencyUnavailableWorkerError } from '../runtime/errors.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

interface CreatedRow extends QueryResultRow {
  row_id: number
  product_id: number
  group_id: number
  mirror_repair_requested_at: string | null
  reprice_batch_id: number | null
}

interface CohortRow extends QueryResultRow { id: number }

interface MappingRow extends QueryResultRow {
  catalog_group_id: number
  product_id: number
  sweed_group_id: number
}

const MIRROR_RECHECK_DELAY_MS = 5 * 60 * 1000

const CREATED_ROWS_SQL = `
  select id as row_id,
         (last_apply_summary_json#>>'{pendingPurchaseCreatedSku,productId}')::bigint as product_id,
         (last_apply_summary_json#>>'{pendingPurchaseCreatedSku,groupId}')::bigint as group_id,
         last_apply_summary_json#>>'{pendingPurchaseCreatedSku,mirrorRepairRequestedAt}' as mirror_repair_requested_at,
         nullif(last_apply_summary_json#>>'{pendingPurchaseCreatedSku,repriceBatchId}', '')::bigint as reprice_batch_id
  from pending_purchase_rows
  where id = any($1::bigint[])
    and last_apply_summary_json#>>'{pendingPurchaseCreatedSku,repriceRequired}' = 'true'
    and last_apply_summary_json#>'{pendingPurchaseCreatedSku}' ? 'productId'
  order by id
`

export async function runCatalogPendingPurchasesQueueRepriceJob(
  context: JobHandlerContext,
  payload: CatalogPendingPurchasesQueueRepriceJobPayload,
): Promise<void> {
  const expectedByRow = new Map(payload.createdProducts.map((item) => [item.rowId, item.productId]))
  const rowIds = [...expectedByRow.keys()]
  const rows = (await getPool().query<CreatedRow>(CREATED_ROWS_SQL, [rowIds])).rows
  assertExpectedCreatedRows(rows, expectedByRow)
  const existingBatchIds = [...new Set(rows.map((row) => row.reprice_batch_id).filter((id): id is number => id !== null))]
  if (existingBatchIds.length > 1) throw new Error('Created products are already associated with multiple reprice batches.')
  if (existingBatchIds.length === 1 && rows.every((row) => row.reprice_batch_id === existingBatchIds[0])) return

  const productIds = rows.map((row) => row.product_id)
  const mapped = await getPool().query<MappingRow>(
    `select cgp.catalog_group_id, cgp.product_id, cg.sweed_group_id
     from catalog_group_products cgp
     join catalog_groups cg on cg.id = cgp.catalog_group_id and cg.deleted_at is null
     where cgp.product_id = any($1::bigint[])`,
    [productIds],
  )
  if (!mappingsMatchCreatedRows(rows, mapped.rows)) {
    await queueMirrorRepairOnce(payload, rows)
    throw new DependencyUnavailableWorkerError(
      'Created pending-purchase products are not mapped to their Sweed groups in the catalog mirror yet; discovery was queued.',
      { delayMs: MIRROR_RECHECK_DELAY_MS },
    )
  }

  await withTransaction(async (db) => {
    await db.query('select pg_advisory_xact_lock($1)', [payload.pendingPurchaseApplyRequestId])
    const lockedRows = (await db.query<CreatedRow>(`${CREATED_ROWS_SQL} for update`, [rowIds])).rows
    assertExpectedCreatedRows(lockedRows, expectedByRow)
    const lockedBatchIds = [...new Set(lockedRows.map((row) => row.reprice_batch_id).filter((id): id is number => id !== null))]
    if (lockedBatchIds.length > 1) throw new Error('Created products are already associated with multiple reprice batches.')
    if (lockedBatchIds.length === 1 && lockedRows.every((row) => row.reprice_batch_id === lockedBatchIds[0])) return
    if (lockedBatchIds.length === 1) {
      throw new Error('Created products are only partially associated with an existing reprice batch; refusing to assign products that batch may not cover.')
    }

    const lockedProductIds = lockedRows.map((row) => row.product_id)
    const lockedMappings = await db.query<MappingRow>(
      `select cgp.catalog_group_id, cgp.product_id, cg.sweed_group_id
       from catalog_group_products cgp
       join catalog_groups cg on cg.id = cgp.catalog_group_id and cg.deleted_at is null
       where cgp.product_id = any($1::bigint[])`,
      [lockedProductIds],
    )
    if (!mappingsMatchCreatedRows(lockedRows, lockedMappings.rows)) {
      throw new DependencyUnavailableWorkerError(
        'Created pending-purchase products are not mapped to their Sweed groups in the catalog mirror yet.',
        { delayMs: MIRROR_RECHECK_DELAY_MS },
      )
    }
    const catalogGroupIds = await loadCategoricalBrandCohort(db, lockedMappings.rows.map((row) => row.catalog_group_id))
    if (catalogGroupIds.length === 0) {
      throw new DependencyUnavailableWorkerError('Created Sweed groups are not mapped in the catalog mirror yet.', { delayMs: MIRROR_RECHECK_DELAY_MS })
    }
    const scopedProductIds = (await db.query<{ product_id: number }>(
      `select distinct product_id from catalog_group_products where catalog_group_id = any($1::bigint[]) order by product_id`,
      [catalogGroupIds],
    )).rows.map((row) => row.product_id)
    if (scopedProductIds.length === 0) {
      throw new DependencyUnavailableWorkerError('The categorical brand cohort has no mirrored products yet.', { delayMs: MIRROR_RECHECK_DELAY_MS })
    }
    const insert = await db.query<{ id: number }>(
      `insert into proposal_batches
         (type, source, trigger_mode, status, prompt_version, model, summary_json, config_json, created_by_user_id)
       values ('pricing', 'generated', 'ui', 'draft', $1, $2, $3::jsonb, $4::jsonb, $5)
       returning id`,
      [
        DEFAULT_PRICING_PROMPT_VERSION,
        DEFAULT_PRICING_GENERATOR_MODEL,
        JSON.stringify({ generatedGroupCount: 0, generatedLineItemCount: 0, requestedGroupCount: catalogGroupIds.length }),
        JSON.stringify({ catalogGroupIds, explicitProductIds: scopedProductIds, scopedProductIds, forceLiveRefresh: true, scopeKind: 'explicit_selection', scopeLabel: 'Pending-purchase categorical brand cohort', triggerSource: 'pending-purchase-created-sku' }),
        payload.requestedByUserId ?? null,
      ],
    )
    const proposalBatchId = insert.rows[0]!.id
    const jobId = await enqueueJob(db, {
      dedupeKey: `proposal.generate.pricing_batch:${proposalBatchId}`,
      jobType: 'proposal.generate.pricing_batch',
      module: 'pricing',
      payload: { forceLiveRefresh: true, proposalBatchId, requestedByUserId: payload.requestedByUserId ?? null, trigger: 'ui_generate' },
      requestedByUserId: payload.requestedByUserId ?? null,
    })
    await db.query('update proposal_batches set job_id = $2 where id = $1', [proposalBatchId, jobId])
    await setRepriceBatch(db, lockedRows.map((row) => row.row_id), proposalBatchId)
    await appendAuditEvent(db, {
      actorType: 'system', actorUserId: null, entityId: String(proposalBatchId), entityType: 'proposal_batch',
      eventType: 'proposal.batch.generation_requested', module: 'pricing', requestId: randomUUID(), undoPayload: null,
      payload: { catalogGroupIds, pendingPurchaseApplyRequestId: payload.pendingPurchaseApplyRequestId, proposalBatchId, queuedJobId: jobId, triggerSource: 'pending-purchase-created-sku' },
    })
    void context
  })
}

async function queueMirrorRepairOnce(
  payload: CatalogPendingPurchasesQueueRepriceJobPayload,
  rows: CreatedRow[],
): Promise<void> {
  await withTransaction(async (db) => {
    await db.query('select pg_advisory_xact_lock($1)', [payload.pendingPurchaseApplyRequestId])
    const lockedRows = (await db.query<CreatedRow>(`${CREATED_ROWS_SQL} for update`, [rows.map((row) => row.row_id)])).rows
    if (lockedRows.every((row) => row.mirror_repair_requested_at !== null)) return

    const catalogGroups = await db.query<{ id: number; sweed_group_id: number }>(
      `select id, sweed_group_id from catalog_groups where sweed_group_id = any($1::bigint[]) and deleted_at is null`,
      [[...new Set(lockedRows.map((row) => row.group_id))]],
    )
    for (const group of catalogGroups.rows) {
      await enqueueJob(db, {
        dedupeKey: `catalog.sync.group_detail:${group.id}`,
        jobType: 'catalog.sync.group_detail',
        module: 'catalog',
        payload: {
          catalogGroupId: group.id,
          forceLiveRefresh: true,
          requestedByUserId: payload.requestedByUserId ?? null,
          trigger: 'manual_refresh',
        },
        requestedByUserId: payload.requestedByUserId ?? null,
      })
    }
    if (catalogGroups.rows.length < new Set(lockedRows.map((row) => row.group_id)).size) {
      await enqueueJob(db, {
        dedupeKey: `catalog.sync.discover_orphan_groups:pending-purchase-reprice:${payload.pendingPurchaseApplyRequestId}`,
        jobType: 'catalog.sync.discover_orphan_groups',
        module: 'catalog',
        payload: { requestedByUserId: payload.requestedByUserId ?? null, siteDealerIds: [], trigger: 'manual_refresh' },
        requestedByUserId: payload.requestedByUserId ?? null,
      })
    }
    await db.query(
      `update pending_purchase_rows
       set last_apply_summary_json = jsonb_set(
             last_apply_summary_json,
             '{pendingPurchaseCreatedSku,mirrorRepairRequestedAt}',
             to_jsonb(now()::text),
             true
           ),
           updated_at = now()
       where id = any($1::bigint[])`,
      [lockedRows.map((row) => row.row_id)],
    )
  })
}

function assertExpectedCreatedRows(rows: CreatedRow[], expectedByRow: ReadonlyMap<number, number>): void {
  if (rows.length !== expectedByRow.size || rows.some((row) => expectedByRow.get(row.row_id) !== row.product_id)) {
    throw new Error('Created-product checkpoint rows do not match the queued reprice payload.')
  }
}

function mappingsMatchCreatedRows(rows: CreatedRow[], mappings: MappingRow[]): boolean {
  const expectedByProduct = new Map(rows.map((row) => [row.product_id, row.group_id]))
  if (mappings.length !== expectedByProduct.size) return false
  return mappings.every((mapping) => expectedByProduct.get(mapping.product_id) === mapping.sweed_group_id)
}

async function setRepriceBatch(db: Queryable, rowIds: number[], proposalBatchId: number): Promise<void> {
  if (rowIds.length === 0) return
  await db.query(
    `update pending_purchase_rows
     set last_apply_summary_json = jsonb_set(jsonb_set(last_apply_summary_json, '{pendingPurchaseCreatedSku,repriceBatchId}', to_jsonb($2::bigint), true), '{pendingPurchaseCreatedSku,repriceState}', '"queued"'::jsonb, true),
         updated_at = now()
     where id = any($1::bigint[])`,
    [rowIds, proposalBatchId],
  )
}

async function loadCategoricalBrandCohort(db: Queryable, createdGroupIds: number[]): Promise<number[]> {
  const result = await db.query<CohortRow>(
    `with created_cohorts as (
       select distinct lower(brand_name) as brand_name, lower(category_name) as category_name,
              lower(coalesce(subcategory_name, '')) as subcategory_name
       from catalog_groups where id = any($1::bigint[])
     )
     select cg.id from catalog_groups cg join created_cohorts cc
       on lower(cg.brand_name) = cc.brand_name and lower(cg.category_name) = cc.category_name
      and lower(coalesce(cg.subcategory_name, '')) = cc.subcategory_name
     order by cg.id`,
    [createdGroupIds],
  )
  return result.rows.map((row) => row.id)
}

export const __test__ = { assertExpectedCreatedRows, CREATED_ROWS_SQL, loadCategoricalBrandCohort, mappingsMatchCreatedRows }
