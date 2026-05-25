import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  CustomerReviewActionForceSegmentRequestSchema,
  CustomerReviewActionMarkFraudulentRequestSchema,
  CustomerReviewActionResponseSchema,
  CustomerReviewAddCandidateToSegmentRequestSchema,
  CustomerReviewCandidatePurchasesResponseSchema,
  CustomerReviewDrawingEntryRequestSchema,
  CustomerReviewDrawingEntryResponseSchema,
  CustomerReviewDrawingListResponseSchema,
  CustomerReviewListResponseSchema,
  CustomerReviewResendEmailResponseSchema,
  CustomerReviewSubmitRequestSchema,
  CustomerReviewSubmitResponseSchema,
  type CustomerReviewActionResponse,
  type CustomerReviewListItem,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getServerEnv } from '../config/env.js'
import { getPool } from '../db/pool.js'
import {
  acknowledgeDrawingEntry,
  getReviewSubmissionDealerId,
  getReviewSubmissionDetail,
  getReviewSubmissionForRender,
  getSiteReviewSettings,
  insertContactInfoRows,
  insertDrawingEntry,
  insertReviewSubmission,
  listCustomerReviews,
  listDrawingEntries,
  markSubmissionFraudulent,
  setDrawingEntrySegmentOutcomes,
  setDrawingEntrySingleSegmentOutcome,
  setSubmissionLlmFields,
  UNACKNOWLEDGE_WINDOW_SECONDS,
  unacknowledgeDrawingEntry,
  type CustomerReviewDetailRow,
  type DrawingListEntry,
  type SegmentKind,
} from '../db/queries/customerReviewsQueries.js'
import {
  classifyReviewSentiment,
  computeDegradedPass,
  type ReviewLlmGateOutput,
  type ReviewLlmVerdict,
} from '../llm/reviewSentimentGate.js'
import {
  performDrawingSegmentAdd,
  performForceSegmentAdd,
  performForceSegmentRemove,
  type PerSegmentOutcome,
} from '../customerReviews/segmentOrchestrator.js'
import {
  loadCandidatePurchases,
  LOOK_AHEAD_MINUTES,
  LOOK_BACK_MINUTES,
} from '../customerReviews/candidatePurchases.js'
import { addSegmentMember } from '../../worker/sweed/customers.js'
import { withSweedSession } from '../../worker/sweed/session.js'
import {
  buildTemplateVars,
  pickTemplateKind,
  queueAndSendReviewEmails,
  renderTemplate,
  resolveRecipients,
} from '../reviews/emailPipeline.js'
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
    // 023; A4 added accepted_paste_offer / sweed_customer_id /
    // drawing_segment_id / free_preroll_segment_id / fraudulent in
    // migration 024. Surface the same migration-banner-friendly 503
    // when the operator hasn't applied either yet.
    /column .*(llm_verdict|degraded_pass|llm_raw|llm_model_ref|llm_at|review_provider_url|accepted_paste_offer|sweed_customer_id|drawing_segment_id|free_preroll_segment_id|fraudulent|fraudulent_marked_at|fraudulent_marked_by).* does not exist/i.test(
      error.message,
    )
  )
}

const MIGRATION_HINT =
  'Customer-review tables / columns are missing. Apply migrations 022_customer_reviews_capture.sql, 023_customer_reviews_llm_gate.sql, and 024_customer_reviews_sweed_integration.sql.'

function getRequestSourceIp(request: FastifyRequest): string | null {
  // Fastify's request.ip already handles proxy-trust (we don't enable
  // proxy trust today, so this is the direct socket peer).  Capture
  // X-Forwarded-For as well for the raw_payload audit trail.
  const direct = request.ip ?? null
  return direct && direct.length > 0 ? direct : null
}

