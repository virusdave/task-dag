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
  buildTicketDraftUserPrompt,
  callTicketDraftModel,
  TicketDraftModelError,
} from '../agentWaste/ticketDraftModel.js'
import { listTicketRepositories } from '../agentWaste/ticketRepositoryCatalog.js'
import { verifyTicketDraftSource } from '../agentWaste/ticketDraftSource.js'
import {
  buildDeterministicBaseline,
  buildRefinementUnits,
  compareClustersByWaste,
  compareCodeUnits,
  occurrenceIdentity,
  rehydrateClusters,
  type RefinementUnit,
} from '../agentWaste/clusterBacklog.js'
import { getServerEnv } from '../config/env.js'
import { getPool } from '../db/pool.js'
import { resolveBedrockModel } from '../llm/bedrockModelConfig.js'
import {
  AGENT_WASTE_TICKET_MAX_REQUEST_BYTES,
  AgentWasteClustersRequestSchema,
  AgentWasteTicketDraftRequestSchema,
  AgentWasteTicketDraftResponseSchema,
  AgentWasteTicketRepositoriesResponseSchema,
  PromoteAdvisoryRequestSchema,
  type AgentWasteBacklogResponse,
  type AgentWasteClustersResponse,
  type AgentWasteCluster,
  type AgentWasteObservation,
  type PromoteAdvisoryErrorResponse,
  type PromoteAdvisoryFailureCode,
  type PromoteAdvisoryResponse,
} from '../../shared/contracts/api/agentWaste.js'

/** Body cap for the promote route — a single advisory entry is tiny. */
const PROMOTE_BODY_LIMIT_BYTES = 64 * 1024

/** Body cap for the cluster route — the request body is an empty object. */
const CLUSTER_BODY_LIMIT_BYTES = 4 * 1024

/** Fastify rejects oversized ticket-source requests before parsing JSON. */
const TICKET_DRAFT_BODY_LIMIT_BYTES = AGENT_WASTE_TICKET_MAX_REQUEST_BYTES

type ClusterWarning = AgentWasteClustersResponse['warnings'][number]

function modelWarningCode(error: ClusterModelError): ClusterWarning['code'] {
  switch (error.code) {
    case 'bedrock_unconfigured': return 'model_unconfigured'
    case 'bedrock_http_error': return 'model_http_error'
    case 'bedrock_transport_error': return 'model_transport_error'
    case 'bedrock_unexpected_response': return 'model_invalid_response'
  }
}

function baselineUnitResult(unit: RefinementUnit, observations: readonly AgentWasteObservation[]): {
  clusters: AgentWasteCluster[]; clusterKeys: number[][]
  unclustered: AgentWasteObservation[]; unclusteredKeys: number[]
} {
  const clustered = unit.components.filter((component) => component.keys.length > 1)
  const unclustered = unit.components.filter((component) => component.keys.length === 1)
  return {
    clusters: clustered.map((component) => component.cluster),
    clusterKeys: clustered.map((component) => component.keys),
    unclustered: unclustered.map((component) => observations[component.keys[0]]),
    unclusteredKeys: unclustered.map((component) => component.keys[0]),
  }
}

function hasExactCoverage(raw: { clusters: Array<{ primaryKey: number; memberKeys: number[] }> }, count: number): boolean {
  const keys: number[] = []
  for (const cluster of raw.clusters) {
    if (!cluster.memberKeys.includes(cluster.primaryKey)) return false
    keys.push(...cluster.memberKeys)
  }
  keys.sort((a, b) => a - b)
  return keys.length === count && keys.every((key, index) => key === index)
}

