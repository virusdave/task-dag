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
       source_ip, user_agent, referrer, raw_payload
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
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
): Promise<InsertDrawingEntryResult | null> {
  // The unique index review_drawing_entries_one_per_submission means
  // a second drawing-entry call for the same submission is a no-op
  // (idempotent from the customer's perspective if they double-tap).
  const result = await db.query<{ id: string; created_at: Date }>(
    `insert into review_drawing_entries (submission_id, dealer_id)
     values ($1, $2)
     on conflict (submission_id) do nothing
     returning id, created_at`,
    [submissionId, dealerId],
  )
  if (result.rows.length === 0) {
    // Already existed — fetch and return that row instead of erroring.
    const existing = await db.query<{ id: string; created_at: Date }>(
      `select id, created_at from review_drawing_entries where submission_id = $1`,
      [submissionId],
    )
    if (existing.rows.length === 0) return null
    const row = existing.rows[0]
    return {
      drawingEntryId: row.id,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    }
  }
  const row = result.rows[0]
  return {
    drawingEntryId: row.id,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  }
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
  drawing_segment_status: z.enum(['skipped', 'failed', 'added']).nullable(),
  free_preroll_segment_status: z.enum(['skipped', 'failed', 'added']).nullable(),
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
              drawing_segment_status, free_preroll_segment_status,
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
        freePrerollSegmentStatus: parsed.free_preroll_segment_status,
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
