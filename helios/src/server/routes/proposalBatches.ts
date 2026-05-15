import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import {
  DEFAULT_DESCRIPTION_LLM_MODEL,
  DEFAULT_DESCRIPTION_PROMPT_VERSION,
} from '../../shared/domain/descriptionGeneration.js'
import {
  DEFAULT_PRICING_GENERATOR_MODEL,
  DEFAULT_PRICING_PROMPT_VERSION,
} from '../../shared/domain/pricingGeneration.js'
import {
  MutationAcceptedResponseSchema,
  QueueProposalBatchRequestSchema,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getOptionalSweedSessionConcurrencyKey } from '../jobs/concurrency.js'
import { withTransaction } from '../db/tx.js'
import { enqueueJob } from '../jobs/enqueueJob.js'

export async function registerProposalBatchRoutes(server: FastifyInstance): Promise<void> {
  server.post('/api/proposal-batches', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const body = QueueProposalBatchRequestSchema.parse(request.body ?? {})
    const catalogGroupIds = [...new Set(body.catalogGroupIds)].sort((left, right) => left - right)
    const requestId = randomUUID()
    const isDescriptionBatch = body.proposalType === 'description'

    const mutationResult = await withTransaction(async (db) => {
      const existingGroupsResult = await db.query<{ id: number }>(
        `
          select id
          from catalog_groups
          where id = any($1::bigint[])
        `,
        [catalogGroupIds],
      )

      const existingGroupIds = new Set(existingGroupsResult.rows.map((row) => row.id))
      const missingGroupIds = catalogGroupIds.filter((catalogGroupId) => !existingGroupIds.has(catalogGroupId))
      if (missingGroupIds.length > 0) {
        throw new Error(`Unknown catalog groups: ${missingGroupIds.join(', ')}`)
      }

      const proposalBatchInsert = await db.query<{ id: number }>(
        `
          insert into proposal_batches (
            type,
            source,
            trigger_mode,
            status,
            prompt_version,
            model,
            summary_json,
            config_json,
            created_by_user_id
          )
          values ($1, 'generated', 'ui', 'draft', $2, $3, $4::jsonb, $5::jsonb, $6)
          returning id
        `,
        [
          body.proposalType,
          isDescriptionBatch ? DEFAULT_DESCRIPTION_PROMPT_VERSION : DEFAULT_PRICING_PROMPT_VERSION,
          isDescriptionBatch ? DEFAULT_DESCRIPTION_LLM_MODEL : DEFAULT_PRICING_GENERATOR_MODEL,
          JSON.stringify({
            generatedGroupCount: 0,
            generatedLineItemCount: 0,
            requestedGroupCount: catalogGroupIds.length,
          }),
          JSON.stringify({
            catalogGroupIds,
            forceLiveRefresh: body.forceLiveRefresh,
          }),
          user.id,
        ],
      )

      const proposalBatchId = proposalBatchInsert.rows[0].id
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(body.forceLiveRefresh),
        dedupeKey: `proposal.generate.${body.proposalType}_batch:${proposalBatchId}`,
        jobType: body.proposalType === 'description' ? 'proposal.generate.description_batch' : 'proposal.generate.pricing_batch',
        module: 'catalog',
        payload: {
          forceLiveRefresh: body.forceLiveRefresh,
          proposalBatchId,
          requestedByUserId: user.id,
          trigger: 'ui_generate',
        },
        requestedByUserId: user.id,
      })

      await db.query('update proposal_batches set job_id = $2 where id = $1', [proposalBatchId, jobId])

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(proposalBatchId),
        entityType: 'proposal_batch',
        eventType: 'proposal.batch.generation_requested',
        module: 'catalog',
        payload: {
          catalogGroupIds,
          forceLiveRefresh: body.forceLiveRefresh,
          proposalBatchId,
          proposalType: body.proposalType,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
        },
        requestId,
        undoPayload: null,
      })

      return { auditEventId, jobId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: mutationResult.auditEventId,
        jobId: mutationResult.jobId,
        requestId,
      }),
    )
  })
}
