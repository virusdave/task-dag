import { randomUUID } from 'node:crypto'

import type { QueryResultRow } from 'pg'
import { z } from 'zod'

import type { ProposalGeneratePricingBatchJobPayload } from '../../shared/contracts/index.js'
import { DEFAULT_PRICING_GENERATOR_MODEL, DEFAULT_PRICING_PROMPT_VERSION } from '../../shared/domain/pricingGeneration.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { NormalizedCatalogGroupLiveStateSchema } from '../catalog/liveState.js'
import {
  buildPricingMerchandisingContext,
  buildPricingPlan,
  formatPricingPlanText,
  serializePricingPlan,
} from '../pricing/deterministicPricing.js'
import { buildPricingFamilyContext } from '../pricing/familyPricing.js'
import { buildPricingMarketContextWithFailureHandling } from '../pricing/litAlertsMarket.js'
import { isRetryableWorkerError } from '../runtime/errors.js'
import { runCatalogSyncGroupDetailJob } from './syncGroupDetailJob.js'

const GeneratedBatchConfigSchema = z.object({
  catalogGroupIds: z.array(z.number().int().positive()).min(1),
  forceLiveRefresh: z.boolean().default(false),
  scopedProductIds: z.array(z.number().int().positive()).optional(),
})

interface ProposalBatchRow extends QueryResultRow {
  config_json: unknown
  created_by_user_id: number | null
  id: number
  model: string | null
  prompt_version: string | null
  status: 'draft' | 'failed' | 'ready' | 'superseded'
  type: 'description' | 'pricing'
}

interface ExistingProposalRow extends QueryResultRow {
  id: number
}

interface PriorRunRow extends QueryResultRow {
  id: number
}

interface BatchProgressRow extends QueryResultRow {
  generated_group_count: number
  generated_line_item_count: number
}

interface GenerationContextRow extends QueryResultRow {
  live_state_json: unknown
}

interface SnapshotRow extends QueryResultRow {
  id: number
}

interface InsertIdRow extends QueryResultRow {
  id: number
}

interface PricingGenerationContext {
  baselineSnapshotId: number
  liveState: z.infer<typeof NormalizedCatalogGroupLiveStateSchema>
}

export async function runGeneratePricingBatchJob(
  context: { id: number },
  payload: ProposalGeneratePricingBatchJobPayload,
): Promise<void> {
  const batch = await loadProposalBatch(payload.proposalBatchId)
  if (batch.status === 'ready' || batch.status === 'superseded') {
    return
  }

  if (batch.type !== 'pricing') {
    throw new Error(`Proposal batch ${batch.id} is not a pricing batch.`)
  }

  const batchConfig = GeneratedBatchConfigSchema.parse(batch.config_json)
  const forceLiveRefresh = payload.forceLiveRefresh || batchConfig.forceLiveRefresh
  let skippedProductCount = 0

  try {
    for (const catalogGroupId of batchConfig.catalogGroupIds) {
      const alreadyGenerated = await hasProposalRow(batch.id, catalogGroupId)
      if (alreadyGenerated) {
        continue
      }

      const result = await generateProposalRowForCatalogGroup({
        batch,
        catalogGroupId,
        forceLiveRefresh,
        jobId: context.id,
        requestedByUserId: payload.requestedByUserId ?? batch.created_by_user_id,
        scopedProductIds: batchConfig.scopedProductIds,
      })
      skippedProductCount += result.skippedProductCount
      await updateBatchSummary(batch.id, batchConfig.catalogGroupIds.length, skippedProductCount)
    }

    const progress = await updateBatchSummary(batch.id, batchConfig.catalogGroupIds.length, skippedProductCount)
    await withTransaction(async (db) => {
      await db.query(
        `
          update proposal_batches
          set status = 'ready',
              summary_json = $2::jsonb
          where id = $1
        `,
        [
          batch.id,
          JSON.stringify({
            generatedGroupCount: progress.generatedGroupCount,
            generatedLineItemCount: progress.generatedLineItemCount,
            currentCatalogGroupId: null,
            currentGroupName: null,
            requestedGroupCount: batchConfig.catalogGroupIds.length,
            skippedProductCount,
          }),
        ],
      )

      await appendAuditEvent(db, {
        actorType: 'system',
        actorUserId: null,
        entityId: String(batch.id),
        entityType: 'proposal_batch',
        eventType: 'proposal.batch.generated',
        module: 'catalog',
        payload: {
          forceLiveRefresh,
          generatedGroupCount: progress.generatedGroupCount,
          generatedLineItemCount: progress.generatedLineItemCount,
          proposalBatchId: batch.id,
          proposalType: 'pricing',
          requestedGroupCount: batchConfig.catalogGroupIds.length,
          skippedProductCount,
        },
        requestId: randomUUID(),
        undoPayload: null,
      })
    })
  } catch (error) {
    if (!isRetryableWorkerError(error) || (await isFinalAttempt(context.id))) {
      await markBatchFailed(batch.id, batchConfig.catalogGroupIds.length, skippedProductCount, error)
    }

    throw error
  }
}

