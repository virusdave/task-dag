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
import {
  classifyReviewSentiment,
  computeDegradedPass,
  type ReviewLlmGateOutput,
  type ReviewLlmVerdict,
} from '../llm/reviewSentimentGate.js'
import { pageDave } from '../../worker/runtime/pageDave.js'

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
  return (
    /relation .*(review_submissions|review_contact_info|review_drawing_entries|review_emails|site_review_settings).* does not exist/i.test(
      error.message,
    ) ||
    // A2 added llm_verdict / degraded_pass / llm_raw / llm_model_ref /
    // llm_at / review_provider_url to review_submissions in migration
    // 023; surface the same migration-banner-friendly 503 when the
    // operator hasn't applied it yet.
    /column .*(llm_verdict|degraded_pass|llm_raw|llm_model_ref|llm_at|review_provider_url).* does not exist/i.test(
      error.message,
    )
  )
}

const MIGRATION_HINT =
  'Customer-review tables / columns are missing. Apply migrations 022_customer_reviews_capture.sql and 023_customer_reviews_llm_gate.sql.'

function getRequestSourceIp(request: FastifyRequest): string | null {
  // Fastify's request.ip already handles proxy-trust (we don't enable
  // proxy trust today, so this is the direct socket peer).  Capture
  // X-Forwarded-For as well for the raw_payload audit trail.
  const direct = request.ip ?? null
  return direct && direct.length > 0 ? direct : null
}

function buildProviderReviewUrl(template: string | null, dealerId: number): string | null {
  if (template === null || template.length === 0) return null
  // A2 still does only the trivial dealer-id substitution; the
  // per-site PlaceID source the epic refers to does not exist in
  // this repo's history (verified across all branches at A2 land).
  // Operators populate review_provider_url_template with a
  // pre-substituted URL or a {dealer_id} placeholder until a
  // dedicated PlaceID store is added.
  return template.replace(/\{dealer_id\}/g, String(dealerId))
}

// =====================================================================
// A2 LLM-gate orchestration. Pure helpers so the submit handler is
// easy to read and exhaustively unit-testable.
// =====================================================================

interface GateDecisionInput {
  starRating: number
  reviewText: string | null
  gateEnabled: boolean
  // null when the per-site review_provider_url_template is unset.
  resolvedProviderUrl: string | null
}

interface GateDecision {
  /** Verdict to persist on review_submissions.llm_verdict. */
  verdict: ReviewLlmVerdict | null
  /** Whether the operator-settled degraded-pass heuristic accepted it. */
  degradedPass: boolean | null
  /** Raw LLM payload to persist (only when the gate actually ran). */
  llmRaw: unknown | null
  llmModelRef: string | null
  llmAt: Date | null
  /** Pre-error message for logging / paging. Only set on verdict='error'. */
  errorMessage: string | null
  /** What the public landing page should do next. */
  nextStep: 'show_drawing_form' | 'thank_customer'
  /** Whether to surface the paste-text upsell on the drawing form. */
  offerPasteText: boolean
  /** The substituted URL to surface (only when offerPasteText=true). */
  pasteTextUrl: string | null
}

// Verdict → UX policy table. Single source of truth for both the
// public response shape AND the persisted state, so the operator
// /reviews/<id> page never disagrees with what the customer saw.
function mapVerdictToUx(
  verdict: ReviewLlmVerdict,
  degradedPass: boolean,
  resolvedProviderUrl: string | null,
): Pick<GateDecision, 'nextStep' | 'offerPasteText' | 'pasteTextUrl'> {
  if (verdict === 'strong-with-text') {
    return {
      nextStep: 'show_drawing_form',
      offerPasteText: resolvedProviderUrl !== null,
      pasteTextUrl: resolvedProviderUrl,
    }
  }
  if (verdict === 'error' && degradedPass) {
    // Operator-settled: treat degraded_pass=true as 'passed' UX —
    // drawing form AND paste-text offer, same as strong-with-text.
    return {
      nextStep: 'show_drawing_form',
      offerPasteText: resolvedProviderUrl !== null,
      pasteTextUrl: resolvedProviderUrl,
    }
  }
  if (verdict === 'strong-no-text' || verdict === 'error') {
    // Drawing form yes, paste-text no.
    return {
      nextStep: 'show_drawing_form',
      offerPasteText: false,
      pasteTextUrl: null,
    }
  }
  // 'lukewarm' or 'negative' → no drawing form, no paste-text.
  return {
    nextStep: 'thank_customer',
    offerPasteText: false,
    pasteTextUrl: null,
  }
}