// Per task spec: free-preroll segment add is gated on
//   verdict == 'strong-with-text' OR (verdict == 'error' AND degraded_pass)
// AND on the customer accepting the paste-text offer (caller-checked).
export function verdictMakesFreePrerollEligible(
  verdict: ReviewLlmVerdict | null,
  degradedPass: boolean | null,
): boolean {
  if (verdict === 'strong-with-text') return true
  if (verdict === 'error' && degradedPass === true) return true
  return false
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

// A3: best-effort wrapper around the email pipeline. Pulls the
// verdict→bucket → recipients → render → enqueue sequence into one
// place so the submit handler can fire-and-forget without leaking
// pipeline internals or letting an email failure fail the customer's
// POST.
interface TryEmailInput {
  submissionId: string
  dealerId: number
  siteLabel: string
  siteEmails: {
    review_email_dave: string | null
    review_email_support: string | null
    review_email_ops: string | null
  }
  starRating: number | null
  reviewText: string | null
  contacts: Array<{ kind: 'phone' | 'email' | 'name' | 'other'; value: string }>
  llmVerdict: ReviewLlmVerdict | null
  degradedPass: boolean | null
  llmRationale: string | null
  providerReviewUrl: string | null
  createdAt: Date
  appBaseUrl: string
  fromAddress: string
  logger: { error: (obj: unknown, msg: string) => void; info: (obj: unknown, msg: string) => void }
}

async function tryEmailReviewSubmission(input: TryEmailInput): Promise<void> {
  try {
    const templateKind = pickTemplateKind(input.llmVerdict, input.degradedPass)
    if (templateKind === null) {
      return // strong-no-text path or no verdict — no email per A3 spec.
    }
    const recipients = resolveRecipients(templateKind, input.siteEmails)
    if (recipients.length === 0) {
      input.logger.info(
        { submissionId: input.submissionId, templateKind },
        'A3 email: no recipients configured for site; nothing to queue',
      )
      return
    }
    const vars = buildTemplateVars({
      submissionId: input.submissionId,
      dealerId: input.dealerId,
      siteLabel: input.siteLabel,
      starRating: input.starRating,
      reviewText: input.reviewText,
      contacts: input.contacts,
      llmVerdict: input.llmVerdict,
      degradedPass: input.degradedPass,
      llmRationale: input.llmRationale,
      providerReviewUrl: input.providerReviewUrl,
      createdAt: input.createdAt,
      adminBaseUrl: input.appBaseUrl,
    })
    const rendered = await renderTemplate(templateKind, vars)
    await queueAndSendReviewEmails({
      db: getPool(),
      submissionId: input.submissionId,
      templateKind,
      recipients,
      rendered,
      fromAddress: input.fromAddress,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    input.logger.error(
      { err: msg, submissionId: input.submissionId },
      'A3 email pipeline failed (submit response unaffected)',
    )
  }
}

// Extract the assistant's rationale string out of llm_raw for the
// email template substitution. Mirrors the parser in
// customerReviewsQueries.extractLlmRationale so the live submit
// path and the resend path render the same value.
function extractRationaleFromRaw(rawJson: unknown): string | null {
  if (rawJson === null || typeof rawJson !== 'object') return null
  const choices = (rawJson as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (typeof first !== 'object' || first === null) return null
  const message = (first as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return null
  const content = (message as { content?: unknown }).content
  let assistantText: string | null = null
  if (typeof content === 'string') assistantText = content
  if (Array.isArray(content)) {
    assistantText = content
      .map((part) =>
        typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
  }
  if (assistantText === null) return null
  try {
    const parsed: unknown = JSON.parse(assistantText)
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as { rationale?: unknown }).rationale === 'string'
    ) {
      return (parsed as { rationale: string }).rationale
    }
  } catch {
    return assistantText.length > 0 ? assistantText : null
  }
  return null
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

      // A3: queue (and optionally send) the bucket-appropriate email
      // notification(s). Best-effort — failures land as failed/queued
      // rows on review_emails and are surfaced on the operator UI.
      // Never block the public response on an email pipeline issue.
      await tryEmailReviewSubmission({
        submissionId: result.submissionId,
        dealerId: parsed.dealerId,
        siteLabel: settings.site_label,
        siteEmails: {
          review_email_dave: settings.review_email_dave,
          review_email_support: settings.review_email_support,
          review_email_ops: settings.review_email_ops,
        },
        starRating: parsed.starRating,
        reviewText: normalizedText,
        contacts: parsed.contacts ?? [],
        llmVerdict: gateDecision.verdict,
        degradedPass: gateDecision.degradedPass,
        llmRationale: extractRationaleFromRaw(gateDecision.llmRaw),
        providerReviewUrl: gateDecision.pasteTextUrl,
        createdAt: result.createdAt,
        appBaseUrl: env.appBaseUrl,
        fromAddress: env.reviewsEmailFromAddress,
        logger: request.log,
      })

      // Surface the resolved provider URL whenever the site has one
      // configured AND the bucket UX keeps the customer on the
      // drawing-form path (5★ / 4★-with-text / degraded-pass). The
      // client uses it both for the 5★ auto-open-Google behavior
      // and for the paste-text upsell when the customer typed a
      // review. We deliberately do NOT expose it on the
      // thank_customer (lukewarm/negative) path — we don't want to
      // funnel unhappy customers to Google.
      const responseProviderUrl =
        gateDecision.nextStep === 'show_drawing_form' ? resolvedProviderUrl : null
      return reply.send(
        CustomerReviewSubmitResponseSchema.parse({
          submissionId: result.submissionId,
          acceptedAt: result.createdAt.toISOString(),
          nextStep: gateDecision.nextStep,
          providerReviewUrl: responseProviderUrl,
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

        const entry = await insertDrawingEntry(
          getPool(),
          request.params.submissionId,
          dealerId,
          parsed.acceptedPasteOffer === true,
        )
        if (entry === null) {
          // Insertion + lookup both returned no row — shouldn't be
          // possible given the on-conflict path, but fail loudly.
          return reply.status(500).send({ error: 'Could not create drawing entry.' })
        }

        // A4 — fire the Sweed segment-add path. The orchestrator decides
        // which segments to attempt (drawing always when id non-null;
        // free-preroll only on strong-with-text/degraded + accepted-paste-
        // offer) and persists the per-segment outcome. Errors are
        // swallowed inside the orchestrator and surfaced as 'failed' rows
        // so a Sweed outage does NOT fail the customer's submit.
        const detail = await getReviewSubmissionDetail(getPool(), request.params.submissionId)
        if (detail !== null) {
          try {
            const result = await performDrawingSegmentAdd({
              dealerId,
              drawingSegmentId: settings.sweed_drawing_segment_id,
              freePrerollSegmentId: settings.sweed_free_preroll_segment_id,
              freePrerollEligibleByVerdict: verdictMakesFreePrerollEligible(
                detail.llmVerdict,
                detail.degradedPass,
              ),
              acceptedPasteOffer: parsed.acceptedPasteOffer === true,
              contacts: detail.contacts,
            })
            await setDrawingEntrySegmentOutcomes(
              getPool(),
              entry.drawingEntryId,
              result.drawing,
              result.freePreroll,
              result.customer?.customerId ?? null,
            )
          } catch (error) {
            // Defense-in-depth: even if the orchestrator throws
            // (shouldn't, but transport-level surprises happen),
            // record the outage on both segment columns so the
            // operator can re-try via force-add-segment.
            const reason = error instanceof Error ? error.message : String(error)
            request.log.error(
              { err: reason, submissionId: request.params.submissionId },
              'drawing-entry segment-add failed unexpectedly',
            )
            const failed: PerSegmentOutcome = {
              status: 'failed',
              error: reason,
              segmentId: null,
              attemptedAt: new Date(),
            }
            await setDrawingEntrySegmentOutcomes(
              getPool(),
              entry.drawingEntryId,
              failed,
              failed,
              null,
            )
          }
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

  // ------------------------- internal GET /api/customer-reviews/:id
  // Detail-page loader: same shape as a single list-item row.
  server.get<{ Params: { submissionId: string } }>(
    '/api/customer-reviews/:submissionId',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'viewer')
      if (!user) return
      try {
        const item = await loadSingleListItem(request.params.submissionId)
        if (item === null) {
          return reply.status(404).send({ error: 'Unknown submission_id' })
        }
        return reply.send({ item, captureEnabled: getServerEnv().reviewsCaptureV1Enabled })
      } catch (error) {
        if (isMissingReviewTableError(error)) {
          return reply.status(503).send({ error: MIGRATION_HINT })
        }
        throw error
      }
    },
  )

  // ------------------------- internal POST /api/customer-reviews/:id/acknowledge
  server.post<{ Params: { submissionId: string } }>(
    '/api/customer-reviews/:submissionId/acknowledge',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      try {
        const ok = await acknowledgeDrawingEntry(
          getPool(),
          request.params.submissionId,
          user.email,
        )
        if (!ok) {
          return reply.status(404).send({ error: 'No drawing entry to acknowledge.' })
        }
        return reply.send(
          await buildActionResponse(request.params.submissionId, 'Acknowledged.'),
        )
      } catch (error) {
        if (isMissingReviewTableError(error)) {
          return reply.status(503).send({ error: MIGRATION_HINT })
        }
        throw error
      }
    },
  )

  // ------------------------- internal POST /api/customer-reviews/:id/unacknowledge (A5)
  server.post<{ Params: { submissionId: string } }>(
    '/api/customer-reviews/:submissionId/unacknowledge',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      try {
        const outcome = await unacknowledgeDrawingEntry(getPool(), request.params.submissionId)
        if (!outcome.updated) {
          if (outcome.reason === 'window_expired') {
            return reply.status(409).send({
              error: `Acknowledge is no longer reversible (>${UNACKNOWLEDGE_WINDOW_SECONDS}s old). Mark fraudulent if you need to re-surface this entry.`,
            })
          }
          return reply.status(404).send({ error: 'No acknowledged drawing entry to undo.' })
        }
        return reply.send(
          await buildActionResponse(request.params.submissionId, 'Acknowledge undone.'),
        )
      } catch (error) {
        if (isMissingReviewTableError(error)) {
          return reply.status(503).send({ error: MIGRATION_HINT })
        }
        throw error
      }
    },
  )

  // ------------------------- internal GET /api/customer-reviews/drawing (A5)
  // Exportable list of review_drawing_entries. Query string:
  //   ?site=<dealerId>&since=<iso>&includeAcked=1&includeFraudulent=1
  // Default view is "actionable now": not-fraudulent + not-acknowledged.
  server.get(
    '/api/customer-reviews/drawing',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'viewer')
      if (!user) return
      const filters = parseDrawingFilters(request.query as Record<string, unknown>)
      try {
        const items = await listDrawingEntries(getPool(), filters)
        return reply.send(
          CustomerReviewDrawingListResponseSchema.parse({
            items,
            filters: {
              dealerId: filters.dealerId ?? null,
              sinceIso: filters.sinceIso ?? null,
              includeAcked: !!filters.includeAcked,
              includeFraudulent: !!filters.includeFraudulent,
            },
            undoWindowSeconds: UNACKNOWLEDGE_WINDOW_SECONDS,
            captureEnabled: getServerEnv().reviewsCaptureV1Enabled,
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

  // ------------------------- internal GET /api/customer-reviews/drawing.csv (A5)
  server.get('/api/customer-reviews/drawing.csv', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const filters = parseDrawingFilters(request.query as Record<string, unknown>)
    try {
      const items = await listDrawingEntries(getPool(), filters)
      const csv = renderDrawingCsv(items)
      const fileSite = filters.dealerId == null ? 'all-sites' : `dealer-${filters.dealerId}`
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const filename = `reviews-drawing-${fileSite}-${today}.csv`
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Cache-Control', 'no-store')
      return reply.send(csv)
    } catch (error) {
      if (isMissingReviewTableError(error)) {
        return reply.status(503).send({ error: MIGRATION_HINT })
      }
      throw error
    }
  })

  // ------------------------- internal POST /api/customer-reviews/:id/re-run-llm
  server.post<{ Params: { submissionId: string } }>(
    '/api/customer-reviews/:submissionId/re-run-llm',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      try {
        const detail = await getReviewSubmissionDetail(getPool(), request.params.submissionId)
        if (detail === null) {
          return reply.status(404).send({ error: 'Unknown submission_id' })
        }
        const settings = await getSiteReviewSettings(getPool(), detail.dealerId)
        if (settings === null) {
          return reply.status(404).send({ error: 'Site config missing for submission.' })
        }
        const resolvedProviderUrl = buildProviderReviewUrl(
          settings.review_provider_url_template,
          detail.dealerId,
        )
        const gateDecision = await runGateAndDecide({
          starRating: detail.starRating ?? 0,
          reviewText: detail.reviewText,
          // Force the gate ON for an explicit operator re-run, regardless
          // of the per-site flag — the operator clicking the button is
          // unambiguous intent.
          gateEnabled: true,
          resolvedProviderUrl,
        })
        await setSubmissionLlmFields(getPool(), request.params.submissionId, {
          llmVerdict: gateDecision.verdict,
          degradedPass: gateDecision.degradedPass,
          llmRaw: gateDecision.llmRaw,
          llmModelRef: gateDecision.llmModelRef,
          llmAt: gateDecision.llmAt,
          reviewProviderUrl: gateDecision.pasteTextUrl,
        })
        if (gateDecision.verdict === 'error') {
          await pageDaveOnGateError({
            submissionId: request.params.submissionId,
            appBaseUrl: getServerEnv().appBaseUrl,
            errorMessage: gateDecision.errorMessage,
            logger: request.log,
          })
        }
        return reply.send(
          await buildActionResponse(
            request.params.submissionId,
            `Re-ran LLM gate → verdict=${gateDecision.verdict ?? 'null'}`,
          ),
        )
      } catch (error) {
        if (isMissingReviewTableError(error)) {
          return reply.status(503).send({ error: MIGRATION_HINT })
        }
        throw error
      }
    },
  )

  // ------------------------- internal POST /api/customer-reviews/:id/segment/add
  server.post<{ Params: { submissionId: string } }>(
    '/api/customer-reviews/:submissionId/segment/add',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      try {
        const parsed = CustomerReviewActionForceSegmentRequestSchema.parse(request.body ?? {})
        const detail = await getReviewSubmissionDetail(getPool(), request.params.submissionId)
        if (detail === null || detail.drawing === null) {
          return reply
            .status(404)
            .send({ error: 'No drawing entry for this submission yet.' })
        }
        const settings = await getSiteReviewSettings(getPool(), detail.dealerId)
        if (settings === null) {
          return reply.status(404).send({ error: 'Site config missing for submission.' })
        }
        const segmentId = pickConfiguredSegmentId(settings, parsed.segment)
        if (segmentId === null) {
          return reply.status(409).send({
            error: `Per-site ${parsed.segment} segment id is NULL — set it in site_review_settings first.`,
          })
        }
        const { customer, outcome } = await performForceSegmentAdd({
          dealerId: detail.dealerId,
          segmentId,
          contacts: detail.contacts,
          existingCustomerId: detail.drawing.sweedCustomerId,
        })
        await setDrawingEntrySingleSegmentOutcome(
          getPool(),
          detail.drawing.id,
          parsed.segment === 'drawing' ? 'drawing' : 'free_preroll',
          outcome,
          customer?.customerId ?? null,
        )
        return reply.send(
          await buildActionResponse(
            request.params.submissionId,
            `Force-add ${parsed.segment} → ${outcome.status}${outcome.error ? `: ${outcome.error}` : ''}`,
          ),
        )
      } catch (error) {
        if (isMissingReviewTableError(error)) {
          return reply.status(503).send({ error: MIGRATION_HINT })
        }
        throw error
      }
    },
  )

  // ------------------------- internal GET /api/customer-reviews/:id/candidate-purchases
  //
  // List Sweed retail invoices around the submission moment, ranked
  // by time-proximity, so the operator can attach a likely-buyer
  // when the submission carries no phone/email. Opens its own
  // withSweedSession; errors bubble to the SPA so the panel can show
  // "Sweed lookup failed: <reason>" instead of silently empty.
  server.get<{ Params: { submissionId: string } }>(
    '/api/customer-reviews/:submissionId/candidate-purchases',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'viewer')
      if (!user) return
      try {
        const detail = await getReviewSubmissionDetail(getPool(), request.params.submissionId)
        if (detail === null) {
          return reply.status(404).send({ error: 'Unknown submission_id' })
        }
        const candidates = await loadCandidatePurchases({
          dealerId: detail.dealerId,
          submittedAt: detail.createdAt,
        })
        return reply.send(
          CustomerReviewCandidatePurchasesResponseSchema.parse({
            submissionId: request.params.submissionId,
            submittedAt: detail.createdAt.toISOString(),
            candidates,
            lookBackMinutes: LOOK_BACK_MINUTES,
            lookAheadMinutes: LOOK_AHEAD_MINUTES,
          }),
        )
      } catch (error) {
        if (isMissingReviewTableError(error)) {
          return reply.status(503).send({ error: MIGRATION_HINT })
        }
        const message = error instanceof Error ? error.message : String(error)
        return reply.status(502).send({ error: `Sweed lookup failed: ${message}` })
      }
    },
  )

  // ------------------------- internal POST /api/customer-reviews/:id/candidate-purchases/add-to-segment
  //
  // Operator picked a candidate row. We:
  //   1. Persist its phone / email / name on review_contact_info so
  //      the Contacts cell stops being empty next reload.
  //   2. Ensure a drawing_entry row exists so the same segment outcome
  //      columns the existing UI already renders pick this up.
  //   3. Call Sweed addSegmentMember directly with the candidate's
  //      client id (we skip find-or-create — the candidate already
  //      gave us the id).
  //   4. Persist the outcome (status + customer id) on the
  //      drawing-entry row.
  server.post<{ Params: { submissionId: string } }>(
    '/api/customer-reviews/:submissionId/candidate-purchases/add-to-segment',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      try {
        const parsed = CustomerReviewAddCandidateToSegmentRequestSchema.parse(
          request.body ?? {},
        )
        const detail = await getReviewSubmissionDetail(getPool(), request.params.submissionId)
        if (detail === null) {
          return reply.status(404).send({ error: 'Unknown submission_id' })
        }
        const settings = await getSiteReviewSettings(getPool(), detail.dealerId)
        if (settings === null) {
          return reply.status(404).send({ error: 'Site config missing for submission.' })
        }
        const segmentId = pickConfiguredSegmentId(settings, parsed.segment)
        if (segmentId === null) {
          return reply.status(409).send({
            error: `Per-site ${parsed.segment} segment id is NULL — set it in site_review_settings first.`,
          })
        }

        // 1) Persist candidate's contact fields so the Contacts column
        //    stops showing "—". Skip blanks.
        const newContacts: Array<{ kind: 'phone' | 'email' | 'name'; value: string }> = []
        if (parsed.contactPhone && parsed.contactPhone.trim().length > 0) {
          newContacts.push({ kind: 'phone', value: parsed.contactPhone.trim() })
        }
        if (parsed.contactEmail && parsed.contactEmail.trim().length > 0) {
          newContacts.push({ kind: 'email', value: parsed.contactEmail.trim() })
        }
        if (parsed.contactName && parsed.contactName.trim().length > 0) {
          newContacts.push({ kind: 'name', value: parsed.contactName.trim() })
        }
        if (newContacts.length > 0) {
          await insertContactInfoRows(getPool(), request.params.submissionId, newContacts)
        }

        // 2) Ensure a drawing_entry row exists. The unique index makes
        //    this idempotent for submissions that already have one.
        const entry = await insertDrawingEntry(
          getPool(),
          request.params.submissionId,
          detail.dealerId,
          detail.drawing?.acceptedPasteOffer ?? false,
        )
        if (entry === null) {
          return reply.status(500).send({ error: 'Could not create drawing entry.' })
        }

        // 3) Call Sweed directly with the candidate's client id.
        let outcome: PerSegmentOutcome
        try {
          await withSweedSession(() =>
            addSegmentMember({
              dealerId: detail.dealerId,
              segmentId,
              customerId: parsed.sweedClientId,
            }),
          )
          outcome = {
            status: 'added',
            error: null,
            segmentId,
            attemptedAt: new Date(),
          }
        } catch (error) {
          outcome = {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
            segmentId,
            attemptedAt: new Date(),
          }
        }

        // 4) Persist outcome on the drawing entry (alongside the
        //    chosen sweed_customer_id).
        await setDrawingEntrySingleSegmentOutcome(
          getPool(),
          entry.drawingEntryId,
          parsed.segment === 'drawing' ? 'drawing' : 'free_preroll',
          outcome,
          parsed.sweedClientId,
        )

        const invoiceLabel = parsed.invoiceId ? ` (invoice ${parsed.invoiceId})` : ''
        return reply.send(
          await buildActionResponse(
            request.params.submissionId,
            `Candidate add ${parsed.segment}${invoiceLabel} → ${outcome.status}${outcome.error ? `: ${outcome.error}` : ''}`,
          ),
        )
      } catch (error) {
        if (isMissingReviewTableError(error)) {
          return reply.status(503).send({ error: MIGRATION_HINT })
        }
        throw error
      }
    },
  )

  // ------------------------- internal POST /api/customer-reviews/:id/segment/remove
  server.post<{ Params: { submissionId: string } }>(
    '/api/customer-reviews/:submissionId/segment/remove',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      try {
        const parsed = CustomerReviewActionForceSegmentRequestSchema.parse(request.body ?? {})
        const detail = await getReviewSubmissionDetail(getPool(), request.params.submissionId)
        if (detail === null || detail.drawing === null) {
          return reply
            .status(404)
            .send({ error: 'No drawing entry for this submission yet.' })
        }
        if (detail.drawing.sweedCustomerId === null) {
          return reply.status(409).send({
            error: 'No Sweed customer id recorded — cannot remove from segment.',
          })
        }
        const settings = await getSiteReviewSettings(getPool(), detail.dealerId)
        if (settings === null) {
          return reply.status(404).send({ error: 'Site config missing for submission.' })
        }
        const segmentId = pickConfiguredSegmentId(settings, parsed.segment)
        if (segmentId === null) {
          return reply.status(409).send({
            error: `Per-site ${parsed.segment} segment id is NULL — set it in site_review_settings first.`,
          })
        }
        const outcome = await performForceSegmentRemove({
          dealerId: detail.dealerId,
          segmentId,
          customerId: detail.drawing.sweedCustomerId,
        })
        await setDrawingEntrySingleSegmentOutcome(
          getPool(),
          detail.drawing.id,
          parsed.segment === 'drawing' ? 'drawing' : 'free_preroll',
          outcome,
          null,
        )
        return reply.send(
          await buildActionResponse(
            request.params.submissionId,
            `Force-remove ${parsed.segment} → ${outcome.status}${outcome.error ? `: ${outcome.error}` : ''}`,
          ),
        )
      } catch (error) {
        if (isMissingReviewTableError(error)) {
          return reply.status(503).send({ error: MIGRATION_HINT })
        }
        throw error
      }
    },
  )

  // ------------------------- internal POST /api/customer-reviews/:id/mark-fraudulent
  server.post<{ Params: { submissionId: string } }>(
    '/api/customer-reviews/:submissionId/mark-fraudulent',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      try {
        const parsed = CustomerReviewActionMarkFraudulentRequestSchema.parse(request.body ?? {})
        const detail = await getReviewSubmissionDetail(getPool(), request.params.submissionId)
        if (detail === null) {
          return reply.status(404).send({ error: 'Unknown submission_id' })
        }
        await markSubmissionFraudulent(
          getPool(),
          request.params.submissionId,
          user.email,
          parsed.fraudulent,
        )
        const messages: string[] = [
          parsed.fraudulent ? 'Marked fraudulent.' : 'Cleared fraudulent.',
        ]
        // On the mark-fraudulent transition, also fire segment removes
        // (per task spec: "attempts segments.remove_member on both
        // per-site segment ids; results persisted"). On the
        // un-mark transition we leave segment columns alone — operators
        // can force-add manually if they want to undo.
        if (parsed.fraudulent && detail.drawing !== null) {
          const settings = await getSiteReviewSettings(getPool(), detail.dealerId)
          const customerId = detail.drawing.sweedCustomerId
          if (settings !== null && customerId !== null) {
            for (const kind of ['drawing', 'free_preroll'] as const) {
              const segmentId = pickConfiguredSegmentId(settings, kind)
              if (segmentId === null) continue
              const outcome = await performForceSegmentRemove({
                dealerId: detail.dealerId,
                segmentId,
                customerId,
              })
              await setDrawingEntrySingleSegmentOutcome(
                getPool(),
                detail.drawing.id,
                kind,
                outcome,
                null,
              )
              messages.push(`auto-remove ${kind} → ${outcome.status}`)
            }
          } else if (customerId === null) {
            messages.push('no sweed_customer_id — skipped segment auto-remove')
          }
        }
        return reply.send(
          await buildActionResponse(request.params.submissionId, messages.join('; ')),
        )
      } catch (error) {
        if (isMissingReviewTableError(error)) {
          return reply.status(503).send({ error: MIGRATION_HINT })
        }
        throw error
      }
    },
  )

  // ------------------------- internal POST /api/customer-reviews/:id/resend-email
  // Re-fire the bucket-appropriate template + recipient set for one
  // submission. Each call appends NEW review_emails rows; previous
  // rows are never mutated (audit trail of every send attempt).
  // Operator-gated (editor role) since this triggers actual SMTP
  // delivery when the relay is configured.
  server.post<{ Params: { submissionId: string } }>(
    '/api/customer-reviews/:submissionId/resend-email',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      try {
        const submission = await getReviewSubmissionForRender(
          getPool(),
          request.params.submissionId,
        )
        if (submission === null) {
          return reply
            .status(404)
            .send({ error: `Unknown submission_id: ${request.params.submissionId}` })
        }
        const settings = await getSiteReviewSettings(getPool(), submission.dealerId)
        if (settings === null) {
          return reply
            .status(404)
            .send({ error: `Unknown site dealer_id: ${submission.dealerId}` })
        }
        const templateKind = pickTemplateKind(submission.llmVerdict, submission.degradedPass)
        if (templateKind === null) {
          return reply.status(409).send({
            error: `No email template for verdict=${submission.llmVerdict ?? 'null'} (strong-no-text and ungated submissions do not emit email).`,
          })
        }
        const recipients = resolveRecipients(templateKind, {
          review_email_dave: settings.review_email_dave,
          review_email_support: settings.review_email_support,
          review_email_ops: settings.review_email_ops,
        })
        if (recipients.length === 0) {
          return reply.status(409).send({
            error: `No recipients configured on site_review_settings for dealer_id=${submission.dealerId} / templateKind=${templateKind}.`,
          })
        }
        const env = getServerEnv()
        const vars = buildTemplateVars({
          submissionId: submission.submissionId,
          dealerId: submission.dealerId,
          siteLabel: settings.site_label,
          starRating: submission.starRating,
          reviewText: submission.reviewText,
          contacts: submission.contacts,
          llmVerdict: submission.llmVerdict,
          degradedPass: submission.degradedPass,
          llmRationale: submission.llmRationale,
          providerReviewUrl: submission.reviewProviderUrl,
          createdAt: submission.createdAt,
          adminBaseUrl: env.appBaseUrl,
        })
        const rendered = await renderTemplate(templateKind, vars)
        const result = await queueAndSendReviewEmails({
          db: getPool(),
          submissionId: submission.submissionId,
          templateKind,
          recipients,
          rendered,
          fromAddress: env.reviewsEmailFromAddress,
        })
        const enqueued = result.emailIds.map((id, idx) => ({
          id,
          templateKind,
          toAddress: result.perRecipient[idx].to,
          subject: rendered.subject,
          sendStatus: result.perRecipient[idx].sendStatus,
          sendError: result.perRecipient[idx].error,
          sentAt: result.perRecipient[idx].sendStatus === 'sent' ? new Date().toISOString() : null,
          createdAt: new Date().toISOString(),
        }))
        return reply.send(
          CustomerReviewResendEmailResponseSchema.parse({
            submissionId: submission.submissionId,
            enqueued,
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
}

// =====================================================================
// Helpers shared by admin actions.
// =====================================================================

function pickConfiguredSegmentId(
  settings: {
    sweed_drawing_segment_id: number | null
    sweed_free_preroll_segment_id: number | null
  },
  kind: 'drawing' | 'free_preroll',
): number | null {
  return kind === 'drawing'
    ? settings.sweed_drawing_segment_id
    : settings.sweed_free_preroll_segment_id
}

async function loadSingleListItem(submissionId: string): Promise<CustomerReviewListItem | null> {
  // Re-use the existing list loader so the response shape never drifts.
  const { items } = await listCustomerReviews(getPool())
  return items.find((it) => it.submissionId === submissionId) ?? null
}

async function buildActionResponse(
  submissionId: string,
  message: string | null,
): Promise<CustomerReviewActionResponse> {
  const item = await loadSingleListItem(submissionId)
  if (item === null) {
    throw new Error(`buildActionResponse: submission ${submissionId} disappeared after action`)
  }
  return CustomerReviewActionResponseSchema.parse({
    submissionId,
    drawingEntry: item.drawingEntry,
    item,
    message,
  })
}

// =====================================================================
// A5 helpers — drawing-list filter parsing + CSV rendering.
// =====================================================================

interface ParsedDrawingFilters {
  dealerId: number | null
  sinceIso: string | null
  includeAcked: boolean
  includeFraudulent: boolean
}

function parseTruthyParam(value: unknown): boolean {
  if (value === undefined || value === null) return false
  const s = String(value).toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

function parseIncludeParam(value: unknown): { acked: boolean; fraudulent: boolean } {
  if (value === undefined || value === null) return { acked: false, fraudulent: false }
  const parts = String(value)
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0)
  return {
    acked: parts.includes('acked') || parts.includes('acknowledged'),
    fraudulent: parts.includes('fraudulent') || parts.includes('fraud'),
  }
}

function parseDrawingFilters(q: Record<string, unknown>): ParsedDrawingFilters {
  const siteRaw = q.site ?? q.dealerId ?? q.dealer_id
  let dealerId: number | null = null
  if (siteRaw !== undefined && siteRaw !== null && String(siteRaw).trim() !== '') {
    const n = Number(siteRaw)
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) dealerId = n
  }
  const sinceRaw = q.since
  let sinceIso: string | null = null
  if (sinceRaw !== undefined && sinceRaw !== null && String(sinceRaw).trim() !== '') {
    const s = String(sinceRaw)
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) sinceIso = d.toISOString()
  }
  const include = parseIncludeParam(q.include)
  return {
    dealerId,
    sinceIso,
    includeAcked: include.acked || parseTruthyParam(q.includeAcked) || parseTruthyParam(q.acked),
    includeFraudulent:
      include.fraudulent ||
      parseTruthyParam(q.includeFraudulent) ||
      parseTruthyParam(q.fraudulent),
  }
}

const CSV_COLUMNS = [
  'created_at',
  'site_label',
  'dealer_id',
  'submission_id',
  'star_rating',
  'review_text_snippet',
  'llm_verdict',
  'degraded_pass',
  'accepted_paste_offer',
  'drawing_segment_status',
  'drawing_segment_id',
  'free_preroll_segment_status',
  'free_preroll_segment_id',
  'contact_name',
  'contact_email',
  'contact_phone',
  'acknowledged_at',
  'acknowledged_by',
  'fraudulent',
] as const

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function renderDrawingCsv(items: DrawingListEntry[]): string {
  const lines: string[] = []
  lines.push(CSV_COLUMNS.join(','))
  for (const it of items) {
    const row: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      created_at: it.createdAt,
      site_label: it.siteLabel,
      dealer_id: it.dealerId,
      submission_id: it.submissionId,
      star_rating: it.starRating,
      review_text_snippet: it.reviewTextSnippet,
      llm_verdict: it.llmVerdict,
      degraded_pass: it.degradedPass,
      accepted_paste_offer: it.acceptedPasteOffer,
      drawing_segment_status: it.drawingSegmentStatus,
      drawing_segment_id: it.drawingSegmentId,
      free_preroll_segment_status: it.freePrerollSegmentStatus,
      free_preroll_segment_id: it.freePrerollSegmentId,
      contact_name: it.contactName,
      contact_email: it.contactEmail,
      contact_phone: it.contactPhone,
      acknowledged_at: it.acknowledgedAt,
      acknowledged_by: it.acknowledgedBy,
      fraudulent: it.fraudulent,
    }
    lines.push(CSV_COLUMNS.map((c) => csvEscape(row[c])).join(','))
  }
  // CRLF for Excel/Numbers compatibility.
  return lines.join('\r\n') + '\r\n'
}
