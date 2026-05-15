import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  buildCatalogGroupModuleScope,
  CatalogGroupRouteParamsSchema,
  LlmRunDetailResponseSchema,
  LlmRunRouteParamsSchema,
  MutationAcceptedResponseSchema,
} from '../../shared/contracts/index.js'
import { DEFAULT_DESCRIPTION_LLM_MODEL, DEFAULT_DESCRIPTION_PROMPT_VERSION } from '../../shared/domain/descriptionGeneration.js'
import { DEFAULT_PRICING_GENERATOR_MODEL, DEFAULT_PRICING_PROMPT_VERSION } from '../../shared/domain/pricingGeneration.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { getLlmRunDetail } from '../db/queries/llmQueries.js'
import { getOptionalSweedSessionConcurrencyKey } from '../jobs/concurrency.js'
import { withTransaction } from '../db/tx.js'
import { enqueueJob } from '../jobs/enqueueJob.js'

const CreateLlmRerunRequestSchema = z.object({
  forceLiveRefresh: z.boolean().default(false),
  model: z.string().trim().min(1).optional(),
  promptVersion: z.string().trim().min(1).optional(),
  purpose: z.enum(['description', 'pricing', 'debug']).default('description'),
})

export async function registerLlmRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/llm/runs/:llmRunId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const params = LlmRunRouteParamsSchema.parse(request.params)
    const response = await getLlmRunDetail(getPool(), params.llmRunId)
    if (!response) {
      return reply.status(404).send({ error: 'LLM run not found.' })
    }

    return reply.send(LlmRunDetailResponseSchema.parse(response))
  })

  server.post('/api/catalog-groups/:catalogGroupId/llm-reruns', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const params = CatalogGroupRouteParamsSchema.parse(request.params)
    const body = CreateLlmRerunRequestSchema.parse(request.body ?? {})
    const requestId = randomUUID()
    const defaults = resolveGeneratorIdentity(body.purpose, body.model, body.promptVersion)

    const result = await withTransaction(async (db) => {
      const scope = buildCatalogGroupModuleScope(params.catalogGroupId)
      const llmRunInsert = await db.query<{ id: number }>(
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
            created_by_user_id
          )
          values ($1, $2, $3, $4, '{}'::jsonb, '', null, '[]'::jsonb, $5, 'queued', $6)
          returning id
        `,
        [
          params.catalogGroupId,
          body.purpose,
          defaults.model,
          defaults.promptVersion,
          body.forceLiveRefresh,
          user.id,
        ],
      )

      const llmRunId = llmRunInsert.rows[0].id
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(body.forceLiveRefresh),
        jobType: 'llm.debug.rerun',
        module: 'catalog',
        payload: {
          catalogGroupId: params.catalogGroupId,
          forceLiveRefresh: body.forceLiveRefresh,
          llmRunId,
          purpose: body.purpose,
          requestedByUserId: user.id,
        },
        requestedByUserId: user.id,
        scope,
      })

      await db.query('update llm_runs set job_id = $2 where id = $1', [llmRunId, jobId])

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(llmRunId),
        entityType: 'llm_run',
        eventType: 'llm.run.rerun_requested',
        module: 'catalog',
        payload: {
          catalogGroupId: params.catalogGroupId,
          forcedRefresh: body.forceLiveRefresh,
          purpose: body.purpose,
          queuedJobId: jobId,
          supersedesRunId: null,
        },
        requestId,
        scope,
        undoPayload: null,
      })

      return { auditEventId, jobId }
    })

    return reply.send(MutationAcceptedResponseSchema.parse({ auditEventId: result.auditEventId, jobId: result.jobId, requestId }))
  })
}

function resolveGeneratorIdentity(
  purpose: 'debug' | 'description' | 'pricing',
  model: string | undefined,
  promptVersion: string | undefined,
): { model: string; promptVersion: string } {
  if (purpose === 'pricing') {
    return {
      model: model ?? DEFAULT_PRICING_GENERATOR_MODEL,
      promptVersion: promptVersion ?? DEFAULT_PRICING_PROMPT_VERSION,
    }
  }

  return {
    model: model ?? DEFAULT_DESCRIPTION_LLM_MODEL,
    promptVersion: promptVersion ?? DEFAULT_DESCRIPTION_PROMPT_VERSION,
  }
}
