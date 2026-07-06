import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  ConventionProposalDetailsSchema,
  CreateParseFeedbackBodySchema,
  CreateParseFeedbackResponseSchema,
  ListingCorrectionDetailsSchema,
  ParseFeedbackListQuerySchema,
  ParseFeedbackListResponseSchema,
  ParseFeedbackRecordResponseSchema,
  ParseFeedbackRouteParamsSchema,
  PROMOTION_EXPORT_MAX_CORRECTIONS,
  PromotionExportQuerySchema,
  PromotionExportResponseSchema,
  UpdateParseFeedbackBodySchema,
  UpdateParseFeedbackStatusBodySchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { withTransaction } from '../db/tx.js'
import {
  getParseFeedbackById,
  insertConventionProposal,
  insertListingCorrection,
  listParseFeedback,
  loadFuzzySkuProvenance,
  loadPromotionExportFeedback,
  updateParseFeedbackDraft,
  updateParseFeedbackStatus,
} from '../db/queries/catalogParseFeedbackQueries.js'
import { buildPromotionExportGroups } from '../parsekit/parseFeedbackPromotion.js'

const TABLE_MISSING_RE = /relation .*litalerts_parse_feedback.* does not exist/i
// migration 098 promotion-provenance columns (`promoted_parser_id`, …).
const PROMOTION_COLUMN_MISSING_RE = /column .*promoted_(parser_id|rule_id|config_sha).* does not exist/i

function isMigrationMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return TABLE_MISSING_RE.test(message) || PROMOTION_COLUMN_MISSING_RE.test(message)
}

function sendMigrationMissing(reply: FastifyReply): void {
  reply.status(503).send({
    error:
      'litalerts_parse_feedback schema is out of date. Apply migrations ' +
      '097_litalerts_parse_feedback.sql and 098_litalerts_parse_feedback_promotion.sql.',
  })
}

/**
 * LitAlerts parse-correction feedback inbox (issue #59, task T3).
 *
 * INERT feedback store for the brand-categorical-family market-match audit
 * panel: the operator corrects a mis-parsed listing's structured fields and
 * optionally records the retailer's naming convention. NOTHING here feeds
 * production scoring/matching, `fuzzy_skus`, market aggregates, or IQR —
 * promotion into parsekit is a later agent/reviewer task (T5), never a web-side
 * git write. Reads are viewer-gated; writes require `editor`.
 */
export async function registerCatalogParseFeedbackRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/catalog/family-explorer/parse-feedback?fuzzySkuIds=..&retailerIds=..
  server.get('/api/catalog/family-explorer/parse-feedback', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const parsed = ParseFeedbackListQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    try {
      const feedback = await listParseFeedback(getPool(), {
        fuzzySkuIds: parsed.data.fuzzySkuIds,
        retailerIds: parsed.data.retailerIds,
      })
      return reply.send(ParseFeedbackListResponseSchema.parse({ feedback }))
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })

  // POST /api/catalog/family-explorer/parse-feedback
  //
  // One drawer "save": a listing correction + an OPTIONAL convention proposal,
  // persisted in one transaction. Provenance is derived server-side from the
  // referenced fuzzy_sku — never trusted from the browser.
  server.post('/api/catalog/family-explorer/parse-feedback', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const parsed = CreateParseFeedbackBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', details: parsed.error.flatten() })
    }
    const body = parsed.data
    try {
      const provenance = await loadFuzzySkuProvenance(getPool(), body.listingCorrection.fuzzySkuId)
      if (!provenance) {
        return reply
          .code(404)
          .send({ error: 'Unknown fuzzySkuId — refresh the panel and try again.' })
      }
      const result = await withTransaction(async (client) => {
        const correction = await insertListingCorrection(client, {
          provenance,
          familyKey: body.listingCorrection.familyKey,
          brandKey: body.listingCorrection.brandKey,
          matchedCatalogProductId: body.listingCorrection.matchedCatalogProductId,
          details: body.listingCorrection.details,
          actor: user.email,
        })
        let convention = null
        if (body.conventionProposal) {
          convention = await insertConventionProposal(client, {
            provenance,
            familyKey: body.listingCorrection.familyKey,
            brandKey: body.listingCorrection.brandKey,
            matchedCatalogProductId: body.listingCorrection.matchedCatalogProductId,
            sourceFeedbackId: correction.id,
            details: body.conventionProposal.details,
            actor: user.email,
          })
        }
        return { listingCorrection: correction, conventionProposal: convention }
      })
      return reply.status(201).send(CreateParseFeedbackResponseSchema.parse(result))
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })

  // PATCH /api/catalog/family-explorer/parse-feedback/:feedbackId
  //
  // Re-edit a still-`draft` row in place. `details` must match the row's kind.
  server.patch('/api/catalog/family-explorer/parse-feedback/:feedbackId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const params = ParseFeedbackRouteParamsSchema.safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'Invalid feedback id' })
    }
    const body = UpdateParseFeedbackBodySchema.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({ error: 'Invalid body', details: body.error.flatten() })
    }
    try {
      const existing = await getParseFeedbackById(getPool(), params.data.feedbackId)
      if (!existing) {
        return reply.code(404).send({ error: 'Feedback not found.' })
      }
      // The stored kind is authoritative — the details payload must validate
      // against it (the union body schema alone can't tell them apart when a
      // convention payload happens to satisfy the correction shape or v.v.).
      const detailsParsed =
        existing.kind === 'listing_correction'
          ? ListingCorrectionDetailsSchema.safeParse(body.data.details)
          : ConventionProposalDetailsSchema.safeParse(body.data.details)
      if (!detailsParsed.success) {
        return reply.code(400).send({
          error: `details must match the row's kind (${existing.kind}).`,
          details: detailsParsed.error.flatten(),
        })
      }
      const updated = await updateParseFeedbackDraft(getPool(), params.data.feedbackId, {
        details: detailsParsed.data,
        matchedCatalogProductId:
          existing.kind === 'listing_correction' ? body.data.matchedCatalogProductId : undefined,
        actor: user.email,
      })
      if (updated === null) {
        return reply.code(404).send({ error: 'Feedback not found.' })
      }
      if (updated === 'not-draft') {
        return reply
          .code(409)
          .send({ error: 'Only draft feedback can be edited; this row is no longer a draft.' })
      }
      return reply.send(ParseFeedbackRecordResponseSchema.parse({ feedback: updated }))
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })

  // PATCH /api/catalog/family-explorer/parse-feedback/:feedbackId/status
  //
  // Marking a row `promoted` asserts an EXTERNAL parser-config commit was
  // reviewed/pushed/loaded and corresponds to this feedback — that is
  // operational provenance, so it requires `admin`. Every other lifecycle
  // transition stays `editor`. This never writes a git config (T5 boundary).
  server.patch(
    '/api/catalog/family-explorer/parse-feedback/:feedbackId/status',
    async (request, reply) => {
      const params = ParseFeedbackRouteParamsSchema.safeParse(request.params)
      if (!params.success) {
        return reply.code(400).send({ error: 'Invalid feedback id' })
      }
      const body = UpdateParseFeedbackStatusBodySchema.safeParse(request.body)
      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid body', details: body.error.flatten() })
      }
      const minRole = body.data.status === 'promoted' ? 'admin' : 'editor'
      const user = await requireSessionUser(request, reply, minRole)
      if (!user) return
      try {
        const updated = await updateParseFeedbackStatus(getPool(), params.data.feedbackId, {
          status: body.data.status,
          actor: user.email,
          promotion:
            body.data.status === 'promoted'
              ? {
                  parserId: body.data.promotedParserId,
                  ruleId: body.data.promotedRuleId ?? null,
                  configSha: body.data.promotedConfigSha,
                }
              : undefined,
        })
        if (!updated) {
          return reply.code(404).send({ error: 'Feedback not found.' })
        }
        return reply.send(ParseFeedbackRecordResponseSchema.parse({ feedback: updated }))
      } catch (error) {
        if (isMigrationMissing(error)) return sendMigrationMissing(reply)
        throw error
      }
    },
  )

  // GET /api/catalog/family-explorer/parse-feedback/promotion-export?retailerId=..&statuses=..
  //
  // READ-ONLY, admin-gated report for the agent/reviewer promotion path (T5):
  // the retailer's listing corrections grouped by parsekit tenant, each with a
  // best-effort projection + (when valid) a ready-to-paste golden + linked
  // convention proposals. It NEVER writes a parser config and never joins the
  // production scorer / market-match read path. See
  // docs/helios/catalog-market-data/PARSE_FEEDBACK_PROMOTION.md.
  server.get(
    '/api/catalog/family-explorer/parse-feedback/promotion-export',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'admin')
      if (!user) return
      const parsed = PromotionExportQuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
      }
      try {
        const rows = await loadPromotionExportFeedback(getPool(), {
          retailerId: parsed.data.retailerId,
          statuses: parsed.data.statuses,
          limit: PROMOTION_EXPORT_MAX_CORRECTIONS,
        })
        const { groups, totalCorrections } = buildPromotionExportGroups(
          parsed.data.retailerId,
          rows.corrections,
          rows.conventionsByCorrectionId,
        )
        return reply.send(
          PromotionExportResponseSchema.parse({
            retailerId: parsed.data.retailerId,
            statuses: parsed.data.statuses,
            totalCorrections,
            truncated: rows.truncated,
            groups,
          }),
        )
      } catch (error) {
        if (isMigrationMissing(error)) return sendMigrationMissing(reply)
        throw error
      }
    },
  )
}
