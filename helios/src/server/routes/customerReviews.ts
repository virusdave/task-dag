import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  CustomerReviewDrawingEntryRequestSchema,
  CustomerReviewDrawingEntryResponseSchema,
  CustomerReviewListResponseSchema,
  CustomerReviewSubmitRequestSchema,
  CustomerReviewSubmitResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getServerEnv } from '../config/env.js'
import { getPool } from '../db/pool.js'
import {
  getReviewSubmissionDealerId,
  getSiteReviewSettings,
  insertContactInfoRows,
  insertDrawingEntry,
  insertReviewSubmission,
  listCustomerReviews,
} from '../db/queries/customerReviewsQueries.js'

// =====================================================================
// Customer-Sentiment Capture (issue #13, A1 phase) — HTTP routes.
//
// Two surfaces:
//
//  1. Public, unauthenticated, gated by HELIOS_REVIEWS_CAPTURE_V1
//     (server-level kill switch) AND per-site review_drawing_enabled
//     (site-level kill switch).  Lives under /v1/reviews/* (NOT /api/)
//     because the mostly-static-sites landing page calls it directly.
//     A1: accept + persist; no LLM (A2), no email (A3), no Sweed (A4).
//
//  2. Internal, session-gated /api/customer-reviews list endpoint
//     driving the Helios /reviews SPA page so operators can watch
//     submissions land in real time.  A1 is read-only.
//
// The public routes are added to LOGIN_FLOW_ENDPOINTS in authGate.ts
// so the site-wide gate lets unauthenticated POSTs through.
// =====================================================================

function isMissingReviewTableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /relation .*(review_submissions|review_contact_info|review_drawing_entries|review_emails|site_review_settings).* does not exist/i.test(
    error.message,
  )
}

const MIGRATION_HINT = 'Customer-review tables are missing. Apply migration 022_customer_reviews_capture.sql.'

function getRequestSourceIp(request: FastifyRequest): string | null {
  // Fastify's request.ip already handles proxy-trust (we don't enable
  // proxy trust today, so this is the direct socket peer).  Capture
  // X-Forwarded-For as well for the raw_payload audit trail.
  const direct = request.ip ?? null
  return direct && direct.length > 0 ? direct : null
}

function buildProviderReviewUrl(template: string | null, dealerId: number): string | null {
  if (template === null || template.length === 0) return null
  // A1 only does the trivial template substitution.  A2 will look up
  // the per-site PlaceID from history and substitute it here.
  return template.replace(/\{dealer_id\}/g, String(dealerId))
}

export async function registerCustomerReviewsRoutes(server: FastifyInstance): Promise<void> {
  // ------------------------- public POST /v1/reviews/submit
  server.post('/v1/reviews/submit', async (request: FastifyRequest, reply: FastifyReply) => {
    const env = getServerEnv()
    if (!env.reviewsCaptureV1Enabled) {
      return reply
        .status(503)
        .send({ error: 'Customer-review capture is disabled on this server.', code: 'capture_disabled' })
    }

    const parsed = CustomerReviewSubmitRequestSchema.parse(request.body ?? {})
    try {
      const settings = await getSiteReviewSettings(getPool(), parsed.dealerId)
      if (settings === null) {
        return reply
          .status(404)
          .send({ error: `Unknown site dealer_id: ${parsed.dealerId}`, code: 'unknown_site' })
      }
      if (!settings.review_drawing_enabled && parsed.submissionKind === 'drawing') {
        return reply
          .status(403)
          .send({ error: 'Drawing entries are not enabled for this site.', code: 'capture_disabled' })
      }

      const result = await insertReviewSubmission(getPool(), {
        dealerId: parsed.dealerId,
        starRating: parsed.starRating,
        reviewText: (parsed.reviewText ?? '').trim().length > 0 ? parsed.reviewText! : null,
        submissionKind: parsed.submissionKind,
        sourceIp: getRequestSourceIp(request),
        userAgent: request.headers['user-agent'] ?? null,
        referrer: (request.headers.referer ?? request.headers.referrer ?? null) as string | null,
        rawPayload: parsed,
        contacts: parsed.contacts ?? [],
      })

      // A1 nextStep decision is intentionally simple: 5-star ->
      // ask for drawing; 1-4 -> thank.  A2 will replace this with
      // the LLM verdict.
      const nextStep =
        parsed.starRating === 5
          ? ('show_drawing_form' as const)
          : ('thank_customer' as const)
      const providerReviewUrl =
        parsed.starRating === 5
          ? buildProviderReviewUrl(settings.review_provider_url_template, parsed.dealerId)
          : null

      return reply.send(
        CustomerReviewSubmitResponseSchema.parse({
          submissionId: result.submissionId,
          acceptedAt: result.createdAt.toISOString(),
          nextStep,
          providerReviewUrl,
        }),
      )
    } catch (error) {
      if (isMissingReviewTableError(error)) {
        return reply.status(503).send({ error: MIGRATION_HINT })
      }
      throw error
    }
  })

  // ------------------------- public POST /v1/reviews/:id/drawing-entry
  server.post<{ Params: { submissionId: string } }>(
    '/v1/reviews/:submissionId/drawing-entry',
    async (request, reply) => {
      const env = getServerEnv()
      if (!env.reviewsCaptureV1Enabled) {
        return reply
          .status(503)
          .send({ error: 'Customer-review capture is disabled on this server.', code: 'capture_disabled' })
      }

      const parsed = CustomerReviewDrawingEntryRequestSchema.parse(request.body ?? {})
      try {
        const dealerId = await getReviewSubmissionDealerId(getPool(), request.params.submissionId)
        if (dealerId === null) {
          return reply
            .status(404)
            .send({
              error: `Unknown submission_id: ${request.params.submissionId}`,
              code: 'submission_not_found',
            })
        }

        const settings = await getSiteReviewSettings(getPool(), dealerId)
        if (settings === null || !settings.review_drawing_enabled) {
          return reply
            .status(403)
            .send({ error: 'Drawing entries are not enabled for this site.', code: 'capture_disabled' })
        }

        // Append any new contact info the customer attached at the
        // drawing-form step (the original submit may have been
        // contact-less).
        if (parsed.contacts && parsed.contacts.length > 0) {
          await insertContactInfoRows(getPool(), request.params.submissionId, parsed.contacts)
        }

        const entry = await insertDrawingEntry(getPool(), request.params.submissionId, dealerId)
        if (entry === null) {
          // Insertion + lookup both returned no row — shouldn't be
          // possible given the on-conflict path, but fail loudly.
          return reply.status(500).send({ error: 'Could not create drawing entry.' })
        }

        return reply.send(
          CustomerReviewDrawingEntryResponseSchema.parse({
            drawingEntryId: entry.drawingEntryId,
            submissionId: request.params.submissionId,
            acceptedAt: entry.createdAt.toISOString(),
          }),
        )
      } catch (error) {
        if (isMissingReviewTableError(error)) {
          return reply.status(503).send({ error: MIGRATION_HINT })
        }
        throw error
      }
    },
  )

  // ------------------------- internal GET /api/customer-reviews
  server.get('/api/customer-reviews', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    try {
      const { items, totalCount } = await listCustomerReviews(getPool())
      return reply.send(
        CustomerReviewListResponseSchema.parse({
          items,
          totalCount,
          captureEnabled: getServerEnv().reviewsCaptureV1Enabled,
        }),
      )
    } catch (error) {
      if (isMissingReviewTableError(error)) {
        return reply.status(503).send({ error: MIGRATION_HINT })
      }
      throw error
    }
  })
}