async function loadProposalBatch(proposalBatchId: number): Promise<ProposalBatchRow> {
  const result = await getPool().query<ProposalBatchRow>(
    `
      select id, type, status, prompt_version, model, config_json, created_by_user_id
      from proposal_batches
      where id = $1
    `,
    [proposalBatchId],
  )

  const row = result.rows[0]
  if (!row) {
    throw new Error(`Proposal batch ${proposalBatchId} not found.`)
  }

  return row
}

async function hasProposalRow(proposalBatchId: number, catalogGroupId: number): Promise<boolean> {
  const result = await getPool().query<ExistingProposalRow>(
    `
      select id
      from proposal_rows
      where proposal_batch_id = $1
        and catalog_group_id = $2
      limit 1
    `,
    [proposalBatchId, catalogGroupId],
  )

  return result.rows.length > 0
}

async function generateProposalRowForCatalogGroup(input: {
  batch: ProposalBatchRow
  catalogGroupId: number
  forceLiveRefresh: boolean
  jobId: number
  requestedByUserId: number | null | undefined
  scopedProductIds?: number[]
}): Promise<{ generatedLineItemCount: number; skippedProductCount: number }> {
  await getPool().query(
    `
      update proposal_batches
      set summary_json = coalesce(summary_json, '{}'::jsonb) || $2::jsonb
      where id = $1
    `,
    [
      input.batch.id,
      JSON.stringify({
        currentCatalogGroupId: input.catalogGroupId,
        currentGroupName: null,
      }),
    ],
  )

  if (input.forceLiveRefresh) {
    await runCatalogSyncGroupDetailJob({
      catalogGroupId: input.catalogGroupId,
      forceLiveRefresh: true,
      requestedByUserId: input.requestedByUserId ?? null,
      trigger: 'manual_refresh',
    })
  }

  const generationContext = await loadGenerationContext(input.catalogGroupId, input.scopedProductIds)
  const familyContext = await buildPricingFamilyContext(generationContext.liveState)
  const marketContext = await buildPricingMarketContextWithFailureHandling({
    failureContext: 'Helios pricing batch failure',
    liveState: generationContext.liveState,
    shouldPageOnFailure: async (error) => !isRetryableWorkerError(error) || (await isFinalAttempt(input.jobId)),
  })
  const pricingPlan = buildPricingPlan(generationContext.liveState, marketContext, familyContext)
  const serializedPricingPlan = serializePricingPlan(pricingPlan)
  await getPool().query(
    `
      update proposal_batches
      set summary_json = coalesce(summary_json, '{}'::jsonb) || $2::jsonb
      where id = $1
    `,
    [
      input.batch.id,
      JSON.stringify({
        currentCatalogGroupId: input.catalogGroupId,
        currentGroupName: generationContext.liveState.groupFullName,
      }),
    ],
  )
  const inputJsonText = JSON.stringify({
    forceLiveRefresh: input.forceLiveRefresh,
    liveState: buildPricingMerchandisingContext(generationContext.liveState, marketContext, familyContext),
  })
  const rawOutputText = formatPricingPlanText(generationContext.liveState, pricingPlan)
  const priorRunId = await loadPriorRunId(input.catalogGroupId)
  const llmRunId = await insertRunningLlmRun({
    catalogGroupId: input.catalogGroupId,
    createdByUserId: input.requestedByUserId ?? input.batch.created_by_user_id,
    forceLiveRefresh: input.forceLiveRefresh,
    jobId: input.jobId,
    model: input.batch.model ?? DEFAULT_PRICING_GENERATOR_MODEL,
    promptVersion: input.batch.prompt_version ?? DEFAULT_PRICING_PROMPT_VERSION,
    supersedesRunId: priorRunId,
  })
  let proposalRowId: number | null = null

  try {
    await withTransaction(async (db) => {
      const proposalRowInsert = await db.query<InsertIdRow>(
        `
          insert into proposal_rows (
            proposal_batch_id,
            catalog_group_id,
            target_entity_type,
            target_entity_id,
            baseline_snapshot_id,
            row_title,
            merchandising_context_json,
            evidence_json,
            source_llm_run_id
          )
          values ($1, $2, 'catalog_group', $3, $4, $5, $6::jsonb, $7::jsonb, $8)
          returning id
        `,
        [
          input.batch.id,
          input.catalogGroupId,
          generationContext.liveState.groupId,
          generationContext.baselineSnapshotId,
          generationContext.liveState.groupFullName,
          JSON.stringify(buildPricingMerchandisingContext(generationContext.liveState, marketContext, familyContext)),
          JSON.stringify(serializedPricingPlan),
          llmRunId,
        ],
      )

      proposalRowId = proposalRowInsert.rows[0].id

      for (const lineItem of pricingPlan.generatedLineItems) {
        await db.query(
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
            values ($1, $2, 'catalog_product', $3, 'products.price', $4::jsonb, $5::jsonb, null, $5::jsonb, 'pending', 1, null, $6::jsonb)
          `,
          [
            proposalRowId,
            input.catalogGroupId,
            lineItem.productId,
            JSON.stringify(lineItem.baselinePrice),
            JSON.stringify(lineItem.proposedPrice),
            JSON.stringify(lineItem.validationIssues),
          ],
        )
      }

      await db.query(
        `
          update llm_runs
          set proposal_row_id = $2,
              input_json = $3::jsonb,
              raw_output_text = $4,
              parsed_output_json = $5::jsonb,
              validation_issues_json = '[]'::jsonb,
              status = 'succeeded'
          where id = $1
        `,
        [llmRunId, proposalRowId, inputJsonText, rawOutputText, JSON.stringify(serializedPricingPlan)],
      )
    })
  } catch (error) {
    await getPool().query(
      `
        update llm_runs
        set proposal_row_id = coalesce($2, proposal_row_id),
            input_json = coalesce($3::jsonb, input_json),
            raw_output_text = $4,
            parsed_output_json = null,
            validation_issues_json = '[]'::jsonb,
            status = 'failed'
        where id = $1
      `,
      [
        llmRunId,
        proposalRowId,
        inputJsonText,
        error instanceof Error ? error.message : 'Unknown pricing generation error.',
      ],
    )
    throw error
  }

  return {
    generatedLineItemCount: pricingPlan.generatedLineItems.length,
    skippedProductCount: pricingPlan.skippedProducts.length,
  }
}

async function loadGenerationContext(catalogGroupId: number, scopedProductIds?: number[]): Promise<PricingGenerationContext> {
  const [liveStateResult, latestSnapshotResult] = await Promise.all([
    getPool().query<GenerationContextRow>(
      `
        select live_state_json
        from catalog_groups
        where id = $1
      `,
      [catalogGroupId],
    ),
    getPool().query<SnapshotRow>(
      `
        select id
        from catalog_group_snapshots
        where catalog_group_id = $1
        order by created_at desc, id desc
        limit 1
      `,
      [catalogGroupId],
    ),
  ])

  const liveStateRow = liveStateResult.rows[0]
  if (!liveStateRow) {
    throw new Error(`Catalog group ${catalogGroupId} has no persisted live state.`)
  }

  const latestSnapshot = latestSnapshotResult.rows[0]
  if (!latestSnapshot) {
    throw new Error(`Catalog group ${catalogGroupId} has no baseline snapshot.`)
  }

  return {
    baselineSnapshotId: latestSnapshot.id,
    liveState: filterScopedProductsFromLiveState(
      NormalizedCatalogGroupLiveStateSchema.parse(liveStateRow.live_state_json),
      scopedProductIds,
    ),
  }
}

export function filterScopedProductsFromLiveState(
  liveState: z.infer<typeof NormalizedCatalogGroupLiveStateSchema>,
  scopedProductIds?: number[],
): z.infer<typeof NormalizedCatalogGroupLiveStateSchema> {
  if (!scopedProductIds || scopedProductIds.length === 0) {
    return liveState
  }

  const scopedProductIdSet = new Set(scopedProductIds)
  const products = liveState.products.filter((product) => scopedProductIdSet.has(product.productId))
  const productTabs = liveState.productTabs.filter((tab) => products.some((product) => product.tab === tab))
  return {
    ...liveState,
    productTabs,
    products,
  }
}

async function loadPriorRunId(catalogGroupId: number): Promise<number | null> {
  const result = await getPool().query<PriorRunRow>(
    `
      select id
      from llm_runs
      where catalog_group_id = $1
        and purpose = 'pricing'
      order by created_at desc, id desc
      limit 1
    `,
    [catalogGroupId],
  )

  return result.rows[0]?.id ?? null
}

async function insertRunningLlmRun(input: {
  catalogGroupId: number
  createdByUserId: number | null | undefined
  forceLiveRefresh: boolean
  jobId: number
  model: string
  promptVersion: string
  supersedesRunId: number | null
}): Promise<number> {
  const result = await getPool().query<InsertIdRow>(
    `
      insert into llm_runs (
        catalog_group_id,
        purpose,
        model,
        prompt_version,
        input_json,
        raw_output_text,
        parsed_output_json,
        validation_issues_json,
        forced_refresh,
        status,
        job_id,
        supersedes_run_id,
        created_by_user_id
      )
      values ($1, 'pricing', $2, $3, '{}'::jsonb, '', null, '[]'::jsonb, $4, 'running', $5, $6, $7)
      returning id
    `,
    [
      input.catalogGroupId,
      input.model,
      input.promptVersion,
      input.forceLiveRefresh,
      input.jobId,
      input.supersedesRunId,
      input.createdByUserId ?? null,
    ],
  )

  return result.rows[0].id
}

async function loadBatchProgress(proposalBatchId: number): Promise<{
  generatedGroupCount: number
  generatedLineItemCount: number
}> {
  const result = await getPool().query<BatchProgressRow>(
    `
      select
        count(distinct pr.id)::int as generated_group_count,
        count(pli.id)::int as generated_line_item_count
      from proposal_rows pr
      left join proposal_line_items pli on pli.proposal_row_id = pr.id
      where pr.proposal_batch_id = $1
    `,
    [proposalBatchId],
  )

  return {
    generatedGroupCount: result.rows[0]?.generated_group_count ?? 0,
    generatedLineItemCount: result.rows[0]?.generated_line_item_count ?? 0,
  }
}

async function updateBatchSummary(
  proposalBatchId: number,
  requestedGroupCount: number,
  skippedProductCount: number,
): Promise<{
  generatedGroupCount: number
  generatedLineItemCount: number
}> {
  const progress = await loadBatchProgress(proposalBatchId)

  await getPool().query(
    `
      update proposal_batches
      set summary_json = coalesce(summary_json, '{}'::jsonb) || $2::jsonb
      where id = $1
    `,
    [
      proposalBatchId,
      JSON.stringify({
        generatedGroupCount: progress.generatedGroupCount,
        generatedLineItemCount: progress.generatedLineItemCount,
        requestedGroupCount,
        skippedProductCount,
      }),
    ],
  )

  return progress
}

async function markBatchFailed(
  proposalBatchId: number,
  requestedGroupCount: number,
  skippedProductCount: number,
  error: unknown,
): Promise<void> {
  const progress = await loadBatchProgress(proposalBatchId)

  await getPool().query(
    `
      update proposal_batches
      set status = 'failed',
          summary_json = $2::jsonb
      where id = $1
    `,
    [
      proposalBatchId,
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown pricing batch failure.',
        generatedGroupCount: progress.generatedGroupCount,
        generatedLineItemCount: progress.generatedLineItemCount,
        currentCatalogGroupId: null,
        currentGroupName: null,
        requestedGroupCount,
        skippedProductCount,
      }),
    ],
  )
}

async function isFinalAttempt(jobId: number): Promise<boolean> {
  const result = await getPool().query<{ attempt_count: number }>(
    `
      select attempt_count
      from job_queue
      where id = $1
    `,
    [jobId],
  )

  return (result.rows[0]?.attempt_count ?? 0) >= 3
}
