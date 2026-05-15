import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { FastifyInstance } from 'fastify'
import type { QueryResultRow } from 'pg'

import {
  PolicyReplacementDraftEmptyResponseSchema,
  PolicyReplacementDraftPostBodySchema,
  PolicyReplacementDraftResponseSchema,
  PolicyReplacementPacketDetailSchema,
  PolicyReplacementPacketRouteParamsSchema,
  PolicyReplacementPacketSchema,
  PolicyReplacementPacketSummarySchema,
  computePolicyReplacementItemIds,
  normalizePolicyReplacementItems,
  type PolicyReplacementItemId,
  type PolicyReplacementItemState,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getServerEnv } from '../config/env.js'
import { getPool, type Queryable } from '../db/pool.js'
import { withTransaction } from '../db/tx.js'

const PACKET_ID_PATTERN = /^[A-Za-z0-9._\-]+$/

interface DraftRow extends QueryResultRow {
  id: number
  packet_id: string
  state_version: number
  saved_at: Date
  submitted_at: Date | null
  items_json: Record<string, PolicyReplacementItemState>
}

/**
 * Resolve a `packetId` (e.g. `asset-policy-limited-replacement-plan-2026-05-05_110134`)
 * to a packet JSON file in the configured packet directory.
 *
 * Filenames in `ads/google/policy/` use underscores in the lane prefix while
 * the canonical packetId uses hyphens, so we try a few translations and
 * fall back to scanning for any matching `packetId` value.
 */
async function loadPacketByPacketId(packetId: string): Promise<ReturnType<typeof PolicyReplacementPacketSchema.parse> | null> {
  if (!PACKET_ID_PATTERN.test(packetId)) {
    return null
  }
  const env = getServerEnv()
  const dir = env.communicationsPolicyPacketDir
  const candidates: string[] = [
    `${packetId}.json`,
    `${packetId.replace(/-/g, '_')}.json`,
  ]
  // Translate hyphens-to-underscores only in the lane prefix (everything
  // before the first 4-digit date segment) to match files like
  // `asset_policy_limited_replacement_plan_2026-05-05_110134.json`.
  const dateMatch = packetId.match(/^(.+?)-(\d{4}-\d{2}-\d{2}.*)$/)
  if (dateMatch) {
    const [, prefix, suffix] = dateMatch
    candidates.push(`${prefix.replace(/-/g, '_')}-${suffix}.json`)
    candidates.push(`${prefix.replace(/-/g, '_')}_${suffix}.json`)
  }

  for (const candidateName of candidates) {
    const candidatePath = resolve(dir, candidateName)
    try {
      const raw = await readFile(candidatePath, 'utf8')
      const parsed = JSON.parse(raw)
      const packet = PolicyReplacementPacketSchema.parse(parsed)
      if (packet.packetId === packetId) {
        return packet
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  // Fallback: scan the directory for any json file whose declared packetId
  // matches. Bounded by the size of the policy/ directory; expected small.
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue
    }
    const candidatePath = resolve(dir, entry)
    let parsed: unknown
    try {
      const raw = await readFile(candidatePath, 'utf8')
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as { packetId?: unknown }).packetId !== packetId) {
      continue
    }
    const result = PolicyReplacementPacketSchema.safeParse(parsed)
    if (result.success) {
      return result.data
    }
  }

  return null
}

async function readDraft(db: Queryable, packetId: string): Promise<DraftRow | null> {
  const result = await db.query<DraftRow>(
    `
      select id, packet_id, state_version, saved_at, submitted_at, items_json
      from communications_policy_replacement_drafts
      where packet_id = $1
      limit 1
    `,
    [packetId],
  )
  return result.rows[0] ?? null
}

