/**
 * Agent-waste review-queue API routes (Fastify) — issue #57.
 *
 * ADMIN-GATED. The observations here are an internal operator surface; the
 * navbar entry is hidden for non-admins client-side, but THIS route is the
 * access control (hiding a nav entry is not access control). Admin ==
 * `canManageUsers`, which maps to role `admin` (see
 * shared/domain/permissions.ts) — enforced server-side via
 * requireSessionUser(..., 'admin').
 *
 * The endpoint degrades gracefully: when the backlog source is unavailable
 * it returns a structured 503 (`agent_waste_unavailable`) with the source
 * status instead of a raw 500, mirroring routes/taskDag.ts.
 */

import type { FastifyInstance, FastifyReply } from 'fastify'

import { requireSessionUser } from '../auth/requireSession.js'
import {
  AgentWasteUnavailableError,
  getBacklog,
  getBacklogSourceStatus,
} from '../agentWasteRepo.js'
import { promoteAdvisory } from '../agentWaste/promoteAdvisory.js'
import { callClusterModel, ClusterModelError } from '../agentWaste/clusterModel.js'
import {
  CLUSTER_BATCH_SIZE,
  compareClustersByWaste,
  rehydrateClusters,
} from '../agentWaste/clusterBacklog.js'
import { getServerEnv } from '../config/env.js'
import { getPool } from '../db/pool.js'
import { resolveBedrockModel } from '../llm/bedrockModelConfig.js'
import {
  AgentWasteClustersRequestSchema,
  PromoteAdvisoryRequestSchema,
  type AgentWasteBacklogResponse,
  type AgentWasteClustersResponse,
  type PromoteAdvisoryErrorResponse,
  type PromoteAdvisoryFailureCode,
  type PromoteAdvisoryResponse,
} from '../../shared/contracts/api/agentWaste.js'

/** Body cap for the promote route — a single advisory entry is tiny. */
const PROMOTE_BODY_LIMIT_BYTES = 64 * 1024

/** Body cap for the cluster route — the request body is an empty object. */
const CLUSTER_BODY_LIMIT_BYTES = 4 * 1024

/** Map a cluster-model failure to an HTTP status (mirrors LLM route patterns). */
function clusterModelStatus(code: ClusterModelError['code']): number {
  return code === 'bedrock_unconfigured' ? 503 : 502
}

/** Map a structured promote failure to an HTTP status. */
function promoteFailureStatus(code: PromoteAdvisoryFailureCode): number {
  switch (code) {
    case 'agent_pain_points_unavailable':
      return 503
    case 'invalid_request':
      return 400
    case 'id_exists':
      return 409
    case 'no_op':
      return 409
    case 'catalog_current_invalid':
    case 'catalog_result_invalid':
    case 'catalog_edit_unsupported':
    case 'unexpected_staged_changes':
    case 'git_command_failed':
    case 'git_push_failed':
      return 502
    default:
      return 500
  }
}

export function handleAgentWasteError(
  server: FastifyInstance,
  reply: FastifyReply,
  error: unknown,
  context: string,
): FastifyReply {
  if (error instanceof AgentWasteUnavailableError) {
    return reply.status(503).send({
      error: 'agent_waste_unavailable',
      message: 'Agent-waste backlog data is temporarily unavailable.',
      source: error.status,
    })
  }
  server.log.error(error, context)
  return reply.status(500).send({ error: context })
}

