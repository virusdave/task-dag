import type { FastifyInstance } from 'fastify'

import {
  GeoSegmentRuleCreateBodySchema,
  GeoSegmentRuleDeleteResponseSchema,
  GeoSegmentRuleMutationResponseSchema,
  GeoSegmentRuleRouteParamsSchema,
  GeoSegmentRuleUpdateBodySchema,
  GeoSegmentRulesListResponseSchema,
  type GeoSegmentSiteOption,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  createGeoSegmentRule,
  deleteGeoSegmentRule,
  getGeoSegmentRuleById,
  listGeoSegmentRules,
  updateGeoSegmentRule,
} from '../db/queries/geoSegmentRulesAdminQueries.js'
import { SITE_PINS } from '../db/queries/customersMapQueries.js'

// Control-plane CRUD for the geographic (scan-location-based) segment
// assignment engine (`geo_segment_rules`, migration 079). Reads require
// role >= viewer; writes require role >= editor. The live evaluator
// (config.workers.geo_segment_rule_eval) reads the same table, so a
// newly enabled rule takes effect on the next qualifying scan with no
// deploy.

const SITE_OPTIONS: GeoSegmentSiteOption[] = SITE_PINS.map((p) => ({
  siteSlug: p.siteSlug,
  label: p.label,
  lat: p.lat,
  lng: p.lng,
}))

// Postgres SQLSTATEs we translate into friendly 400s instead of 500s.
const PG_UNIQUE_VIOLATION = '23505'
const PG_CHECK_VIOLATION = '23514'

function pgCode(cause: unknown): string | null {
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code
    return typeof code === 'string' ? code : null
  }
  return null
}

export async function registerGeoSegmentRulesRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/geo-segment-rules', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'viewer')
    if (!actor) {
      return
    }
    const rules = await listGeoSegmentRules(getPool())
    return reply.send(
      GeoSegmentRulesListResponseSchema.parse({ rules, siteOptions: SITE_OPTIONS }),
    )
  })

  server.post('/api/geo-segment-rules', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'editor')
    if (!actor) {
      return
    }
    const body = GeoSegmentRuleCreateBodySchema.parse(request.body ?? {})
    try {
      const id = await createGeoSegmentRule(getPool(), body)
      const rule = await getGeoSegmentRuleById(getPool(), id)
      if (!rule) {
        throw new Error('Failed to load rule after create.')
      }
      return reply.send(GeoSegmentRuleMutationResponseSchema.parse({ rule }))
    } catch (cause) {
      const code = pgCode(cause)
      if (code === PG_UNIQUE_VIOLATION) {
        return reply.status(400).send({ error: 'Rule values collided with a uniqueness constraint.' })
      }
      if (code === PG_CHECK_VIOLATION) {
        return reply.status(400).send({
          error: 'Rule values failed a database constraint (an enabled rule needs at least one condition).',
        })
      }
      throw cause
    }
  })

  server.patch('/api/geo-segment-rules/:ruleId', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'editor')
    if (!actor) {
      return
    }
    const params = GeoSegmentRuleRouteParamsSchema.parse(request.params)
    const body = GeoSegmentRuleUpdateBodySchema.parse(request.body ?? {})

    // Identity / target fields are immutable after creation. The
    // per-(rule, customer) application ledger is keyed by rule_id, so
    // retargeting a rule (new segment/dealer) or changing what it
    // matches (site/trigger) would silently skip already-ledgered
    // customers for the new target. To retarget, create a new rule.
    const current = await getGeoSegmentRuleById(getPool(), params.ruleId)
    if (!current) {
      return reply.status(404).send({ error: 'Rule not found.' })
    }
    const immutableChange =
      (body.siteSlug !== undefined && body.siteSlug !== current.siteSlug) ||
      (body.dealerId !== undefined && body.dealerId !== current.dealerId) ||
      (body.segmentId !== undefined && body.segmentId !== current.segmentId) ||
      (body.trigger !== undefined && body.trigger !== current.trigger)
    if (immutableChange) {
      return reply.status(400).send({
        error:
          'Site, dealer, segment, and trigger are fixed once a rule exists. Create a new rule to retarget.',
      })
    }

    try {
      const updated = await updateGeoSegmentRule(getPool(), params.ruleId, body)
      if (!updated) {
        return reply.status(404).send({ error: 'Rule not found.' })
      }
      const rule = await getGeoSegmentRuleById(getPool(), params.ruleId)
      if (!rule) {
        return reply.status(404).send({ error: 'Rule not found.' })
      }
      return reply.send(GeoSegmentRuleMutationResponseSchema.parse({ rule }))
    } catch (cause) {
      const code = pgCode(cause)
      if (code === PG_UNIQUE_VIOLATION) {
        return reply.status(400).send({ error: 'Rule values collided with a uniqueness constraint.' })
      }
      if (code === PG_CHECK_VIOLATION) {
        return reply.status(400).send({
          error: 'Rule values failed a database constraint (an enabled rule needs at least one condition).',
        })
      }
      throw cause
    }
  })

  server.delete('/api/geo-segment-rules/:ruleId', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'editor')
    if (!actor) {
      return
    }
    const params = GeoSegmentRuleRouteParamsSchema.parse(request.params)

    // Delete is only for a mistakenly-created rule that never fired.
    // A rule with application history must be DISABLED, not deleted:
    // cascading away the ledger would let a future re-create re-add the
    // same customers, and deleting under a live evaluator can race an
    // in-flight Sweed write. Enabled rules must be disabled first.
    const current = await getGeoSegmentRuleById(getPool(), params.ruleId)
    if (!current) {
      return reply.status(404).send({ error: 'Rule not found.' })
    }
    if (current.enabled) {
      return reply.status(400).send({ error: 'Disable the rule before deleting it.' })
    }
    const totalApplications =
      current.stats.applied +
      current.stats.alreadyMember +
      current.stats.failed +
      current.stats.pending
    if (totalApplications > 0) {
      return reply.status(400).send({
        error:
          'This rule has application history and cannot be deleted. Leave it disabled to preserve idempotency.',
      })
    }

    const deleted = await deleteGeoSegmentRule(getPool(), params.ruleId)
    if (!deleted) {
      return reply.status(404).send({ error: 'Rule not found.' })
    }
    return reply.send(GeoSegmentRuleDeleteResponseSchema.parse({ deletedId: params.ruleId }))
  })
}
