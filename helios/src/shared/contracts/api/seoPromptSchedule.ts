import { z } from 'zod'

// API contracts for the auto-blog PROMPT-SCHEDULE + TOPIC-MIX config (P4 —
// parent EPIC_PLAN §7.2).
//
// Operator-tunable config the (later) Bedrock draft-generation loop will
// consult: cadence (posts/week), the weighted topic mix, the generation
// mode, and reusable prompt templates. This is config — NOT approval-gated
// public content — so there is no content fingerprint here. Standing up the
// actual scheduled generator is a later brick; this slice is config + CRUD.
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

// Keep these literals in lockstep with helios/src/server/seo/promptSchedule.ts.
export const SeoTopicCategorySchema = z.enum([
  'local_culture',
  'industry_news',
  'fb_news',
  'nyc_events',
  'gsc_opportunities',
  'social_opportunities',
])
export type SeoTopicCategory = z.infer<typeof SeoTopicCategorySchema>

export const SeoGenerationModeSchema = z.enum(['raw', 'sanitized', 'dual'])
export type SeoGenerationMode = z.infer<typeof SeoGenerationModeSchema>

export const SeoTopicMixEntrySchema = z.object({
  category: SeoTopicCategorySchema,
  weight: z.number().int().min(0).max(100),
})
export type SeoTopicMixEntry = z.infer<typeof SeoTopicMixEntrySchema>

// Prompt templates: every named slot is optional free text.
export const SeoPromptTemplatesSchema = z
  .object({
    article_brief: z.string().max(8000).optional(),
    faq_addendum: z.string().max(8000).optional(),
    title_meta: z.string().max(8000).optional(),
    social_caption: z.string().max(8000).optional(),
    image_prompt: z.string().max(8000).optional(),
  })
  .strict()
export type SeoPromptTemplates = z.infer<typeof SeoPromptTemplatesSchema>

export const SeoPromptScheduleRecordSchema = z.object({
  scheduleKey: z.string().min(1),
  scope: z.string().min(1),
  label: z.string(),
  enabled: z.boolean(),
  postsPerWeek: z.number().int().positive(),
  mode: SeoGenerationModeSchema,
  topicMix: z.array(SeoTopicMixEntrySchema),
  promptTemplates: SeoPromptTemplatesSchema,
  notes: z.string(),
  createdByUserId: z.number().int().positive().nullable(),
  updatedByUserId: z.number().int().positive().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SeoPromptScheduleRecord = z.infer<typeof SeoPromptScheduleRecordSchema>

export const SeoPromptScheduleListResponseSchema = z.object({
  schedules: z.array(SeoPromptScheduleRecordSchema),
})
export type SeoPromptScheduleListResponse = z.infer<typeof SeoPromptScheduleListResponseSchema>

export const SeoPromptScheduleDetailResponseSchema = z.object({
  schedule: SeoPromptScheduleRecordSchema,
})
export type SeoPromptScheduleDetailResponse = z.infer<
  typeof SeoPromptScheduleDetailResponseSchema
>

// Lower-kebab key (matches the SQL CHECK + promptSchedule.SCHEDULE_KEY_RE).
const ScheduleKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be lowercase kebab-case')

// Create or update a schedule. Keyed on scheduleKey. The server additionally
// runs validatePromptScheduleConfig (topic-mix weights sum to 100, FB-news
// cap, cadence range) and 422s on any problem.
export const SeoPromptScheduleUpsertBodySchema = z
  .object({
    scheduleKey: ScheduleKeySchema,
    scope: z.string().trim().min(1).max(128).default('all'),
    label: z.string().trim().max(300).default(''),
    enabled: z.boolean().default(true),
    postsPerWeek: z.number().int().min(1).max(14).default(1),
    mode: SeoGenerationModeSchema.default('dual'),
    topicMix: z.array(SeoTopicMixEntrySchema).max(20).default([]),
    promptTemplates: SeoPromptTemplatesSchema.default({}),
    notes: z.string().trim().max(2000).default(''),
  })
  .strict()
export type SeoPromptScheduleUpsertBody = z.infer<typeof SeoPromptScheduleUpsertBodySchema>

export const SeoPromptScheduleRouteParamsSchema = z.object({
  scheduleKey: z.string().min(1),
})
export type SeoPromptScheduleRouteParams = z.infer<typeof SeoPromptScheduleRouteParamsSchema>
