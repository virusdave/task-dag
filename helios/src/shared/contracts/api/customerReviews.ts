import { z } from 'zod'

// =====================================================================
// Customer-Sentiment Capture (issue #13, A1 phase)
//
// Contracts for the customer-review capture surface.  Splits into two
// audiences:
//
//   1. Public, unauthenticated POST endpoints called by the
//      mostly-static-sites landing page on behalf of the customer:
//        - POST /v1/reviews/submit
//        - POST /v1/reviews/<submission_id>/drawing-entry
//
//   2. Internal /api/customer-reviews/* surface called by the Helios
//      SPA so operators can see what came in.  A1 ships read-only;
//      A2+ add action mutations.
//
// A2 (LLM gate), A3 (email), A4 (Sweed), A5 (drawing export +
// acknowledge) will extend these schemas with additional fields and
// endpoints — keep new fields optional/nullable so the public
// landing page client doesn't have to ship in lockstep.
// =====================================================================

// --------------------------- public submit ---------------------------

export const CustomerReviewContactInfoInputSchema = z.object({
  kind: z.enum(['phone', 'email', 'name', 'other']),
  value: z.string().trim().min(1).max(500),
})
export type CustomerReviewContactInfoInput = z.infer<typeof CustomerReviewContactInfoInputSchema>

export const CustomerReviewSubmitRequestSchema = z.object({
  dealerId: z.number().int().positive(),
  starRating: z.number().int().min(1).max(5),
  reviewText: z.string().max(20_000).optional().nullable(),
  submissionKind: z.enum(['form', 'drawing', 'other']).default('form'),
  contacts: z.array(CustomerReviewContactInfoInputSchema).max(10).optional().default([]),
  // Free-form passthrough for any fields the landing page wants to
  // capture that A1 doesn't yet model first-class (e.g. UTM tags,
  // device hints, A/B bucket).  Preserved verbatim in raw_payload.
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type CustomerReviewSubmitRequest = z.infer<typeof CustomerReviewSubmitRequestSchema>

export const CustomerReviewSubmitResponseSchema = z.object({
  submissionId: z.string().uuid(),
  acceptedAt: z.string(),
  // Convenience for the landing page so it can route the customer to
  // the right next step. Driven by the A2 LLM gate (and its degraded-
  // pass fallback on llm_verdict='error'): strong-with-text / degraded
  // → show_drawing_form + offerPasteText=true; strong-no-text / error
  // (degraded_pass=false) → show_drawing_form + offerPasteText=false;
  // lukewarm / negative → thank_customer.
  nextStep: z
    .enum(['show_drawing_form', 'thank_customer', 'redirect_to_provider'])
    .optional()
    .nullable(),
  // The final paste-text URL the customer was offered, or null when
  // not offered. Set iff offerPasteText is true.
  providerReviewUrl: z.string().url().optional().nullable(),
  // Whether the landing page should surface the "would you like to
  // copy-paste your review on Google?" upsell. A2 added; older
  // clients that ignore the field still work.
  offerPasteText: z.boolean().optional().default(false),
})
export type CustomerReviewSubmitResponse = z.infer<typeof CustomerReviewSubmitResponseSchema>

export const CustomerReviewDrawingEntryRequestSchema = z.object({
  // The landing page may collect additional or confirming contact info
  // at the drawing-form step; we append, never replace.
  contacts: z.array(CustomerReviewContactInfoInputSchema).max(10).optional().default([]),
  // Did the customer accept the "paste your review on Google" offer?
  // A4 uses this to decide whether to add to the free-preroll segment
  // in addition to the drawing segment.  Optional in A1 since the
  // landing page may not collect it yet.
  acceptedPasteOffer: z.boolean().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type CustomerReviewDrawingEntryRequest = z.infer<typeof CustomerReviewDrawingEntryRequestSchema>

export const CustomerReviewDrawingEntryResponseSchema = z.object({
  drawingEntryId: z.string().uuid(),
  submissionId: z.string().uuid(),
  acceptedAt: z.string(),
})
export type CustomerReviewDrawingEntryResponse = z.infer<typeof CustomerReviewDrawingEntryResponseSchema>

// --------------------------- internal list ---------------------------

export const CustomerReviewContactInfoRowSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['phone', 'email', 'name', 'other']),
  value: z.string(),
  createdAt: z.string(),
})
export type CustomerReviewContactInfoRow = z.infer<typeof CustomerReviewContactInfoRowSchema>

export const CustomerReviewDrawingEntryRowSchema = z.object({
  id: z.string().uuid(),
  acknowledged: z.boolean(),
  acknowledgedAt: z.string().nullable(),
  acknowledgedBy: z.string().nullable(),
  drawingSegmentStatus: z.enum(['skipped', 'failed', 'added']).nullable(),
  freePrerollSegmentStatus: z.enum(['skipped', 'failed', 'added']).nullable(),
  createdAt: z.string(),
})
export type CustomerReviewDrawingEntryRow = z.infer<typeof CustomerReviewDrawingEntryRowSchema>

export const CustomerReviewLlmVerdictSchema = z.enum([
  'strong-with-text',
  'strong-no-text',
  'lukewarm',
  'negative',
  'error',
])
export type CustomerReviewLlmVerdict = z.infer<typeof CustomerReviewLlmVerdictSchema>

export const CustomerReviewListItemSchema = z.object({
  submissionId: z.string().uuid(),
  dealerId: z.number().int(),
  siteLabel: z.string(),
  starRating: z.number().int().nullable(),
  reviewText: z.string().nullable(),
  submissionKind: z.enum(['form', 'drawing', 'other']),
  sourceIp: z.string().nullable(),
  userAgent: z.string().nullable(),
  referrer: z.string().nullable(),
  fraudMarked: z.boolean(),
  fraudMarkedAt: z.string().nullable(),
  fraudMarkedBy: z.string().nullable(),
  // A2 LLM-gate columns. Null when the gate hasn't run (no text,
  // gate disabled per-site, or row predates the A2 schema).
  llmVerdict: CustomerReviewLlmVerdictSchema.nullable(),
  degradedPass: z.boolean().nullable(),
  llmModelRef: z.string().nullable(),
  llmAt: z.string().nullable(),
  reviewProviderUrl: z.string().nullable(),
  contacts: z.array(CustomerReviewContactInfoRowSchema),
  drawingEntry: CustomerReviewDrawingEntryRowSchema.nullable(),
  createdAt: z.string(),
})
export type CustomerReviewListItem = z.infer<typeof CustomerReviewListItemSchema>

export const CustomerReviewListResponseSchema = z.object({
  items: z.array(CustomerReviewListItemSchema),
  totalCount: z.number().int().nonnegative(),
  // Operator-relevant feature-flag visibility so the SPA can render a
  // banner explaining why submissions might be 404'ing in production.
  captureEnabled: z.boolean(),
})
export type CustomerReviewListResponse = z.infer<typeof CustomerReviewListResponseSchema>

// --------------------------- error envelope --------------------------

// Public errors deliberately do NOT echo the customer's payload — we
// only surface the operator-actionable reason.  Internal errors get
// the standard ZodError->400 envelope from buildServer's setErrorHandler.
export const CustomerReviewPublicErrorSchema = z.object({
  error: z.string(),
  code: z
    .enum([
      'capture_disabled',
      'unknown_site',
      'missing_review_text_for_drawing',
      'submission_not_found',
    ])
    .optional(),
})
export type CustomerReviewPublicError = z.infer<typeof CustomerReviewPublicErrorSchema>