export function compactWarnings(warnings: ClusterWarning[]): ClusterWarning[] {
  warnings.sort((a, b) => (a.unit ?? Number.MAX_SAFE_INTEGER) - (b.unit ?? Number.MAX_SAFE_INTEGER) || compareCodeUnits(a.code, b.code))
  const collapsed: ClusterWarning[] = []
  for (const warning of warnings) {
    const previous = collapsed.at(-1)
    if (previous && previous.unit === warning.unit && previous.code === warning.code) previous.count += warning.count
    else collapsed.push({ ...warning })
  }
  if (collapsed.length <= 50) return collapsed
  return [...collapsed.slice(0, 49), { unit: null, code: 'warnings_truncated', count: collapsed.length - 49 }]
}

function hasExactObservationCoverage(count: number, clusterKeys: readonly number[][], unclusteredKeys: readonly number[]): boolean {
  const output = [...clusterKeys.flat(), ...unclusteredKeys].sort((a, b) => a - b)
  return output.length === count && output.every((position, index) => position === index)
}

function lowestOccurrenceIdentity(observations: readonly AgentWasteObservation[], keys: readonly number[]): string {
  return keys.map((key) => occurrenceIdentity(observations[key], key)).sort(compareCodeUnits)[0] ?? ''
}

function ticketDraftPublicMessage(code: TicketDraftModelError['code']): string {
  switch (code) {
    case 'agent_waste_ticket_input_too_large':
      return 'The selected reports are too large for one ticket-drafting request.'
    case 'bedrock_unconfigured':
      return 'The private ticket-drafting model is not configured.'
    case 'bedrock_http_error':
    case 'bedrock_transport_error':
    case 'bedrock_unexpected_response':
      return 'The private model could not produce a valid ticket draft.'
  }
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

  // GET /api/agent-waste/repositories - bounded ticket targets. This is a
  // curated, read-only allowlist; it neither reads nor writes GitHub.
  server.get('/api/agent-waste/repositories', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'admin')
    if (!actor) return
    return reply.send(
      AgentWasteTicketRepositoriesResponseSchema.parse({ repositories: listTicketRepositories() }),
    )
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

  // POST /api/agent-waste/ticket-draft - verify an operator-selected report
  // multiset, then ask the private model for an editable proposal. This route
  // is analysis-only: it never creates an issue or performs a GitHub write.
  server.post(
    '/api/agent-waste/ticket-draft',
    { bodyLimit: TICKET_DRAFT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const actor = await requireSessionUser(request, reply, 'admin')
      if (!actor) return

      const parsed = AgentWasteTicketDraftRequestSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; '),
        })
      }

      let backlog
      try {
        backlog = await getBacklog()
      } catch (error) {
        return handleAgentWasteError(server, reply, error, 'Failed to fetch agent-waste backlog')
      }
      const verified = verifyTicketDraftSource(parsed.data, backlog)
      if (!verified.ok) {
        return reply.status(409).send({
          error: 'agent_waste_ticket_source_mismatch',
          message: 'One or more selected reports are no longer present in the current backlog.',
        })
      }

      let model: string | null = null
      try {
        // Size the verified prompt before even the DB-backed model lookup.
        // Oversized input deterministically fails without touching either
        // model configuration or the gateway.
        const prompt = buildTicketDraftUserPrompt(verified.source)
        model = await resolveBedrockModel(getPool(), 'agent_waste_ticket_drafter')
        const proposed = await callTicketDraftModel(prompt, model, { env: getServerEnv() })
        const response = AgentWasteTicketDraftResponseSchema.parse({
          model,
          filingKey: verified.source.filingKey,
          draft: {
            title: proposed.title,
            summary: proposed.summary,
            repository: proposed.repository,
          },
          rationale: proposed.rationale,
          evidenceMarkdown: verified.source.evidenceMarkdown,
        })
        return reply.send(response)
      } catch (error) {
        if (error instanceof TicketDraftModelError) {
          server.log.error(
            { event: 'agent_waste.ticket_draft_failed', code: error.code, model },
            'agent-waste ticket drafting failed',
          )
          const status = error.code === 'agent_waste_ticket_input_too_large'
            ? 413
            : error.code === 'bedrock_unconfigured'
              ? 503
              : 502
          return reply.status(status).send({
            error: error.code,
            message: ticketDraftPublicMessage(error.code),
          })
        }
        return handleAgentWasteError(server, reply, error, 'Failed to draft agent-waste ticket')
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

      let observations: AgentWasteObservation[]
      try {
        observations = await getBacklog()
      } catch (error) {
        return handleAgentWasteError(server, reply, error, 'Failed to fetch agent-waste backlog')
      }

      const baseline = buildDeterministicBaseline(observations)
      const units = buildRefinementUnits(baseline.components)
      const results = units.map((unit) => baselineUnitResult(unit, observations))
      const warnings: ClusterWarning[] = []
      let model: string | null = null
      let succeeded = 0
      let failed = 0
      let skipped = 0
      for (const unit of units) if (unit.oversized) {
        skipped += 1
        warnings.push({ unit: unit.index, code: 'partition_too_large', count: 1 })
      }
      const eligible = units.filter((unit) => !unit.oversized)
      try {
        model = await resolveBedrockModel(getPool(), 'agent_waste_clusterer')
      } catch (error) {
        failed = eligible.length
        for (const unit of eligible) warnings.push({ unit: unit.index, code: 'model_lookup_failed', count: 1 })
        server.log.error(error, 'agent-waste clustering model lookup failed')
      }
      if (model !== null) {
        const resolvedModel = model
        let next = 0
        async function worker(): Promise<void> {
          while (next < eligible.length) {
            const unit = eligible[next]
            next += 1
            const batch = unit.keys.map((key) => observations[key])
            try {
              const raw = await callClusterModel(batch, resolvedModel, { env: getServerEnv() })
              if (!hasExactCoverage(raw, batch.length)) {
                failed += 1
                warnings.push({ unit: unit.index, code: 'coverage_invalid', count: 1 })
                continue
              }
              const refined = rehydrateClusters(batch, raw)
              results[unit.index] = {
                clusters: refined.clusters,
                clusterKeys: refined.clusterKeys.map((keys) => keys.map((key) => unit.keys[key])),
                unclustered: refined.unclustered,
                unclusteredKeys: refined.unclusteredKeys.map((key) => unit.keys[key]),
              }
              succeeded += 1
            } catch (error) {
              failed += 1
              const code = error instanceof ClusterModelError ? modelWarningCode(error) : 'model_invalid_response'
              warnings.push({ unit: unit.index, code, count: 1 })
              server.log.error({ error, unit: unit.index, model }, 'agent-waste refinement unit failed')
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(2, eligible.length) }, () => worker()))
      }
      const decoratedClusters = results.flatMap((result) => result.clusters.map((cluster, index) => ({
        cluster,
        keys: result.clusterKeys[index],
      })))
      decoratedClusters.sort((a, b) => compareClustersByWaste(a.cluster, b.cluster)
        || compareCodeUnits(
          lowestOccurrenceIdentity(observations, a.keys),
          lowestOccurrenceIdentity(observations, b.keys),
        ))
      const clusters = decoratedClusters.map((entry) => entry.cluster)
      const clusterKeys = decoratedClusters.map((entry) => entry.keys)
      const unclustered = results.flatMap((result) => result.unclustered)
      const unclusteredKeys = results.flatMap((result) => result.unclusteredKeys)
      const outputCount = clusters.reduce((count, cluster) => count + cluster.members.length, 0) + unclustered.length
      const coverageComplete = hasExactObservationCoverage(observations.length, clusterKeys, unclusteredKeys)
      const body: AgentWasteClustersResponse = {
        source: getBacklogSourceStatus(),
        model,
        clusters,
        unclustered,
        inputCount: observations.length,
        outputCount,
        coverageComplete,
        refinementComplete: succeeded === units.length,
        refinementTotal: units.length,
        refinementSucceeded: succeeded,
        refinementFailed: failed,
        refinementSkipped: skipped,
        warnings: compactWarnings(warnings),
      }
      return reply.send(body)
    },
  )
}