export async function registerAgentWasteRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/agent-waste/backlog - observations awaiting human review.
  server.get('/api/agent-waste/backlog', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'admin')
    if (!actor) {
      return
    }
    try {
      const observations = await getBacklog()
      const body: AgentWasteBacklogResponse = {
        source: getBacklogSourceStatus(),
        observations,
      }
      return reply.send(body)
    } catch (error) {
      return handleAgentWasteError(server, reply, error, 'Failed to fetch agent-waste backlog')
    }
  })

  // POST /api/agent-waste/promote - promote a reviewed observation into the
  // reviewed advisory catalog (advisories.yaml in virusdave/agent-pain-points). This
  // is a BEHAVIOR-CHANGING mutation (the selector may inject the advisory's
  // `text` into future agents), so it is admin-gated (an admin submitting this
  // request IS the operator-approval safety gate), server-side
  // contract-validated, committed, and pushed. LLM-drafted text is fine once
  // operator-approved; the observation's display-only `note` is not accepted
  // here, so a free-form note is never silently routed into the committed text.
  server.post(
    '/api/agent-waste/promote',
    { bodyLimit: PROMOTE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const actor = await requireSessionUser(request, reply, 'admin')
      if (!actor) {
        return
      }

      const parsed = PromoteAdvisoryRequestSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        const body: PromoteAdvisoryErrorResponse = {
          ok: false,
          code: 'invalid_request',
          message: parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; '),
        }
        return reply.status(400).send(body)
      }

      try {
        const result = await promoteAdvisory({
          request: parsed.data,
          actorEmail: actor.email,
          actorUserId: actor.id,
          requestId: request.id ?? null,
        })
        if (result.ok) {
          // Audit: the agent-pain-points commit is the primary immutable record; this
          // structured log line gives in-Helios traceability of every
          // promotion (actor, advisory id, source observation, commit).
          server.log.info(
            {
              event: 'agent_waste.advisory_promoted',
              advisoryId: result.id,
              sourceObservationId: parsed.data.sourceObservationId,
              actorUserId: actor.id,
              actorEmail: actor.email,
              commitSha: result.commitSha,
              pushed: result.pushed,
            },
            'agent-waste advisory promoted',
          )
          const body: PromoteAdvisoryResponse = {
            ok: true,
            id: result.id,
            relPath: result.relPath,
            commitSha: result.commitSha,
            commitUrl: result.commitUrl,
            pushed: result.pushed,
          }
          return reply.status(200).send(body)
        }
        const body: PromoteAdvisoryErrorResponse = {
          ok: false,
          code: result.code,
          message: result.message,
        }
        return reply.status(promoteFailureStatus(result.code)).send(body)
      } catch (error) {
        return handleAgentWasteError(server, reply, error, 'Failed to promote agent-waste advisory')
      }
    },
  )

  // POST /api/agent-waste/clusters - cluster the pending backlog by theme via
  // an advanced private Bedrock model (issue #68, parent virusdave/top-level#51).
  //
  // DISPLAY-ONLY: the result is never injected into an agent, never
  // auto-promoted, and (v1) never persisted. Sending observation text
  // (including the display-only `note`) to the PRIVATE clustering model is
  // read/analysis, not the injection the promote allowlist guards. The model
  // only GROUPS (returns integer keys + a short label); the "likely aggregate
  // agent waste" ranking is computed deterministically in Helios from each
  // observation's real estimated_wasted_* numbers, never from the model.
  server.post(
    '/api/agent-waste/clusters',
    { bodyLimit: CLUSTER_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const actor = await requireSessionUser(request, reply, 'admin')
      if (!actor) {
        return
      }

      // Empty, strict body: the server reads the live backlog itself, so no
      // client-supplied scope/rows can silently change what gets clustered.
      const parsedBody = AgentWasteClustersRequestSchema.safeParse(request.body ?? {})
      if (!parsedBody.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: parsedBody.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; '),
        })
      }

      let observations
      try {
        observations = await getBacklog()
      } catch (error) {
        return handleAgentWasteError(server, reply, error, 'Failed to fetch agent-waste backlog')
      }

      const model = await resolveBedrockModel(getPool(), 'agent_waste_clusterer')

      // Empty backlog: nothing to cluster; skip the LLM call entirely.
      if (observations.length === 0) {
        const body: AgentWasteClustersResponse = {
          source: getBacklogSourceStatus(),
          model,
          clusters: [],
          unclustered: [],
        }
        return reply.send(body)
      }

      const clusters: AgentWasteClustersResponse['clusters'] = []
      const unclustered: AgentWasteClustersResponse['unclustered'] = []
      try {
        // Keep each model prompt within the proven single-call budget while
        // covering the entire backlog. Calls are deliberately sequential to
        // avoid a large backlog creating an unbounded burst at the gateway.
        // If any batch fails, the whole request fails rather than returning a
        // partial result that looks complete.
        for (let offset = 0; offset < observations.length; offset += CLUSTER_BATCH_SIZE) {
          const batch = observations.slice(offset, offset + CLUSTER_BATCH_SIZE)
          const raw = await callClusterModel(batch, model, { env: getServerEnv() })
          const result = rehydrateClusters(batch, raw)
          clusters.push(...result.clusters)
          unclustered.push(...result.unclustered)
        }
      } catch (error) {
        if (error instanceof ClusterModelError) {
          // Note: the ClusterModelError message never contains the prompt
          // (which includes notes) — only transport/gateway/shape detail.
          server.log.error(
            { event: 'agent_waste.cluster_failed', code: error.code, model },
            'agent-waste clustering failed',
          )
          return reply.status(clusterModelStatus(error.code)).send({
            error: error.code,
            message: error.message,
          })
        }
        return handleAgentWasteError(server, reply, error, 'Failed to cluster agent-waste backlog')
      }

      // Each batch is ranked independently during rehydration; restore one
      // global aggregate-waste ordering after combining them.
      clusters.sort(compareClustersByWaste)
      const body: AgentWasteClustersResponse = {
        source: getBacklogSourceStatus(),
        model,
        clusters,
        unclustered,
      }
      return reply.send(body)
    },
  )
}
