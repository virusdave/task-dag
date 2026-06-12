import { z } from 'zod'

// API contracts for the auto-blog control plane (P4).
//
// The Helios control plane lets an operator author / generate / review /
// APPROVE blog posts ("What's new") that later feed the signed SEO bundle
// (WhatsNewFeed + BlogPost widgets). Approval is the IRONCLAD human gate
// (canon §1): nothing reaches a published bundle without an approver
// signing off on the EXACT content fingerprint.
//
// The direct analog of api/seoFaq.ts (P3); only the body carries a
// raw/sanitized variant pair, while title/meta/excerpt/tags/slug are
// shared (rendered on both hosts) and so must be sanitized-safe.
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

export const SeoPostStatusSchema = z.enum(['draft', 'needs_review', 'approved', 'rejected'])
export type SeoPostStatus = z.infer<typeof SeoPostStatusSchema>

export const SeoPostSourceSchema = z.enum(['manual', 'generated'])
export type SeoPostSource = z.infer<typeof SeoPostSourceSchema>

// A control-plane post row as returned to the client.
export const SeoPostRecordSchema = z.object({
  postId: z.string().min(1),
  scope: z.string().min(1),
  slug: z.string(),
  title: z.string(),
  metaDescription: z.string(),
  excerpt: z.string(),
  author: z.string(),
  tags: z.array(z.string()),
  bodyRaw: z.string(),
  bodySanitized: z.string(),
  noindex: z.boolean(),
  // Derived (scope+slug) canonical URL — never stored, always recomputed.
  canonicalUrl: z.string(),
  publishedAt: z.string(),
  // Control-plane release time (P4 follow-on). Excluded from the content
  // fingerprint, so (re)scheduling never invalidates an approval. null =
  // export as soon as approved.
  scheduledPublishAt: z.string().nullable(),
  status: SeoPostStatusSchema,
  source: SeoPostSourceSchema,
  // Current content fingerprint — the client echoes this back on approve
  // (expectedContentSha256) so an approval can never cover content that
  // changed after the page loaded.
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  approvalId: z.string().nullable(),
  reviewer: z.string().nullable(),
  approvedByUserId: z.number().int().positive().nullable(),
  approvedAt: z.string().nullable(),
  approvalNote: z.string().nullable(),
  generationMeta: z.unknown().nullable(),
  createdByUserId: z.number().int().positive().nullable(),
  updatedByUserId: z.number().int().positive().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SeoPostRecord = z.infer<typeof SeoPostRecordSchema>

// A lean list row — deliberately EXCLUDES the (potentially large) body
// variants and other detail-only fields so the list endpoint's payload
// stays flat as the table grows. Detail/editing loads the full record via
// GET /api/seo/posts/:postId.
export const SeoPostSummarySchema = z.object({
  postId: z.string().min(1),
  scope: z.string().min(1),
  slug: z.string(),
  title: z.string(),
  status: SeoPostStatusSchema,
  source: SeoPostSourceSchema,
  noindex: z.boolean(),
  publishedAt: z.string(),
  updatedAt: z.string(),
})
export type SeoPostSummary = z.infer<typeof SeoPostSummarySchema>

// List query params: newest-first page window. Coerced from the query
// string; capped so a caller can't request an unbounded page.
export const SeoPostListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type SeoPostListQuery = z.infer<typeof SeoPostListQuerySchema>

export const SeoPostListResponseSchema = z.object({
  posts: z.array(SeoPostSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
})
export type SeoPostListResponse = z.infer<typeof SeoPostListResponseSchema>

export const SeoPostDetailResponseSchema = z.object({
  post: SeoPostRecordSchema,
})
export type SeoPostDetailResponse = z.infer<typeof SeoPostDetailResponseSchema>

// Scope is a concrete site id or the reserved global `all` token; the
// compiler's consistency layer rejects a physical `all` site.
const ScopeFieldSchema = z.string().trim().min(1).max(128)
const TagsFieldSchema = z.array(z.string().trim().min(1).max(64)).max(20)

// The editable content fields shared by create + update. A brand-new draft
// may be mostly empty (operator fills it in); the approve path enforces
// completeness + compliance.
const PostContentFieldsSchema = {
  slug: z.string().trim().max(200).default(''),
  title: z.string().trim().max(300).default(''),
  metaDescription: z.string().trim().max(500).default(''),
  excerpt: z.string().trim().max(1000).default(''),
  author: z.string().trim().max(200).default('Freshly Baked Editorial'),
  tags: TagsFieldSchema.default([]),
  bodyRaw: z.string().max(50000).default(''),
  bodySanitized: z.string().max(50000).default(''),
  noindex: z.boolean().default(false),
}

export const SeoPostCreateBodySchema = z
  .object({
    scope: ScopeFieldSchema,
    ...PostContentFieldsSchema,
  })
  .strict()
export type SeoPostCreateBody = z.infer<typeof SeoPostCreateBodySchema>

// Edits replace the content wholesale. Any successful edit resets the post
// to `draft` and clears its approval (server-enforced) so an approval can
// never silently cover edited content.
export const SeoPostUpdateBodySchema = z
  .object({
    scope: ScopeFieldSchema,
    slug: z.string().trim().max(200),
    title: z.string().trim().max(300),
    metaDescription: z.string().trim().max(500),
    excerpt: z.string().trim().max(1000),
    author: z.string().trim().max(200),
    tags: TagsFieldSchema,
    bodyRaw: z.string().max(50000),
    bodySanitized: z.string().max(50000),
    noindex: z.boolean(),
  })
  .strict()
export type SeoPostUpdateBody = z.infer<typeof SeoPostUpdateBodySchema>

export const SeoPostSubmitBodySchema = z.object({}).strict()

export const SeoPostApproveBodySchema = z
  .object({
    // The fingerprint the reviewer actually saw. A mismatch with the
    // current row => 409 (stale review).
    expectedContentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
export type SeoPostApproveBody = z.infer<typeof SeoPostApproveBodySchema>

export const SeoPostRejectBodySchema = z
  .object({
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
export type SeoPostRejectBody = z.infer<typeof SeoPostRejectBodySchema>

// Bedrock generation produces a DRAFT PROPOSAL only — never auto-approved,
// never auto-published. The operator reviews/edits, then approves.
export const SeoPostGenerateBodySchema = z
  .object({
    topic: z.string().trim().min(3).max(2000),
  })
  .strict()
export type SeoPostGenerateBody = z.infer<typeof SeoPostGenerateBodySchema>

export const SeoPostRouteParamsSchema = z.object({
  postId: z.string().min(1),
})
export type SeoPostRouteParams = z.infer<typeof SeoPostRouteParamsSchema>

// Set or clear the control-plane release time. Does NOT change content,
// status, or the approval binding (scheduled_publish_at is excluded from
// the content fingerprint), so rescheduling never invalidates an approval.
export const SeoPostScheduleBodySchema = z
  .object({
    scheduledPublishAt: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'not a valid date' })
      .nullable(),
  })
  .strict()
export type SeoPostScheduleBody = z.infer<typeof SeoPostScheduleBodySchema>

// Per-platform social/marketing export (export-only — nothing auto-posts).
export const SeoSocialExportEntrySchema = z.object({
  platform: z.enum(['instagram', 'x', 'linkedin', 'email']),
  url: z.string(),
  caption: z.string(),
})
export const SeoSocialExportResponseSchema = z.object({
  canonicalUrl: z.string(),
  entries: z.array(SeoSocialExportEntrySchema),
})
export type SeoSocialExportResponse = z.infer<typeof SeoSocialExportResponseSchema>
