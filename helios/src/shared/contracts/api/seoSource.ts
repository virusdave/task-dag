import { z } from 'zod'

import { SeoPostRecordSchema } from './seoPost.js'

// API contracts for the SEO auto-blog SOURCE-INGESTION brick (P4).
//
// The Helios control plane records the source content / links Helios will
// later draft blog posts from (parent EPIC_PLAN §7.1 "source/topic intake").
// Per the operator-approved scope (issue #44, option (a)) this is schema +
// operator/API-driven ingest only: no automated fetchers. Ingest is
// fail-closed against an operator-managed approved-source allowlist.
//
// These items are raw drafting INPUTS, never public content — the IRONCLAD
// human-approval gate (canon §1) applies one step later to the posts a human
// authors/approves from them (seoPost.ts).
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

// Source taxonomy — mirrors SOURCE_KINDS in server/seo/sourceContent.ts and
// the seo_source_allowlist_kind_check DB constraint.
export const SeoSourceKindSchema = z.enum([
  'local_culture',
  'industry_news',
  'fb_news',
  'gsc_opportunity',
  'social_opportunity',
  'other',
])
export type SeoSourceKind = z.infer<typeof SeoSourceKindSchema>

// Intake lifecycle — mirrors SOURCE_ITEM_STATUSES + the
// seo_source_items_status_check DB constraint.
export const SeoSourceItemStatusSchema = z.enum([
  'new',
  'reviewed',
  'drafted',
  'dismissed',
])
export type SeoSourceItemStatus = z.infer<typeof SeoSourceItemStatusSchema>

export const SeoSourceItemIngestSourceSchema = z.enum(['api', 'manual'])
export type SeoSourceItemIngestSource = z.infer<typeof SeoSourceItemIngestSourceSchema>

// Lowercase-kebab slug, 3-64 chars. Mirrors SOURCE_KEY_RE +
// seo_source_allowlist_source_key_check.
const SourceKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, 'source_key must be a lowercase-kebab slug (3-64 chars).')

// ── allowlist ─────────────────────────────────────────────────────────

