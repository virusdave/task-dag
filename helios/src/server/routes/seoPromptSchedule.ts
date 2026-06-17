// SEO auto-blog PROMPT-SCHEDULE + TOPIC-MIX config routes (P4 — parent
// EPIC_PLAN §7.2).
//
// Lets an operator tune the cadence (posts/week), weighted topic mix,
// generation mode, and prompt templates the (later) Bedrock draft-generation
// loop will consult. This slice is config + CRUD only — NOTHING here runs a
// background generator, and nothing reaches a published bundle (a generated
// DRAFT still passes the IRONCLAD approval gate, canon §1, one step later).
//
//   GET  /api/seo/prompt-schedules                — list schedules (viewer)
//   GET  /api/seo/prompt-schedules/:scheduleKey   — get one (viewer)
//   PUT  /api/seo/prompt-schedules                — create/update (editor)
//   POST /api/seo/prompt-schedules/check          — dry-run validate (viewer)
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

import type { FastifyInstance } from 'fastify'

import {
  SeoPromptScheduleDetailResponseSchema,
  SeoPromptScheduleListResponseSchema,
  SeoPromptScheduleRouteParamsSchema,
  SeoPromptScheduleUpsertBodySchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  getPromptSchedule,
  listPromptSchedules,
  upsertPromptSchedule,
} from '../db/queries/seoPromptScheduleQueries.js'
import { validatePromptScheduleConfig } from '../seo/promptSchedule.js'

export async function registerSeoPromptScheduleRoutes(server: FastifyInstance): Promise<void> {
  // List all prompt schedules.
  server.get('/api/seo/prompt-schedules', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const schedules = await listPromptSchedules(getPool())
    return reply.send(SeoPromptScheduleListResponseSchema.parse({ schedules }))
  })

  // Get one prompt schedule.
  server.get('/api/seo/prompt-schedules/:scheduleKey', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const params = SeoPromptScheduleRouteParamsSchema.parse(request.params)
    const schedule = await getPromptSchedule(getPool(), params.scheduleKey)
    if (!schedule) {
      return reply.status(404).send({ error: 'Prompt schedule not found.' })
    }
    return reply.send(SeoPromptScheduleDetailResponseSchema.parse({ schedule }))
  })

  // Create or update a prompt schedule. Validates the config (topic-mix
  // weights sum to 100, FB-news cap, cadence range) before writing.
  server.put('/api/seo/prompt-schedules', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const body = SeoPromptScheduleUpsertBodySchema.parse(request.body ?? {})
    const problems = validatePromptScheduleConfig({
      postsPerWeek: body.postsPerWeek,
      mode: body.mode,
      topicMix: body.topicMix,
      promptTemplates: body.promptTemplates,
    })
    if (problems.length > 0) {
      return reply.status(422).send({
        error: 'Prompt schedule is not valid.',
        detail: problems.map((p) => `${p.field}: ${p.message}`).join('\n'),
      })
    }
    const schedule = await upsertPromptSchedule(getPool(), {
      scheduleKey: body.scheduleKey,
      scope: body.scope,
      label: body.label,
      enabled: body.enabled,
      postsPerWeek: body.postsPerWeek,
      mode: body.mode,
      topicMix: body.topicMix,
      promptTemplates: body.promptTemplates,
      notes: body.notes,
      userId: user.id,
    })
    return reply.send(SeoPromptScheduleDetailResponseSchema.parse({ schedule }))
  })

  // Dry-run validation for the editor (no mutation). Surfaces the same
  // problems the PUT path would raise.
  server.post('/api/seo/prompt-schedules/check', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const body = SeoPromptScheduleUpsertBodySchema.parse(request.body ?? {})
    const problems = validatePromptScheduleConfig({
      postsPerWeek: body.postsPerWeek,
      mode: body.mode,
      topicMix: body.topicMix,
      promptTemplates: body.promptTemplates,
    })
    return reply.send({
      ok: problems.length === 0,
      problems: problems.map((p) => `${p.field}: ${p.message}`),
    })
  })
}
