import { randomUUID } from 'node:crypto'

import type { QueryResultRow } from 'pg'
import { z } from 'zod'

import type {
  ProposalGenerateDescriptionBatchJobPayload,
  ValidationIssue,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { NormalizedCatalogGroupLiveStateSchema } from '../catalog/liveState.js'
import { getWorkerEnv } from '../config/env.js'
import { parsePreviousProposalContext, runDescriptionDebugRerun } from '../llm/descriptionDebugRerun.js'
import { isRetryableWorkerError } from '../runtime/errors.js'
import { runCatalogSyncGroupDetailJob } from './syncGroupDetailJob.js'

const GeneratedBatchConfigSchema = z.object({
  catalogGroupIds: z.array(z.number().int().positive()).min(1),
  forceLiveRefresh: z.boolean().default(false),
})

const GeneratedDescriptionOutputSchema = z.object({
  attemptCount: z.number().int().positive().nullable().optional(),
  confidence: z.string().nullable().optional(),
  matchedLitalertsListingIndexes: z.array(z.number().int()).nullable().optional(),
  matchedLitalertsListings: z.array(z.unknown()).default([]),
  omittedRequiredPhrases: z.array(z.string()).default([]),
  proposedDescription: z.string(),
  requiredPhrasePresence: z.record(z.string(), z.boolean()).default({}),
  seoKeywords: z.array(z.string()).default([]),
  validationIssues: z.array(z.string()).default([]),
}).passthrough()

interface ProposalBatchRow extends QueryResultRow {
  config_json: unknown
  created_by_user_id: number | null
  id: number
  model: string
  prompt_version: string
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

interface ProposalContextRow extends QueryResultRow {
  evidence_json: unknown
  merchandising_context_json: unknown
  proposal_row_id: number
}

interface SnapshotRow extends QueryResultRow {
  id: number
}

interface InsertIdRow extends QueryResultRow {
  id: number
}

export async function runGenerateDescriptionBatchJob(
  context: { id: number },
  payload: ProposalGenerateDescriptionBatchJobPayload,
): Promise<void> {
  const batch = await loadProposalBatch(payload.proposalBatchId)
  if (batch.status === 'ready' || batch.status === 'superseded') {
    return
  }

  if (batch.type !== 'description') {
    throw new Error(`Proposal batch ${batch.id} is not a description batch.`)
  }

  const batchConfig = GeneratedBatchConfigSchema.parse(batch.config_json)
  const forceLiveRefresh = payload.forceLiveRefresh || batchConfig.forceLiveRefresh

  try {
    for (const catalogGroupId of batchConfig.catalogGroupIds) {
      const alreadyGenerated = await hasProposalRow(batch.id, catalogGroupId)
      if (alreadyGenerated) {
        continue
      }

      await generateProposalRowForCatalogGroup({
        batch,
        catalogGroupId,
        forceLiveRefresh,
        jobId: context.id,
        requestedByUserId: payload.requestedByUserId ?? batch.created_by_user_id,
      })
    }

    const progress = await loadBatchProgress(batch.id)
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
            requestedGroupCount: batchConfig.catalogGroupIds.length,
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
          proposalType: 'description',
          requestedGroupCount: batchConfig.catalogGroupIds.length,
        },
        requestId: randomUUID(),
        undoPayload: null,
      })
    })
  } catch (error) {
    if (!isRetryableWorkerError(error) || (await isFinalAttempt(context.id))) {
      await markBatchFailed(batch.id, batchConfig.catalogGroupIds.length, error)
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
}): Promise<void> {
  if (input.forceLiveRefresh) {
    await runCatalogSyncGroupDetailJob({
      catalogGroupId: input.catalogGroupId,
      forceLiveRefresh: true,
      requestedByUserId: input.requestedByUserId ?? null,
      trigger: 'manual_refresh',
    })
  }

  const generationContext = await loadGenerationContext(input.catalogGroupId)
  const priorRunId = await loadPriorRunId(input.catalogGroupId)
  const llmRunId = await insertRunningLlmRun({
    catalogGroupId: input.catalogGroupId,
    createdByUserId: input.requestedByUserId ?? input.batch.created_by_user_id,
    forceLiveRefresh: input.forceLiveRefresh,
    jobId: input.jobId,
    model: input.batch.model,
    promptVersion: input.batch.prompt_version,
    supersedesRunId: priorRunId,
  })

  try {
    const result = await runDescriptionDebugRerun({
      forceLiveRefresh: input.forceLiveRefresh,
      liveState: generationContext.liveState,
      llmRunId,
      model: input.batch.model,
      previousProposalContext: generationContext.previousProposalContext,
      promptVersion: input.batch.prompt_version,
      purpose: 'description',
    })
    const parsedOutput = GeneratedDescriptionOutputSchema.parse(result.parsedOutputJson)
    const validationIssues = buildValidationIssues(result.validationIssues, result.status)

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
          JSON.stringify({
            confidence: parsedOutput.confidence ?? null,
            currentDescription: generationContext.liveState.currentDescription,
            seoKeywords: parsedOutput.seoKeywords,
          }),
          JSON.stringify({
            attemptCount: parsedOutput.attemptCount ?? null,
            litalertsCandidateListings:
              generationContext.previousProposalContext?.evidence.litalertsCandidateListings ??
              generationContext.previousProposalContext?.evidence.litalertsMatchedListings ??
              [],
            litalertsMatchedListings: parsedOutput.matchedLitalertsListings,
            litalertsSearchTerms: generationContext.previousProposalContext?.evidence.litalertsSearchTerms ?? [],
            litalertsSelectedListingIndexes: parsedOutput.matchedLitalertsListingIndexes ?? [],
            litalertsSourceNote: generationContext.previousProposalContext?.evidence.litalertsSourceNote ?? null,
            omittedRequiredPhrases: parsedOutput.omittedRequiredPhrases,
            originalDescription: generationContext.liveState.currentDescription,
            requiredPhrasePresence: parsedOutput.requiredPhrasePresence,
          }),
          llmRunId,
        ],
      )

      const proposalRowId = proposalRowInsert.rows[0].id

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
          values ($1, $2, 'catalog_group', $3, 'description', $4::jsonb, $5::jsonb, null, $5::jsonb, 'pending', 1, null, $6::jsonb)
        `,
        [
          proposalRowId,
          input.catalogGroupId,
          generationContext.liveState.groupId,
          JSON.stringify(generationContext.liveState.currentDescription),
          JSON.stringify(parsedOutput.proposedDescription),
          JSON.stringify(validationIssues),
        ],
      )

      await db.query(
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
          llmRunId,
          proposalRowId,
          JSON.stringify(result.inputJson),
          result.rawOutputText,
          JSON.stringify(result.parsedOutputJson),
          JSON.stringify(result.validationIssues),
          result.status,
        ],
      )
    })
  } catch (error) {
    await getPool().query(
      `
        update llm_runs
        set raw_output_text = $2,
            parsed_output_json = null,
            validation_issues_json = '[]'::jsonb,
            status = 'failed'
        where id = $1
      `,
      [llmRunId, error instanceof Error ? error.message : 'Unknown description generation error.'],
    )
    throw error
  }
}

async function loadGenerationContext(catalogGroupId: number): Promise<{
  baselineSnapshotId: number
  liveState: z.infer<typeof NormalizedCatalogGroupLiveStateSchema>
  previousProposalContext: ReturnType<typeof parsePreviousProposalContext> | null
}> {
  const [liveStateResult, latestSnapshotResult, proposalContextResult] = await Promise.all([
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
    getPool().query<ProposalContextRow>(
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

  const latestSnapshot = latestSnapshotResult.rows[0]
  if (!latestSnapshot) {
    throw new Error(`Catalog group ${catalogGroupId} has no baseline snapshot.`)
  }

  return {
    baselineSnapshotId: latestSnapshot.id,
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

async function loadPriorRunId(catalogGroupId: number): Promise<number | null> {
  const result = await getPool().query<PriorRunRow>(
    `
      select id
      from llm_runs
      where catalog_group_id = $1
        and purpose = 'description'
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
      values ($1, 'description', $2, $3, '{}'::jsonb, '', null, '[]'::jsonb, $4, 'running', $5, $6, $7)
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

async function markBatchFailed(
  proposalBatchId: number,
  requestedGroupCount: number,
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
        error: error instanceof Error ? error.message : 'Unknown description batch failure.',
        generatedGroupCount: progress.generatedGroupCount,
        generatedLineItemCount: progress.generatedLineItemCount,
        requestedGroupCount,
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

  return (result.rows[0]?.attempt_count ?? 0) >= getWorkerEnv().workerMaxAttempts
}

function buildValidationIssues(
  issues: string[],
  status: 'invalid' | 'succeeded',
): ValidationIssue[] {
  const severity: ValidationIssue['severity'] = status === 'invalid' ? 'error' : 'warning'
  return issues.map((detail) => ({
    code: 'llm_validation',
    detail,
    severity,
  }))
}
