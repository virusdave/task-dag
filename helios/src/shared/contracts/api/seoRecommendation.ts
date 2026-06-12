import { z } from 'zod'

// API contracts for the SEO recommendation engine (P5 — the GA4/GSC
// feedback loop). The engine reads imported Search Console metrics and
// proposes DRAFT recommendations; an operator accepts (→ spawns a draft
// that still passes the ironclad approve→bundle gate) or dismisses them.
//
// child FreshlyBakedNYC/automation#44 (P5) · Satisfies: virusdave/top-level#15

export const SeoRecTypeSchema = z.enum(['faq_gap', 'low_ctr_title'])
export type SeoRecType = z.infer<typeof SeoRecTypeSchema>

export const SeoRecStatusSchema = z.enum(['open', 'accepted', 'dismissed'])
export type SeoRecStatus = z.infer<typeof SeoRecStatusSchema>

export const SeoRecLinkedKindSchema = z.enum(['faq_set', 'post'])
export type SeoRecLinkedKind = z.infer<typeof SeoRecLinkedKindSchema>

export const SeoRecommendationRecordSchema = z.object({
  recommendationId: z.string().min(1),
  recType: SeoRecTypeSchema,
  site: z.string().min(1),
  targetQuery: z.string().nullable(),
  targetPageUrl: z.string().nullable(),
  title: z.string(),
  rationale: z.unknown(),
  priority: z.number().int(),
  status: SeoRecStatusSchema,
  linkedContentKind: SeoRecLinkedKindSchema.nullable(),
  linkedContentId: z.string().nullable(),
  decidedByUserId: z.number().int().positive().nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  firstSeenAt: z.string(),
  updatedAt: z.string(),
})
export type SeoRecommendationRecord = z.infer<typeof SeoRecommendationRecordSchema>

export const SeoRecommendationListResponseSchema = z.object({
  recommendations: z.array(SeoRecommendationRecordSchema),
})
export type SeoRecommendationListResponse = z.infer<typeof SeoRecommendationListResponseSchema>

export const SeoRecommendationDetailResponseSchema = z.object({
  recommendation: SeoRecommendationRecordSchema,
})
export type SeoRecommendationDetailResponse = z.infer<
  typeof SeoRecommendationDetailResponseSchema
>

// Run the generator over a site's imported metrics for a date window and
// upsert OPEN recommendations. Window dates are YYYY-MM-DD; endDate is
// exclusive and should exclude the freshest ~3 Google days.
export const SeoRecommendationGenerateBodySchema = z
  .object({
    site: z.string().trim().min(1).max(128),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // gap/low-ctr thresholds (sensible defaults applied server-side)
    minImpressions: z.number().int().positive().optional(),
    maxCtr: z.number().min(0).max(1).optional(),
    maxPosition: z.number().positive().optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict()
export type SeoRecommendationGenerateBody = z.infer<typeof SeoRecommendationGenerateBodySchema>

export const SeoRecommendationGenerateResponseSchema = z.object({
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
})
export type SeoRecommendationGenerateResponse = z.infer<
  typeof SeoRecommendationGenerateResponseSchema
>

// Accept a recommendation: spawns a draft of the suggested kind and links
// it. The created draft still passes the existing human approve→bundle gate.
export const SeoRecommendationAcceptBodySchema = z
  .object({
    note: z.string().max(2000).optional(),
  })
  .strict()
export type SeoRecommendationAcceptBody = z.infer<typeof SeoRecommendationAcceptBodySchema>

// Accepting returns the decided recommendation AND a link to the new draft
// so the UI can send the operator straight there (canon §3 user-efficiency).
export const SeoRecommendationAcceptResponseSchema = z.object({
  recommendation: SeoRecommendationRecordSchema,
  linkedContentKind: SeoRecLinkedKindSchema,
  linkedContentId: z.string().min(1),
})
export type SeoRecommendationAcceptResponse = z.infer<
  typeof SeoRecommendationAcceptResponseSchema
>

export const SeoRecommendationDismissBodySchema = z
  .object({
    note: z.string().max(2000).optional(),
  })
  .strict()
export type SeoRecommendationDismissBody = z.infer<typeof SeoRecommendationDismissBodySchema>

export const SeoRecommendationRouteParamsSchema = z.object({
  recommendationId: z.string().min(1),
})
export type SeoRecommendationRouteParams = z.infer<typeof SeoRecommendationRouteParamsSchema>