function toIsoString(value: Date | null | undefined): string | null {
  if (!value) {
    return null
  }
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function buildResponseBody(row: DraftRow, items: Record<PolicyReplacementItemId, PolicyReplacementItemState>) {
  return PolicyReplacementDraftResponseSchema.parse({
    version: 1,
    packetId: row.packet_id,
    savedAt: toIsoString(row.saved_at),
    submittedAt: toIsoString(row.submitted_at),
    items,
  })
}

export async function registerCommunicationsRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/communications/policy-replacements/:packetId/summary', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const params = PolicyReplacementPacketRouteParamsSchema.parse(request.params)
    const packet = await loadPacketByPacketId(params.packetId)
    if (!packet) {
      return reply.status(404).send({ error: 'Policy replacement packet not found.', packetId: params.packetId })
    }
    const ids = computePolicyReplacementItemIds(packet)
    return reply.send(
      PolicyReplacementPacketSummarySchema.parse({
        packetId: packet.packetId,
        generatedAt: packet.generatedAt ?? null,
        itemIdCount: ids.size,
        categories: {
          visualReplacementPlans: (packet.visualReplacementPlans ?? []).length,
          headlines: (packet.llmCopy?.headlines ?? []).length,
          longHeadlines: (packet.llmCopy?.longHeadlines ?? []).length,
          descriptions: (packet.llmCopy?.descriptions ?? []).length,
          templateFamilies: (packet.llmCopy?.templateFamilies ?? []).length,
          textReplacementMappings: (packet.textReplacementMappings ?? []).length,
        },
      }),
    )
  })

  server.get('/api/communications/policy-replacements/:packetId/detail', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const params = PolicyReplacementPacketRouteParamsSchema.parse(request.params)
    const packet = await loadPacketByPacketId(params.packetId)
    if (!packet) {
      return reply.status(404).send({ error: 'Policy replacement packet not found.', packetId: params.packetId })
    }
    // Re-emit the parts of the loose packet shape that the reviewer page
    // renders. The packet itself stays unmutated; we just project a typed
    // detail payload off it.
    const llmCopy = (packet.llmCopy ?? {}) as Record<string, unknown>
    const safePatterns = Array.isArray((llmCopy as { safePatterns?: unknown }).safePatterns)
      ? ((llmCopy as { safePatterns?: unknown }).safePatterns as unknown[]).filter(
          (value): value is string => typeof value === 'string',
        )
      : []
    const riskPatterns = Array.isArray((llmCopy as { riskPatterns?: unknown }).riskPatterns)
      ? ((llmCopy as { riskPatterns?: unknown }).riskPatterns as unknown[]).filter(
          (value): value is string => typeof value === 'string',
        )
      : []
    const applyPlanRaw = (packet as { applyPlan?: unknown }).applyPlan
    const applyPlan = Array.isArray(applyPlanRaw)
      ? applyPlanRaw.filter((value): value is string => typeof value === 'string')
      : []
    const summary = (packet as { summary?: unknown }).summary
    const anchorExamples = ((packet as { anchorExamples?: unknown }).anchorExamples ?? {}) as {
      eligible?: unknown[]
      limited?: unknown[]
    }
    const detail = PolicyReplacementPacketDetailSchema.parse({
      packetId: packet.packetId,
      generatedAt: packet.generatedAt ?? null,
      summary: (summary && typeof summary === 'object' && !Array.isArray(summary)) ? summary : null,
      applyPlan,
      llmSafePatterns: safePatterns,
      llmRiskPatterns: riskPatterns,
      visualReplacementPlans: (packet.visualReplacementPlans ?? []) as unknown[],
      headlines: ((llmCopy as { headlines?: unknown[] }).headlines ?? []) as unknown[],
      longHeadlines: ((llmCopy as { longHeadlines?: unknown[] }).longHeadlines ?? []) as unknown[],
      descriptions: ((llmCopy as { descriptions?: unknown[] }).descriptions ?? []) as unknown[],
      templateFamilies: ((llmCopy as { templateFamilies?: unknown[] }).templateFamilies ?? []) as unknown[],
      textReplacementMappings: (packet.textReplacementMappings ?? []) as unknown[],
      replacementCategoryLabels: packet.replacementCategoryLabels ?? {},
      anchorExamples: {
        eligible: Array.isArray(anchorExamples.eligible) ? anchorExamples.eligible : [],
        limited: Array.isArray(anchorExamples.limited) ? anchorExamples.limited : [],
      },
    })
    return reply.send(detail)
  })

  server.get('/api/communications/policy-replacements/:packetId/draft', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const params = PolicyReplacementPacketRouteParamsSchema.parse(request.params)
    const packet = await loadPacketByPacketId(params.packetId)
    if (!packet) {
      return reply.status(404).send({ error: 'Policy replacement packet not found.', packetId: params.packetId })
    }
    const ids = computePolicyReplacementItemIds(packet)
    const db = getPool()
    const row = await readDraft(db, params.packetId)
    if (!row) {
      return reply.status(404).send(
        PolicyReplacementDraftEmptyResponseSchema.parse({
          packetId: params.packetId,
          error: 'No saved review state exists yet.',
        }),
      )
    }
    const normalized = normalizePolicyReplacementItems(row.items_json, ids)
    return reply.send(buildResponseBody(row, normalized))
  })

  server.post('/api/communications/policy-replacements/:packetId/draft', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const params = PolicyReplacementPacketRouteParamsSchema.parse(request.params)
    const body = PolicyReplacementDraftPostBodySchema.parse(request.body ?? {})
    if (body.packetId !== params.packetId) {
      return reply.status(409).send({
        error: 'Packet id mismatch. Reload the packet and try again.',
        packetId: params.packetId,
      })
    }
    const packet = await loadPacketByPacketId(params.packetId)
    if (!packet) {
      return reply.status(404).send({ error: 'Policy replacement packet not found.', packetId: params.packetId })
    }
    const ids = computePolicyReplacementItemIds(packet)
    const normalizedItems = normalizePolicyReplacementItems(body.items, ids)
    const requestId = randomUUID()
    const markSubmitted = Boolean(body.submit)

    const result = await withTransaction(async (db) => {
      const upsert = await db.query<DraftRow>(
        `
          insert into communications_policy_replacement_drafts (
            packet_id, state_version, saved_at, submitted_at, items_json, last_saved_by_user_id
          )
          values ($1, 1, now(), case when $2::boolean then now() else null end, $3::jsonb, $4)
          on conflict (packet_id) do update set
            state_version = communications_policy_replacement_drafts.state_version + 1,
            saved_at = now(),
            submitted_at = case
              when $2::boolean then now()
              else communications_policy_replacement_drafts.submitted_at
            end,
            items_json = excluded.items_json,
            last_saved_by_user_id = excluded.last_saved_by_user_id
          returning id, packet_id, state_version, saved_at, submitted_at, items_json
        `,
        [params.packetId, markSubmitted, JSON.stringify(normalizedItems), user.id],
      )
      const row = upsert.rows[0]
      const itemSummary = {
        totalItems: Object.keys(normalizedItems).length,
        accepted: Object.values(normalizedItems).filter((value) => value.decision === 'accepted').length,
        rejected: Object.values(normalizedItems).filter((value) => value.decision === 'rejected').length,
        hold: Object.values(normalizedItems).filter((value) => value.decision === 'hold').length,
      }
      const eventType = markSubmitted
        ? 'communications.policy_replacement_review.submitted'
        : 'communications.policy_replacement_review.draft_saved'
      const payload = {
        packetId: row.packet_id,
        stateVersion: row.state_version,
        summary: itemSummary,
        submitted: markSubmitted,
      }
      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: row.packet_id,
        entityType: 'communications_policy_replacement_packet',
        eventType,
        module: 'communications',
        payload,
        requestId,
        undoPayload: null,
      })
      await db.query(
        `
          insert into communications_policy_replacement_audit (
            packet_id, draft_id, event_type, actor_user_id, request_id, payload_json, audit_event_id
          )
          values ($1, $2, $3, $4, $5, $6::jsonb, $7)
        `,
        [row.packet_id, row.id, eventType, user.id, requestId, JSON.stringify(payload), auditEventId],
      )
      return { row, itemSummary, eventType, auditEventId }
    })

    return reply.send(buildResponseBody(result.row, normalizedItems))
  })
}
