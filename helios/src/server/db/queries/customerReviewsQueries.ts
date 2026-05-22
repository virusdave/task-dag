import { z } from 'zod'

import type {
  CustomerReviewContactInfoInput,
  CustomerReviewContactInfoRow,
  CustomerReviewDrawingEntryRow,
  CustomerReviewListItem,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'

// =====================================================================
// Customer-Sentiment Capture (issue #13, A1 phase) — db queries.
//
// See helios/src/server/db/schema/customerReviews.sql for the table
// shapes and helios/src/server/routes/customerReviews.ts for the
// route layer that drives these queries.
// =====================================================================

const SiteReviewSettingsRowSchema = z.object({
  dealer_id: z.coerce.number().int(),
  site_label: z.string(),
  review_provider_kind: z.enum(['google', 'yelp', 'other']),
  review_provider_url_template: z.string().nullable(),
  review_drawing_enabled: z.boolean(),
  review_free_preroll_enabled: z.boolean(),
  review_llm_gate_enabled: z.boolean(),
  sweed_drawing_segment_id: z.coerce.number().int().nullable(),
  sweed_free_preroll_segment_id: z.coerce.number().int().nullable(),
})
export type SiteReviewSettingsRow = z.infer<typeof SiteReviewSettingsRowSchema>

export async function getSiteReviewSettings(
  db: Queryable,
  dealerId: number,
): Promise<SiteReviewSettingsRow | null> {
  const result = await db.query(
    `select
       dealer_id, site_label, review_provider_kind,
       review_provider_url_template,
       review_drawing_enabled, review_free_preroll_enabled,
       review_llm_gate_enabled,
       sweed_drawing_segment_id, sweed_free_preroll_segment_id
     from site_review_settings
     where dealer_id = $1`,
    [dealerId],
  )
  if (result.rows.length === 0) return null
  return SiteReviewSettingsRowSchema.parse(result.rows[0])
}

export interface InsertReviewSubmissionInput {
  dealerId: number
  starRating: number
  reviewText: string | null
  submissionKind: 'form' | 'drawing' | 'other'
  sourceIp: string | null
  userAgent: string | null
  referrer: string | null
  rawPayload: unknown
  contacts: CustomerReviewContactInfoInput[]
  // A2 LLM-gate columns. All nullable so A1-era callers / submissions
  // with no text / sites with the gate disabled still insert cleanly.
  llmVerdict: 'strong-with-text' | 'strong-no-text' | 'lukewarm' | 'negative' | 'error' | null
  degradedPass: boolean | null
  llmRaw: unknown | null
  llmModelRef: string | null
  llmAt: Date | null
  reviewProviderUrl: string | null
}

export interface InsertReviewSubmissionResult {
  submissionId: string
  createdAt: Date
}

export async function insertReviewSubmission(
  db: Queryable,
  input: InsertReviewSubmissionInput,
): Promise<InsertReviewSubmissionResult> {
  const result = await db.query<{ id: string; created_at: Date }>(
    `insert into review_submissions (
       dealer_id, star_rating, review_text, submission_kind,
       source_ip, user_agent, referrer, raw_payload,
       llm_verdict, degraded_pass, llm_raw, llm_model_ref, llm_at,
       review_provider_url
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
       $9, $10, $11::jsonb, $12, $13,
       $14
     )
     returning id, created_at`,
    [
      input.dealerId,
      input.starRating,
      input.reviewText,
      input.submissionKind,
      input.sourceIp,
      input.userAgent,
      input.referrer,
      JSON.stringify(input.rawPayload ?? {}),
      input.llmVerdict,
      input.degradedPass,
      input.llmRaw === null || input.llmRaw === undefined ? null : JSON.stringify(input.llmRaw),
      input.llmModelRef,
      input.llmAt,
      input.reviewProviderUrl,
    ],
  )
  const row = result.rows[0]
  if (!row) {
    throw new Error('insertReviewSubmission returned no row')
  }
  const submissionId = row.id
  await insertContactInfoRows(db, submissionId, input.contacts)
  return {
    submissionId,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  }
}

export async function insertContactInfoRows(
  db: Queryable,
  submissionId: string,
  contacts: CustomerReviewContactInfoInput[],
): Promise<void> {
  if (contacts.length === 0) return
  // Plain looped insert — never large N, never hot path.
  for (const c of contacts) {
    await db.query(
      `insert into review_contact_info (submission_id, contact_kind, contact_value)
       values ($1, $2, $3)`,
      [submissionId, c.kind, c.value],
    )
  }
}

export async function getReviewSubmissionDealerId(
  db: Queryable,
  submissionId: string,
): Promise<number | null> {
  const result = await db.query<{ dealer_id: number }>(
    `select dealer_id from review_submissions where id = $1`,
    [submissionId],
  )
  if (result.rows.length === 0) return null
  return Number(result.rows[0].dealer_id)
}

export interface InsertDrawingEntryResult {
  drawingEntryId: string
  createdAt: Date
}

export async function insertDrawingEntry(
  db: Queryable,
  submissionId: string,
  dealerId: number,
  acceptedPasteOffer: boolean = false,
): Promise<InsertDrawingEntryResult | null> {
  // The unique index review_drawing_entries_one_per_submission means
  // a second drawing-entry call for the same submission is a no-op
  // (idempotent from the customer's perspective if they double-tap).
  // accepted_paste_offer is updated on conflict so a re-submit that
  // changes the answer (rare, but legal) updates the row.
  const result = await db.query<{ id: string; created_at: Date }>(
    `insert into review_drawing_entries (submission_id, dealer_id, accepted_paste_offer)
     values ($1, $2, $3)
     on conflict (submission_id) do update set accepted_paste_offer =
       excluded.accepted_paste_offer
     returning id, created_at`,
    [submissionId, dealerId, acceptedPasteOffer],
  )
  if (result.rows.length === 0) return null
  const row = result.rows[0]
  return {
    drawingEntryId: row.id,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  }
}

// =====================================================================
// A4 — segment-result persistence + admin-action queries.
// =====================================================================

export type SegmentStatus = 'skipped' | 'failed' | 'added' | 'removed'
export type SegmentKind = 'drawing' | 'free_preroll'

export interface SegmentOutcomeInput {
  status: SegmentStatus
  segmentId: number | null
  error: string | null
  attemptedAt: Date | null
}

export async function setDrawingEntrySegmentOutcomes(
  db: Queryable,
  drawingEntryId: string,
  drawing: SegmentOutcomeInput,
  freePreroll: SegmentOutcomeInput,
  sweedCustomerId: number | null,
): Promise<void> {
  await db.query(
    `update review_drawing_entries
     set drawing_segment_status         = $2,
         drawing_segment_id             = $3,
         drawing_segment_error          = $4,
         drawing_segment_attempted_at   = $5,
         free_preroll_segment_status    = $6,
         free_preroll_segment_id        = $7,
         free_preroll_segment_error     = $8,
         free_preroll_segment_attempted_at = $9,
         sweed_customer_id              = coalesce($10, sweed_customer_id)
     where id = $1`,
    [
      drawingEntryId,
      drawing.status,
      drawing.segmentId,
      drawing.error,
      drawing.attemptedAt,
      freePreroll.status,
      freePreroll.segmentId,
      freePreroll.error,
      freePreroll.attemptedAt,
      sweedCustomerId,
    ],
  )
}

export async function setDrawingEntrySingleSegmentOutcome(
  db: Queryable,
  drawingEntryId: string,
  kind: SegmentKind,
  outcome: SegmentOutcomeInput,
  sweedCustomerId: number | null,
): Promise<void> {
  if (kind === 'drawing') {
    await db.query(
      `update review_drawing_entries
       set drawing_segment_status       = $2,
           drawing_segment_id           = coalesce($3, drawing_segment_id),
           drawing_segment_error        = $4,
           drawing_segment_attempted_at = $5,
           sweed_customer_id            = coalesce($6, sweed_customer_id)
       where id = $1`,
      [
        drawingEntryId,
        outcome.status,
        outcome.segmentId,
        outcome.error,
        outcome.attemptedAt,
        sweedCustomerId,
      ],
    )
    return
  }
  await db.query(
    `update review_drawing_entries
     set free_preroll_segment_status       = $2,
         free_preroll_segment_id           = coalesce($3, free_preroll_segment_id),
         free_preroll_segment_error        = $4,
         free_preroll_segment_attempted_at = $5,
         sweed_customer_id                 = coalesce($6, sweed_customer_id)
     where id = $1`,
    [
      drawingEntryId,
      outcome.status,
      outcome.segmentId,
      outcome.error,
      outcome.attemptedAt,
      sweedCustomerId,
    ],
  )
}

export async function acknowledgeDrawingEntry(
  db: Queryable,
  submissionId: string,
  actor: string,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update review_drawing_entries
     set acknowledged_at = now(),
         acknowledged_by = $2
     where submission_id = $1
     returning id`,
    [submissionId, actor],
  )
  return result.rows.length > 0
}

export async function markSubmissionFraudulent(
  db: Queryable,
  submissionId: string,
  actor: string,
  fraudulent: boolean,
): Promise<void> {
  await db.query(
    `update review_submissions
     set fraud_marked    = $2,
         fraud_marked_at = case when $2 then now() else null end,
         fraud_marked_by = case when $2 then $3   else null end
     where id = $1`,
    [submissionId, fraudulent, actor],
  )
  await db.query(
    `update review_drawing_entries
     set fraudulent           = $2,
         fraudulent_marked_at = case when $2 then now() else null end,
         fraudulent_marked_by = case when $2 then $3   else null end
     where submission_id = $1`,
    [submissionId, fraudulent, actor],
  )
}

export interface CustomerReviewDetailRow {
  submissionId: string
  dealerId: number
  starRating: number | null
  reviewText: string | null
  submissionKind: 'form' | 'drawing' | 'other'
  llmVerdict:
    | 'strong-with-text'
    | 'strong-no-text'
    | 'lukewarm'
    | 'negative'
    | 'error'
    | null
  degradedPass: boolean | null
  reviewProviderUrl: string | null
  fraudMarked: boolean
  contacts: ReadonlyArray<{ kind: 'phone' | 'email' | 'name' | 'other'; value: string }>
  drawing:
    | {
        id: string
        acceptedPasteOffer: boolean
        sweedCustomerId: number | null
        drawingSegmentId: number | null
        freePrerollSegmentId: number | null
        drawingSegmentStatus: SegmentStatus | null
        freePrerollSegmentStatus: SegmentStatus | null
        acknowledgedAt: Date | null
        fraudulent: boolean
      }
    | null
}

export async function getReviewSubmissionDetail(
  db: Queryable,
  submissionId: string,
): Promise<CustomerReviewDetailRow | null> {
  const submissionResult = await db.query(
    `select id, dealer_id, star_rating, review_text, submission_kind,
            llm_verdict, degraded_pass, review_provider_url, fraud_marked
     from review_submissions where id = $1`,
    [submissionId],
  )
  if (submissionResult.rows.length === 0) return null
  const submission = submissionResult.rows[0]

  const contactsResult = await db.query<{ contact_kind: string; contact_value: string }>(
    `select contact_kind, contact_value
     from review_contact_info
     where submission_id = $1
     order by created_at asc`,
    [submissionId],
  )
  const contacts = contactsResult.rows.map((r) => ({
    kind: r.contact_kind as 'phone' | 'email' | 'name' | 'other',
    value: r.contact_value,
  }))

  const drawingResult = await db.query(
    `select id, accepted_paste_offer, sweed_customer_id,
            drawing_segment_id, free_preroll_segment_id,
            drawing_segment_status, free_preroll_segment_status,
            acknowledged_at, fraudulent
     from review_drawing_entries where submission_id = $1`,
    [submissionId],
  )
  const drawingRaw = drawingResult.rows[0] ?? null

  return {
    submissionId: submission.id,
    dealerId: Number(submission.dealer_id),
    starRating: submission.star_rating === null ? null : Number(submission.star_rating),
    reviewText: submission.review_text,
    submissionKind: submission.submission_kind,
    llmVerdict: submission.llm_verdict,
    degradedPass: submission.degraded_pass,
    reviewProviderUrl: submission.review_provider_url,
    fraudMarked: !!submission.fraud_marked,
    contacts,
    drawing:
      drawingRaw === null
        ? null
        : {
            id: drawingRaw.id,
            acceptedPasteOffer: !!drawingRaw.accepted_paste_offer,
            sweedCustomerId:
              drawingRaw.sweed_customer_id === null
                ? null
                : Number(drawingRaw.sweed_customer_id),
            drawingSegmentId:
              drawingRaw.drawing_segment_id === null
                ? null
                : Number(drawingRaw.drawing_segment_id),
            freePrerollSegmentId:
              drawingRaw.free_preroll_segment_id === null
                ? null
                : Number(drawingRaw.free_preroll_segment_id),
            drawingSegmentStatus: drawingRaw.drawing_segment_status,
            freePrerollSegmentStatus: drawingRaw.free_preroll_segment_status,
            acknowledgedAt:
              drawingRaw.acknowledged_at === null
                ? null
                : drawingRaw.acknowledged_at instanceof Date
                  ? drawingRaw.acknowledged_at
                  : new Date(drawingRaw.acknowledged_at),
            fraudulent: !!drawingRaw.fraudulent,
          },
  }
}

export async function setSubmissionLlmFields(
  db: Queryable,
  submissionId: string,
  fields: {
    llmVerdict: 'strong-with-text' | 'strong-no-text' | 'lukewarm' | 'negative' | 'error' | null
    degradedPass: boolean | null
    llmRaw: unknown | null
    llmModelRef: string | null
    llmAt: Date | null
    reviewProviderUrl: string | null
  },
): Promise<void> {
  await db.query(
    `update review_submissions
     set llm_verdict        = $2,
         degraded_pass      = $3,
         llm_raw            = $4::jsonb,
         llm_model_ref      = $5,
         llm_at             = $6,
         review_provider_url = $7
     where id = $1`,
    [
      submissionId,
      fields.llmVerdict,
      fields.degradedPass,
      fields.llmRaw === null || fields.llmRaw === undefined
        ? null
        : JSON.stringify(fields.llmRaw),
      fields.llmModelRef,
      fields.llmAt,
      fields.reviewProviderUrl,
    ],
  )
}

const ListItemRowSchema = z.object({
  submission_id: z.string().uuid(),
  dealer_id: z.coerce.number().int(),
  site_label: z.string(),
  star_rating: z.coerce.number().int().nullable(),
  review_text: z.string().nullable(),
  submission_kind: z.enum(['form', 'drawing', 'other']),
  source_ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  referrer: z.string().nullable(),
  fraud_marked: z.boolean(),
  fraud_marked_at: z.coerce.date().nullable(),
  fraud_marked_by: z.string().nullable(),
  llm_verdict: z
    .enum(['strong-with-text', 'strong-no-text', 'lukewarm', 'negative', 'error'])
    .nullable(),
  degraded_pass: z.boolean().nullable(),
  llm_model_ref: z.string().nullable(),
  llm_at: z.coerce.date().nullable(),
  review_provider_url: z.string().nullable(),
  created_at: z.coerce.date(),
})

const ContactRowSchema = z.object({
  id: z.string().uuid(),
  submission_id: z.string().uuid(),
  contact_kind: z.enum(['phone', 'email', 'name', 'other']),
  contact_value: z.string(),
  created_at: z.coerce.date(),
})

const DrawingRowSchema = z.object({
  id: z.string().uuid(),
  submission_id: z.string().uuid(),
  acknowledged_at: z.coerce.date().nullable(),
  acknowledged_by: z.string().nullable(),
  drawing_segment_status: z.enum(['skipped', 'failed', 'added', 'removed']).nullable(),
  drawing_segment_id: z.coerce.number().int().nullable(),
  drawing_segment_error: z.string().nullable(),
  free_preroll_segment_status: z.enum(['skipped', 'failed', 'added', 'removed']).nullable(),
  free_preroll_segment_id: z.coerce.number().int().nullable(),
  free_preroll_segment_error: z.string().nullable(),
  accepted_paste_offer: z.boolean(),
  sweed_customer_id: z.coerce.number().int().nullable(),
  fraudulent: z.boolean(),
  fraudulent_marked_at: z.coerce.date().nullable(),
  fraudulent_marked_by: z.string().nullable(),
  created_at: z.coerce.date(),
})

export async function listCustomerReviews(
  db: Queryable,
  limit = 200,
): Promise<{ items: CustomerReviewListItem[]; totalCount: number }> {
  const submissionsResult = await db.query(
    `select
       rs.id as submission_id,
       rs.dealer_id,
       coalesce(srs.site_label, ''::text) as site_label,
       rs.star_rating,
       rs.review_text,
       rs.submission_kind,
       rs.source_ip,
       rs.user_agent,
       rs.referrer,
       rs.fraud_marked,
       rs.fraud_marked_at,
       rs.fraud_marked_by,
       rs.llm_verdict,
       rs.degraded_pass,
       rs.llm_model_ref,
       rs.llm_at,
       rs.review_provider_url,
       rs.created_at
     from review_submissions rs
     left join site_review_settings srs on srs.dealer_id = rs.dealer_id
     order by rs.created_at desc
     limit $1`,
    [limit],
  )
  const submissions = submissionsResult.rows.map((r) => ListItemRowSchema.parse(r))
  const submissionIds = submissions.map((s) => s.submission_id)

  const contactsBySubmission = new Map<string, CustomerReviewContactInfoRow[]>()
  const drawingBySubmission = new Map<string, CustomerReviewDrawingEntryRow>()

  if (submissionIds.length > 0) {
    const contactsResult = await db.query(
      `select id, submission_id, contact_kind, contact_value, created_at
       from review_contact_info
       where submission_id = any($1::uuid[])
       order by created_at asc`,
      [submissionIds],
    )
    for (const raw of contactsResult.rows) {
      const parsed = ContactRowSchema.parse(raw)
      const list = contactsBySubmission.get(parsed.submission_id) ?? []
      list.push({
        id: parsed.id,
        kind: parsed.contact_kind,
        value: parsed.contact_value,
        createdAt: parsed.created_at.toISOString(),
      })
      contactsBySubmission.set(parsed.submission_id, list)
    }

    const drawingResult = await db.query(
      `select id, submission_id, acknowledged_at, acknowledged_by,
              drawing_segment_status, drawing_segment_id, drawing_segment_error,
              free_preroll_segment_status, free_preroll_segment_id, free_preroll_segment_error,
              accepted_paste_offer, sweed_customer_id,
              fraudulent, fraudulent_marked_at, fraudulent_marked_by,
              created_at
       from review_drawing_entries
       where submission_id = any($1::uuid[])`,
      [submissionIds],
    )
    for (const raw of drawingResult.rows) {
      const parsed = DrawingRowSchema.parse(raw)
      drawingBySubmission.set(parsed.submission_id, {
        id: parsed.id,
        acknowledged: parsed.acknowledged_at !== null,
        acknowledgedAt: parsed.acknowledged_at ? parsed.acknowledged_at.toISOString() : null,
        acknowledgedBy: parsed.acknowledged_by,
        drawingSegmentStatus: parsed.drawing_segment_status,
        drawingSegmentId: parsed.drawing_segment_id,
        drawingSegmentError: parsed.drawing_segment_error,
        freePrerollSegmentStatus: parsed.free_preroll_segment_status,
        freePrerollSegmentId: parsed.free_preroll_segment_id,
        freePrerollSegmentError: parsed.free_preroll_segment_error,
        acceptedPasteOffer: parsed.accepted_paste_offer,
        sweedCustomerId: parsed.sweed_customer_id,
        fraudulent: parsed.fraudulent,
        fraudulentMarkedAt: parsed.fraudulent_marked_at
          ? parsed.fraudulent_marked_at.toISOString()
          : null,
        fraudulentMarkedBy: parsed.fraudulent_marked_by,
        createdAt: parsed.created_at.toISOString(),
      })
    }
  }

  const items: CustomerReviewListItem[] = submissions.map((s) => ({
    submissionId: s.submission_id,
    dealerId: s.dealer_id,
    siteLabel: s.site_label,
    starRating: s.star_rating,
    reviewText: s.review_text,
    submissionKind: s.submission_kind,
    sourceIp: s.source_ip,
    userAgent: s.user_agent,
    referrer: s.referrer,
    fraudMarked: s.fraud_marked,
    fraudMarkedAt: s.fraud_marked_at ? s.fraud_marked_at.toISOString() : null,
    fraudMarkedBy: s.fraud_marked_by,
    llmVerdict: s.llm_verdict,
    degradedPass: s.degraded_pass,
    llmModelRef: s.llm_model_ref,
    llmAt: s.llm_at ? s.llm_at.toISOString() : null,
    reviewProviderUrl: s.review_provider_url,
    contacts: contactsBySubmission.get(s.submission_id) ?? [],
    drawingEntry: drawingBySubmission.get(s.submission_id) ?? null,
    createdAt: s.created_at.toISOString(),
  }))

  const totalResult = await db.query<{ count: string }>(
    `select count(*)::text as count from review_submissions`,
  )
  const totalCount = Number(totalResult.rows[0]?.count ?? items.length)

  return { items, totalCount }
}
