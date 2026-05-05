import type { QueryResultRow } from 'pg'

import type { LlmDebugRerunJobPayload } from '../../shared/contracts/domain/jobs.js'
import { getPool } from '../../server/db/pool.js'
import { runCatalogSyncGroupDetailJob } from './syncGroupDetailJob.js'
import { NormalizedCatalogGroupLiveStateSchema } from '../catalog/liveState.js'
import { parsePreviousProposalContext, runDescriptionDebugRerun } from '../llm/descriptionDebugRerun.js'
import {
  buildPricingMerchandisingContext,
  buildPricingPlan,
  formatPricingPlanText,
  serializePricingPlan,
} from '../pricing/deterministicPricing.js'
import { buildPricingFamilyContext } from '../pricing/familyPricing.js'
import { buildPricingMarketContextWithFailureHandling } from '../pricing/litAlertsMarket.js'
import { isRetryableWorkerError } from '../runtime/errors.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

interface LlmRunRow extends QueryResultRow {
  catalog_group_id: number
  forced_refresh: boolean
  id: number
  model: string
  prompt_version: string
  purpose: 'debug' | 'description' | 'pricing'
  status: string
}

interface LatestProposalContextRow extends QueryResultRow {
  evidence_json: unknown
  merchandising_context_json: unknown
  proposal_row_id: number
}

interface LiveStateRow extends QueryResultRow {
  live_state_json: unknown
}

interface PriorRunRow extends QueryResultRow {
  id: number
}

interface LatestPricingProposalContextRow extends QueryResultRow {
  evidence_json: unknown
  merchandising_context_json: unknown
  proposal_row_id: number
}

export async function runLlmDebugRerunJob(context: JobHandlerContext, payload: LlmDebugRerunJobPayload): Promise<void> {
  const llmRun = await loadAndMarkRunning(payload.llmRunId, payload.catalogGroupId)
  let proposalRowId: number | null = null
  let inputJsonText: string | null = null

  try {
    if (payload.forceLiveRefresh || llmRun.forced_refresh) {
      await runCatalogSyncGroupDetailJob({
        catalogGroupId: payload.catalogGroupId,
        forceLiveRefresh: true,
        requestedByUserId: payload.requestedByUserId,
        trigger: 'manual_refresh',
      })
    }

    if (llmRun.purpose === 'pricing') {
      const { liveState, previousProposalContext } = await loadPricingGenerationContext(payload.catalogGroupId)
      const familyContext = await buildPricingFamilyContext(liveState)
      const marketContext = await buildPricingMarketContextWithFailureHandling({
        failureContext: 'Helios pricing debug rerun failure',
        liveState,
        shouldPageOnFailure: async (error) => !isRetryableWorkerError(error) || (await isFinalAttempt(context.id)),
      })
      const pricingPlan = buildPricingPlan(liveState, marketContext, familyContext)
      proposalRowId = previousProposalContext?.proposalRowId ?? null
      inputJsonText = JSON.stringify({
        forceLiveRefresh: payload.forceLiveRefresh || llmRun.forced_refresh,
        liveState: buildPricingMerchandisingContext(liveState, marketContext, familyContext),
        previousProposalContext: previousProposalContext
          ? {
              evidence: previousProposalContext.evidenceJson,
              merchandisingContext: previousProposalContext.merchandisingContextJson,
              proposalRowId: previousProposalContext.proposalRowId,
            }
          : null,
      })

      await getPool().query(
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
        [
          llmRun.id,
          proposalRowId,
          inputJsonText,
          formatPricingPlanText(liveState, pricingPlan),
          JSON.stringify(serializePricingPlan(pricingPlan)),
        ],
      )
      return
    }

    const { liveState, previousProposalContext } = await loadGenerationContext(payload.catalogGroupId)
    proposalRowId = previousProposalContext?.proposalRowId ?? null

    const result = await runDescriptionDebugRerun({
      forceLiveRefresh: payload.forceLiveRefresh || llmRun.forced_refresh,
      liveState,
      llmRunId: llmRun.id,
      model: llmRun.model,
      previousProposalContext,
      promptVersion: llmRun.prompt_version,
      purpose: llmRun.purpose === 'debug' ? 'debug' : 'description',
    })

    inputJsonText = JSON.stringify(result.inputJson)

    await getPool().query(
      `
        update llm_runs
        set proposal_row_id = $2,
            input_json = $3::jsonb,
            raw_output_text = $4,
            parsed_output_json = $5::jsonb,
            validation_issues_json = $6::jsonb,
            status = $7
        where id = $1
      `,
      [
        llmRun.id,
        proposalRowId,
        inputJsonText,
        result.rawOutputText,
        JSON.stringify(result.parsedOutputJson),
        JSON.stringify(result.validationIssues),
        result.status,
      ],
    )
  } catch (error) {
    if (isRetryableWorkerError(error)) {
      await getPool().query(
        `
          update llm_runs
          set proposal_row_id = coalesce($2, proposal_row_id),
              input_json = coalesce($3::jsonb, input_json),
              raw_output_text = $4,
              parsed_output_json = null,
              validation_issues_json = '[]'::jsonb,
              status = 'queued'
          where id = $1
        `,
        [llmRun.id, proposalRowId, inputJsonText, error.message],
      )
      throw error
    }

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
        llmRun.id,
        proposalRowId,
        inputJsonText,
        error instanceof Error ? error.message : 'Unknown LLM rerun error.',
      ],
    )
    throw error
  }
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