export const SeoSourceAllowlistRecordSchema = z.object({
  sourceKey: z.string().min(1),
  kind: SeoSourceKindSchema,
  displayName: z.string().min(1),
  homepageUrl: z.string().nullable(),
  enabled: z.boolean(),
  note: z.string().nullable(),
  createdByUserId: z.number().int().positive().nullable(),
  updatedByUserId: z.number().int().positive().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SeoSourceAllowlistRecord = z.infer<typeof SeoSourceAllowlistRecordSchema>

export const SeoSourceAllowlistListResponseSchema = z.object({
  sources: z.array(SeoSourceAllowlistRecordSchema),
})
export type SeoSourceAllowlistListResponse = z.infer<
  typeof SeoSourceAllowlistListResponseSchema
>

export const SeoSourceAllowlistDetailResponseSchema = z.object({
  source: SeoSourceAllowlistRecordSchema,
})
export type SeoSourceAllowlistDetailResponse = z.infer<
  typeof SeoSourceAllowlistDetailResponseSchema
>

// Upsert an approved source. `source_key` is the URL path param; the body
// carries the editable fields. Idempotent: PUT replaces the row's mutable
// fields and never resets `enabled` unless asked.
export const SeoSourceAllowlistUpsertBodySchema = z
  .object({
    kind: SeoSourceKindSchema,
    displayName: z.string().trim().min(1).max(200),
    homepageUrl: z.string().trim().url().max(2000).nullable().optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
export type SeoSourceAllowlistUpsertBody = z.infer<
  typeof SeoSourceAllowlistUpsertBodySchema
>

export const SeoSourceAllowlistSetEnabledBodySchema = z
  .object({ enabled: z.boolean() })
  .strict()
export type SeoSourceAllowlistSetEnabledBody = z.infer<
  typeof SeoSourceAllowlistSetEnabledBodySchema
>

// ── source items ──────────────────────────────────────────────────────

export const SeoSourceItemRecordSchema = z.object({
  sourceItemId: z.string().min(1),
  sourceKey: z.string().min(1),
  url: z.string().nullable(),
  title: z.string().min(1),
  publishedAt: z.string().nullable(),
  summary: z.string().nullable(),
  topicTags: z.array(z.string()),
  riskFlags: z.array(z.string()),
  dedupHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: SeoSourceItemStatusSchema,
  ingestSource: SeoSourceItemIngestSourceSchema,
  ingestMeta: z.unknown().nullable(),
  createdByUserId: z.number().int().positive().nullable(),
  updatedByUserId: z.number().int().positive().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SeoSourceItemRecord = z.infer<typeof SeoSourceItemRecordSchema>

export const SeoSourceItemListResponseSchema = z.object({
  items: z.array(SeoSourceItemRecordSchema),
})
export type SeoSourceItemListResponse = z.infer<typeof SeoSourceItemListResponseSchema>

export const SeoSourceItemDetailResponseSchema = z.object({
  item: SeoSourceItemRecordSchema,
})
export type SeoSourceItemDetailResponse = z.infer<
  typeof SeoSourceItemDetailResponseSchema
>

// Optional list filters.
export const SeoSourceItemListQuerySchema = z
  .object({
    status: SeoSourceItemStatusSchema.optional(),
    sourceKey: SourceKeySchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict()
export type SeoSourceItemListQuery = z.infer<typeof SeoSourceItemListQuerySchema>

// Ingest one source item. `source_key` must be an enabled allowlist entry
// (the server fail-closes otherwise). Re-ingesting the same link dedups to
// the existing row (HTTP 200) instead of creating a duplicate (HTTP 201).
export const SeoSourceItemIngestBodySchema = z
  .object({
    sourceKey: SourceKeySchema,
    title: z.string().trim().min(1).max(500),
    url: z.string().trim().url().max(2000).nullable().optional(),
    publishedAt: z.string().datetime().nullable().optional(),
    summary: z.string().trim().max(8000).nullable().optional(),
    topicTags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
    riskFlags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
    ingestSource: SeoSourceItemIngestSourceSchema.optional(),
    ingestMeta: z.unknown().optional(),
  })
  .strict()
export type SeoSourceItemIngestBody = z.infer<typeof SeoSourceItemIngestBodySchema>

// Ingest response carries whether the item was newly recorded or deduped to
// an existing row, so the caller/UI can tell the two apart.
export const SeoSourceItemIngestResponseSchema = z.object({
  item: SeoSourceItemRecordSchema,
  deduped: z.boolean(),
})
export type SeoSourceItemIngestResponse = z.infer<
  typeof SeoSourceItemIngestResponseSchema
>

export const SeoSourceItemSetStatusBodySchema = z
  .object({ status: SeoSourceItemStatusSchema })
  .strict()
export type SeoSourceItemSetStatusBody = z.infer<
  typeof SeoSourceItemSetStatusBodySchema
>

export const SeoSourceItemRouteParamsSchema = z
  .object({ sourceItemId: z.string().min(1) })
  .strict()
export type SeoSourceItemRouteParams = z.infer<typeof SeoSourceItemRouteParamsSchema>

export const SeoSourceAllowlistRouteParamsSchema = z
  .object({ sourceKey: SourceKeySchema })
  .strict()
export type SeoSourceAllowlistRouteParams = z.infer<
  typeof SeoSourceAllowlistRouteParamsSchema
>

// Generating a blog-post DRAFT from a source item: Bedrock produces a
// draft-only proposal (never auto-approved/published — canon §1), it is
// saved as a `draft` post (source='generated', provenance in
// generation_meta), and the source item transitions to `drafted`. The
// response returns both the new draft and the updated source item.
export const SeoSourceItemGenerateDraftResponseSchema = z.object({
  post: SeoPostRecordSchema,
  sourceItem: SeoSourceItemRecordSchema,
})
export type SeoSourceItemGenerateDraftResponse = z.infer<
  typeof SeoSourceItemGenerateDraftResponseSchema
>
