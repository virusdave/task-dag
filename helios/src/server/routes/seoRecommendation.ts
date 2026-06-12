// SEO recommendation-engine routes (P5 — the GA4/GSC feedback loop).
//
// Reads imported Search Console metrics (migration 076) and proposes DRAFT
// recommendations an operator can accept or dismiss. IRONCLAD human gate
// (canon §1): a recommendation is never published content. "Accepting" a
// faq_gap only CREATES A DRAFT FAQ SET (status draft, no approval) which
// still has to pass the existing human approve→bundle gate. The engine
// cannot auto-publish; it only fills a review queue.
//
// child FreshlyBakedNYC/automation#44 (P5) · Satisfies: virusdave/top-level#15

import type { FastifyInstance } from 'fastify'

import {
  SeoRecStatusSchema,
  SeoRecommendationAcceptBodySchema,
  SeoRecommendationAcceptResponseSchema,
  SeoRecommendationDetailResponseSchema,
  SeoRecommendationDismissBodySchema,
  SeoRecommendationGenerateBodySchema,
  SeoRecommendationGenerateResponseSchema,
  SeoRecommendationListResponseSchema,
  SeoRecommendationRouteParamsSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { createSeoFaqSet } from '../db/queries/seoFaqQueries.js'
import { getGscQueryGaps, getLowCtrPages } from '../db/queries/seoMetricsQueries.js'
import { MAX_SEO_WINDOW_DAYS, isWindowWithinCap } from '../seo/metricWindow.js'
import {
  acceptRecommendation,
  dismissRecommendation,
  getRecommendation,
  listRecommendations,
  upsertRecommendations,
} from '../db/queries/seoRecommendationQueries.js'
import { buildRecommendations } from '../seo/recommendations.js'

// Conservative defaults for the gap/low-CTR feeders (overridable per call).
const DEFAULT_MIN_IMPRESSIONS = 50
const DEFAULT_MAX_CTR = 0.02
const DEFAULT_MAX_POSITION = 20
const DEFAULT_LIMIT = 100

export async function registerSeoRecommendationRoutes(server: FastifyInstance): Promise<void> {
  // List recommendations (optionally filtered by site/status).
  server.get('/api/seo/recommendations', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const q = request.query as Record<string, string | undefined>
    const status = q.status === undefined ? undefined : SeoRecStatusSchema.parse(q.status)
    const limit = q.limit === undefined ? 200 : Math.min(Math.max(Number(q.limit) || 200, 1), 500)
    const recommendations = await listRecommendations(getPool(), {
      site: q.site,
      status,
      limit,
    })
    return reply.send(SeoRecommendationListResponseSchema.parse({ recommendations }))
  })

  // Get one recommendation.
  server.get('/api/seo/recommendations/:recommendationId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const params = SeoRecommendationRouteParamsSchema.parse(request.params)
    const recommendation = await getRecommendation(getPool(), params.recommendationId)
    if (!recommendation) {
      return reply.status(404).send({ error: 'Recommendation not found.' })
    }
    return reply.send(SeoRecommendationDetailResponseSchema.parse({ recommendation }))
  })

  // Run the generator over a site's imported metrics for a window and upsert
  // OPEN recommendations. Decision-preserving + write-on-change.
  server.post('/api/seo/recommendations/generate', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const body = SeoRecommendationGenerateBodySchema.parse(request.body ?? {})
    if (body.startDate >= body.endDate) {
      return reply.status(400).send({ error: 'startDate must be before endDate.' })
    }
    if (!isWindowWithinCap(body.startDate, body.endDate)) {
      return reply
        .status(400)
        .send({ error: `Date window too large; max ${MAX_SEO_WINDOW_DAYS} days.` })
    }
    const window = {
      site: body.site,
      startDate: body.startDate,
      endDate: body.endDate,
      minImpressions: body.minImpressions ?? DEFAULT_MIN_IMPRESSIONS,
      maxCtr: body.maxCtr ?? DEFAULT_MAX_CTR,
      maxPosition: body.maxPosition ?? DEFAULT_MAX_POSITION,
      limit: body.limit ?? DEFAULT_LIMIT,
    }
    const db = getPool()
    const [gaps, lowCtrPages] = await Promise.all([
      getGscQueryGaps(db, window),
      getLowCtrPages(db, window),
    ])
    const drafts = buildRecommendations(body.site, { gaps, lowCtrPages })
    const counts = await upsertRecommendations(db, drafts)
    return reply.send(SeoRecommendationGenerateResponseSchema.parse(counts))
  })

  // Accept a recommendation. faq_gap → create a draft FAQ set (status draft,
  // no approval) scoped to the recommendation's site, carrying the suggested
  // question + rationale in generation metadata so the operator can author
  // the answer and run it through the existing approve→bundle gate. Returns
  // a link to the new draft (canon §3 user-efficiency).
  server.post('/api/seo/recommendations/:recommendationId/accept', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const params = SeoRecommendationRouteParamsSchema.parse(request.params)
    const body = SeoRecommendationAcceptBodySchema.parse(request.body ?? {})
    const db = getPool()
    const rec = await getRecommendation(db, params.recommendationId)
    if (!rec) {
      return reply.status(404).send({ error: 'Recommendation not found.' })
    }
    if (rec.status !== 'open') {
      return reply.status(409).send({ error: `Recommendation already ${rec.status}.` })
    }
    if (rec.recType !== 'faq_gap') {
      return reply.status(422).send({
        error:
          'Only faq_gap recommendations can be accepted into a draft. Revise the page ' +
          'title/meta in its editor, then dismiss this recommendation.',
      })
    }
    // Create the draft FAQ set first; only then bind the recommendation to
    // it. An empty draft is intentional — the operator authors the answer.
    const faqSet = await createSeoFaqSet(db, {
      scope: rec.site,
      items: [],
      source: 'generated',
      generationMeta: {
        origin: 'seo_recommendation',
        recommendation_id: rec.recommendationId,
        suggested_question: rec.targetQuery,
        target_page_url: rec.targetPageUrl,
        rationale: rec.rationale,
      },
      userId: user.id,
    })
    const updated = await acceptRecommendation(db, {
      recommendationId: rec.recommendationId,
      linkedContentKind: 'faq_set',
      linkedContentId: faqSet.faqSetId,
      userId: user.id,
      note: body.note ?? null,
    })
    if (!updated) {
      // Lost a race (decided concurrently). The empty draft is harmless.
      return reply.status(409).send({ error: 'Recommendation was decided concurrently.' })
    }
    return reply.send(
      SeoRecommendationAcceptResponseSchema.parse({
        recommendation: updated,
        linkedContentKind: 'faq_set',
        linkedContentId: faqSet.faqSetId,
      }),
    )
  })

  // Dismiss a recommendation (no content change).
  server.post('/api/seo/recommendations/:recommendationId/dismiss', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const params = SeoRecommendationRouteParamsSchema.parse(request.params)
    const body = SeoRecommendationDismissBodySchema.parse(request.body ?? {})
    const updated = await dismissRecommendation(getPool(), {
      recommendationId: params.recommendationId,
      userId: user.id,
      note: body.note ?? null,
    })
    if (!updated) {
      const rec = await getRecommendation(getPool(), params.recommendationId)
      if (!rec) {
        return reply.status(404).send({ error: 'Recommendation not found.' })
      }
      return reply.status(409).send({ error: `Recommendation already ${rec.status}.` })
    }
    return reply.send(SeoRecommendationDetailResponseSchema.parse({ recommendation: updated }))
  })
}
