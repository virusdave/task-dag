import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  BedrockModelConfigGetResponseSchema,
  BedrockModelConfigPutBodySchema,
  BEDROCK_MODEL_OVERRIDES_VERSION,
} from '../../shared/contracts/index.js'
import { BEDROCK_MODEL_SUGGESTIONS } from '../../shared/domain/bedrockModels.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { deleteAppSetting, upsertAppSetting } from '../db/queries/appSettingsQueries.js'
import {
  BEDROCK_MODEL_OVERRIDES_KEY,
  buildBedrockModelContextStates,
  loadBedrockModelOverrides,
} from '../llm/bedrockModelConfig.js'

// Admin-only config surface for the below-the-fold Bedrock model overrides
// (child FreshlyBakedNYC/automation#54, task C4, parent virusdave/top-level#33).
//
// GET  /api/config/bedrock-models     — resolved per-context view + suggestions
// PUT  /api/config/bedrock-models     — replace the whole sparse overrides map
// DELETE /api/config/bedrock-models   — clear all overrides (back to defaults)
//
// Unlike metrics defaults this is operator tooling, so even the read is
// admin-gated. Satisfies: virusdave/top-level#33.

const MIGRATION_MISSING_RE = /relation .*app_settings.* does not exist/i

function isMigrationMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return MIGRATION_MISSING_RE.test(message)
}

function sendMigrationMissing(reply: FastifyReply): void {
  reply
    .status(503)
    .send({ error: 'app_settings table is missing. Apply migration 069_app_settings.sql.' })
}

export async function registerBedrockModelConfigRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/config/bedrock-models', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    try {
      const record = await loadBedrockModelOverrides(getPool())
      return reply.send(
        BedrockModelConfigGetResponseSchema.parse({
          contexts: buildBedrockModelContextStates(record.overrides),
          suggestions: BEDROCK_MODEL_SUGGESTIONS,
          updatedBy: record.updatedBy,
          updatedAt: record.updatedAt,
        }),
      )
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })

  server.put('/api/config/bedrock-models', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    const body = BedrockModelConfigPutBodySchema.parse(request.body)
    // Persist the versioned blob. The PUT body is already a validated sparse
    // map; an empty map clears all overrides (stored as an empty blob).
    const value = { version: BEDROCK_MODEL_OVERRIDES_VERSION, overrides: body.overrides }
    try {
      const stored = await upsertAppSetting(
        getPool(),
        BEDROCK_MODEL_OVERRIDES_KEY,
        value,
        user.email,
      )
      return reply.send(
        BedrockModelConfigGetResponseSchema.parse({
          contexts: buildBedrockModelContextStates(body.overrides),
          suggestions: BEDROCK_MODEL_SUGGESTIONS,
          updatedBy: stored.updatedBy,
          updatedAt: stored.updatedAt,
        }),
      )
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })

  server.delete('/api/config/bedrock-models', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    try {
      await deleteAppSetting(getPool(), BEDROCK_MODEL_OVERRIDES_KEY)
      return reply.send(
        BedrockModelConfigGetResponseSchema.parse({
          contexts: buildBedrockModelContextStates({}),
          suggestions: BEDROCK_MODEL_SUGGESTIONS,
          updatedBy: null,
          updatedAt: null,
        }),
      )
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })
}