async function loadAndMarkRunning(llmRunId: number, catalogGroupId: number): Promise<LlmRunRow> {
  const llmRunResult = await getPool().query<LlmRunRow>(
    `
      select id, catalog_group_id, purpose, model, prompt_version, forced_refresh, status
      from llm_runs
      where id = $1
    `,
    [llmRunId],
  )

  const llmRun = llmRunResult.rows[0]
  if (!llmRun) {
    throw new Error(`LLM run ${llmRunId} not found.`)
  }
  if (llmRun.catalog_group_id !== catalogGroupId) {
    throw new Error(`LLM run ${llmRunId} does not belong to catalog group ${catalogGroupId}.`)
  }

  const priorRunResult = await getPool().query<PriorRunRow>(
    `
      select id
      from llm_runs
      where catalog_group_id = $1
        and purpose = $2
        and id <> $3
      order by created_at desc, id desc
      limit 1
    `,
    [catalogGroupId, llmRun.purpose, llmRunId],
  )

  await getPool().query(
    `
      update llm_runs
      set status = 'running',
          supersedes_run_id = $2
      where id = $1
    `,
    [llmRunId, priorRunResult.rows[0]?.id ?? null],
  )

  return llmRun
}

async function loadGenerationContext(catalogGroupId: number): Promise<{
  liveState: ReturnType<typeof NormalizedCatalogGroupLiveStateSchema.parse>
  previousProposalContext: ReturnType<typeof parsePreviousProposalContext> | null
}> {
  const [liveStateResult, proposalContextResult] = await Promise.all([
    getPool().query<LiveStateRow>(
      `
        select live_state_json
        from catalog_groups
        where id = $1
      `,
      [catalogGroupId],
    ),
    getPool().query<LatestProposalContextRow>(
      `
        select
          pr.id as proposal_row_id,
          pr.evidence_json,
          pr.merchandising_context_json
        from proposal_rows pr
        inner join proposal_line_items pli on pli.proposal_row_id = pr.id
        where pr.catalog_group_id = $1
          and pli.field_path = 'description'
        order by pr.created_at desc, pr.id desc
        limit 1
      `,
      [catalogGroupId],
    ),
  ])

  const liveStateRow = liveStateResult.rows[0]
  if (!liveStateRow) {
    throw new Error(`Catalog group ${catalogGroupId} has no persisted live state.`)
  }

  return {
    liveState: NormalizedCatalogGroupLiveStateSchema.parse(liveStateRow.live_state_json),
    previousProposalContext: proposalContextResult.rows[0]
      ? parsePreviousProposalContext({
          evidenceJson: proposalContextResult.rows[0].evidence_json,
          merchandisingContextJson: proposalContextResult.rows[0].merchandising_context_json,
          proposalRowId: proposalContextResult.rows[0].proposal_row_id,
        })
      : null,
  }
}

async function loadPricingGenerationContext(catalogGroupId: number): Promise<{
  liveState: ReturnType<typeof NormalizedCatalogGroupLiveStateSchema.parse>
  previousProposalContext: {
    evidenceJson: unknown
    merchandisingContextJson: unknown
    proposalRowId: number
  } | null
}> {
  const [liveStateResult, proposalContextResult] = await Promise.all([
    getPool().query<LiveStateRow>(
      `
        select live_state_json
        from catalog_groups
        where id = $1
      `,
      [catalogGroupId],
    ),
    getPool().query<LatestPricingProposalContextRow>(
      `
        select
          pr.id as proposal_row_id,
          pr.evidence_json,
          pr.merchandising_context_json
        from proposal_rows pr
        inner join proposal_line_items pli on pli.proposal_row_id = pr.id
        where pr.catalog_group_id = $1
          and pli.field_path = 'products.price'
        order by pr.created_at desc, pr.id desc
        limit 1
      `,
      [catalogGroupId],
    ),
  ])

  const liveStateRow = liveStateResult.rows[0]
  if (!liveStateRow) {
    throw new Error(`Catalog group ${catalogGroupId} has no persisted live state.`)
  }

  return {
    liveState: NormalizedCatalogGroupLiveStateSchema.parse(liveStateRow.live_state_json),
    previousProposalContext: proposalContextResult.rows[0]
      ? {
          evidenceJson: proposalContextResult.rows[0].evidence_json,
          merchandisingContextJson: proposalContextResult.rows[0].merchandising_context_json,
          proposalRowId: proposalContextResult.rows[0].proposal_row_id,
        }
      : null,
  }
}