async function runGateAndDecide(input: GateDecisionInput): Promise<GateDecision> {
  const textHasContent = input.reviewText !== null && input.reviewText.length > 0

  // Two short-circuit paths the spec calls out explicitly:
  //   - no text                  → verdict='strong-no-text', no gate call.
  //   - gate disabled per-site   → verdict='strong-no-text', no gate call.
  // Both routes leave llm_raw / llm_model_ref / llm_at NULL so the
  // operator can tell the gate was skipped, not run.
  if (!textHasContent || !input.gateEnabled) {
    const ux = mapVerdictToUx('strong-no-text', false, input.resolvedProviderUrl)
    return {
      verdict: 'strong-no-text',
      degradedPass: null,
      llmRaw: null,
      llmModelRef: null,
      llmAt: null,
      errorMessage: null,
      ...ux,
    }
  }

  const gateResult: ReviewLlmGateOutput = await classifyReviewSentiment({
    starRating: input.starRating,
    reviewText: input.reviewText!,
  })

  if (gateResult.verdict === 'error') {
    const degradedPass = computeDegradedPass(input.reviewText!)
    const ux = mapVerdictToUx('error', degradedPass, input.resolvedProviderUrl)
    return {
      verdict: 'error',
      degradedPass,
      llmRaw: gateResult.raw,
      llmModelRef: gateResult.modelRef,
      llmAt: new Date(),
      errorMessage: gateResult.errorMessage,
      ...ux,
    }
  }

  const ux = mapVerdictToUx(gateResult.verdict, false, input.resolvedProviderUrl)
  return {
    verdict: gateResult.verdict,
    degradedPass: null,
    llmRaw: gateResult.raw,
    llmModelRef: gateResult.modelRef,
    llmAt: new Date(),
    errorMessage: null,
    ...ux,
  }
}

// P3 page on every llm_verdict='error' event. We never let the page
// itself fail the submit POST — the customer already paid the
// LLM-gateway latency and we still want to record the submission +
// route them to a sensible UX. Logged on best-effort failure.
async function pageDaveOnGateError(args: {
  submissionId: string
  appBaseUrl: string
  errorMessage: string | null
  logger: { error: (obj: unknown, msg: string) => void }
}): Promise<void> {
  const detailUrl = new URL(`/reviews/${args.submissionId}`, args.appBaseUrl).toString()
  const body = [
    'Customer-review LLM gate returned verdict=error.',
    `Submission: ${detailUrl}`,
    args.errorMessage ? `Error: ${args.errorMessage}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
  try {
    await pageDave(body, { priority: 3, title: 'review LLM gate error' })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    args.logger.error({ err: msg, submissionId: args.submissionId }, 'pageDave failed for review LLM gate error')
  }
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

      const normalizedText =
        (parsed.reviewText ?? '').trim().length > 0 ? parsed.reviewText!.trim() : null

      // A2: run the per-site LLM sentiment + suitability gate (and
      // its degraded-pass fallback on error) BEFORE persisting, so
      // the verdict / provider URL / degraded-pass bit all land on
      // the row in a single insert. Side-effects (page Dave) fire
      // after the row exists so the page links to a real
      // submission_id.
      const resolvedProviderUrl = buildProviderReviewUrl(
        settings.review_provider_url_template,
        parsed.dealerId,
      )
      const gateDecision = await runGateAndDecide({
        starRating: parsed.starRating,
        reviewText: normalizedText,
        gateEnabled: settings.review_llm_gate_enabled,
        resolvedProviderUrl,
      })

      const result = await insertReviewSubmission(getPool(), {
        dealerId: parsed.dealerId,
        starRating: parsed.starRating,
        reviewText: normalizedText,
        submissionKind: parsed.submissionKind,
        sourceIp: getRequestSourceIp(request),
        userAgent: request.headers['user-agent'] ?? null,
        referrer: (request.headers.referer ?? request.headers.referrer ?? null) as string | null,
        rawPayload: parsed,
        contacts: parsed.contacts ?? [],
        llmVerdict: gateDecision.verdict,
        degradedPass: gateDecision.degradedPass,
        llmRaw: gateDecision.llmRaw,
        llmModelRef: gateDecision.llmModelRef,
        llmAt: gateDecision.llmAt,
        reviewProviderUrl: gateDecision.pasteTextUrl,
      })

      // Best-effort P3 page on llm_verdict='error'. Fire-and-await so
      // the customer sees a consistent response time on the rare gate
      // failure, but we don't block any future submit on the page
      // CLI itself failing (handled inside pageDaveOnGateError).
      if (gateDecision.verdict === 'error') {
        await pageDaveOnGateError({
          submissionId: result.submissionId,
          appBaseUrl: env.appBaseUrl,
          errorMessage: gateDecision.errorMessage,
          logger: request.log,
        })
      }

      return reply.send(
        CustomerReviewSubmitResponseSchema.parse({
          submissionId: result.submissionId,
          acceptedAt: result.createdAt.toISOString(),
          nextStep: gateDecision.nextStep,
          providerReviewUrl: gateDecision.pasteTextUrl,
          offerPasteText: gateDecision.offerPasteText,
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
