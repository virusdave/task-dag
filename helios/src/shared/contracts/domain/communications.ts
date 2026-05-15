import { z } from 'zod'

/**
 * Policy-limited Google Ads asset replacement review.
 *
 * Mirrors the static packet contract validated by
 * `ads/google/serve_asset_policy_limited_replacement_review.py`.
 *
 * The Helios route only persists reviewer decisions and edited replacement
 * text. It MUST NOT mutate Google Ads from review submission alone. Any apply
 * phase has to run a narrow post-review Google Ads resolver pass first
 * (validate-only, then live apply, then narrow readback). Only items with
 * `decision == 'accepted'` flow to the resolver/apply step. `rejected`,
 * `hold`, and `unreviewed` rows must stay out.
 */

export const POLICY_REPLACEMENT_DECISIONS = ['unreviewed', 'accepted', 'rejected', 'hold'] as const
export const PolicyReplacementDecisionSchema = z.enum(POLICY_REPLACEMENT_DECISIONS)
export type PolicyReplacementDecision = z.infer<typeof PolicyReplacementDecisionSchema>

export const POLICY_REPLACEMENT_CATEGORIES = ['location', 'price', 'pickup', 'payment'] as const
export const PolicyReplacementCategorySchema = z.enum(POLICY_REPLACEMENT_CATEGORIES)
export type PolicyReplacementCategory = z.infer<typeof PolicyReplacementCategorySchema>

export const POLICY_REPLACEMENT_ITEM_KIND_PREFIXES = [
  'visual',
  'headline',
  'long-headline',
  'description',
  'template-family',
  'text-map',
] as const
export type PolicyReplacementItemKindPrefix = (typeof POLICY_REPLACEMENT_ITEM_KIND_PREFIXES)[number]

const ITEM_ID_PATTERN = /^(visual|headline|long-headline|description|template-family|text-map)-\d+$/
export const PolicyReplacementItemIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(ITEM_ID_PATTERN, 'Policy replacement item ids look like "visual-1", "text-map-12", etc.')
export type PolicyReplacementItemId = z.infer<typeof PolicyReplacementItemIdSchema>

export const POLICY_REPLACEMENT_FIELD_KEYS = ['text', 'note', 'replacementCategory', 'sourceId'] as const
export const PolicyReplacementFieldKeySchema = z.enum(POLICY_REPLACEMENT_FIELD_KEYS)
export type PolicyReplacementFieldKey = z.infer<typeof PolicyReplacementFieldKeySchema>

export const POLICY_REPLACEMENT_FIELD_MAX_LEN = 1000

const PolicyReplacementFieldValueSchema = z.string().max(POLICY_REPLACEMENT_FIELD_MAX_LEN)

export const PolicyReplacementItemFieldsSchema = z
  .object({
    text: PolicyReplacementFieldValueSchema.optional(),
    note: PolicyReplacementFieldValueSchema.optional(),
    replacementCategory: z
      .union([PolicyReplacementCategorySchema, z.literal('')])
      .optional(),
    sourceId: PolicyReplacementFieldValueSchema.optional(),
  })
  .strict()
export type PolicyReplacementItemFields = z.infer<typeof PolicyReplacementItemFieldsSchema>

export const PolicyReplacementItemStateSchema = z.object({
  decision: PolicyReplacementDecisionSchema,
  fields: PolicyReplacementItemFieldsSchema,
})
export type PolicyReplacementItemState = z.infer<typeof PolicyReplacementItemStateSchema>

export const PolicyReplacementDraftStateSchema = z.object({
  version: z.literal(1),
  packetId: z.string().trim().min(1),
  savedAt: z.iso.datetime().nullable(),
  submittedAt: z.iso.datetime().nullable(),
  items: z.record(PolicyReplacementItemIdSchema, PolicyReplacementItemStateSchema),
})
export type PolicyReplacementDraftState = z.infer<typeof PolicyReplacementDraftStateSchema>

/**
 * Loose packet shape covering only the parts the Helios route reads to
 * derive valid item ids and reviewer surface data. The packet JSON itself
 * carries many more analytical fields the route does not need to validate.
 */
export const PolicyReplacementPacketSchema = z.object({
  packetId: z.string().trim().min(1),
  generatedAt: z.string().min(1).optional(),
  visualReplacementPlans: z.array(z.unknown()).default([]),
  llmCopy: z
    .object({
      headlines: z.array(z.unknown()).default([]),
      longHeadlines: z.array(z.unknown()).default([]),
      descriptions: z.array(z.unknown()).default([]),
      templateFamilies: z.array(z.unknown()).default([]),
    })
    .partial()
    .passthrough()
    .default({}),
  textReplacementMappings: z
    .array(
      z.object({
        mappingId: z.string().trim().min(1),
      }).passthrough(),
    )
    .default([]),
  replacementCategoryLabels: z.record(z.string(), z.string()).optional(),
  controls: z.record(z.string(), z.unknown()).optional(),
}).passthrough()
export type PolicyReplacementPacket = z.infer<typeof PolicyReplacementPacketSchema>

/**
 * Reviewer-facing detail payload returned by `GET /detail`. Mirrors the
 * rich data the standalone HTML packet renders per item so the Helios
 * reviewer page can show the same content without falling back to the old
 * static packet.
 *
 * All shapes are passthrough/loose since the Python packet generator
 * carries forward many analytical fields beyond what Helios renders today.
 */
const VisualReplacementPlanDetailSchema = z
  .object({
    assetType: z.string().optional(),
    currentAsset: z.string().optional(),
    associationCount: z.number().optional(),
    impressions: z.number().optional(),
    statusReasons: z.record(z.string(), z.number()).optional(),
    levels: z.record(z.string(), z.number()).optional(),
    replacementAssetNamePattern: z.string().optional(),
    plannedReplacementFieldType: z.string().optional(),
    applyInstruction: z.string().optional(),
  })
  .passthrough()
export type VisualReplacementPlanDetail = z.infer<typeof VisualReplacementPlanDetailSchema>

const CopyEntryDetailSchema = z
  .object({
    text: z.string().optional(),
    use: z.string().optional(),
    whySafer: z.string().optional(),
    source: z.string().optional(),
  })
  .passthrough()
export type CopyEntryDetail = z.infer<typeof CopyEntryDetailSchema>

const TemplateFamilyDetailSchema = z
  .object({
    fieldType: z.string().optional(),
    template: z.string().optional(),
    use: z.string().optional(),
    whySafer: z.string().optional(),
    source: z.string().optional(),
  })
  .passthrough()
export type TemplateFamilyDetail = z.infer<typeof TemplateFamilyDetailSchema>

const TextReplacementOptionDetailSchema = z
  .object({
    category: PolicyReplacementCategorySchema,
    label: z.string(),
    sourceId: z.string(),
  })
  .passthrough()
export type TextReplacementOptionDetail = z.infer<typeof TextReplacementOptionDetailSchema>

const TextReplacementMappingDetailSchema = z
  .object({
    mappingId: z.string(),
    assetType: z.string().optional(),
    currentText: z.string().optional(),
    associationCount: z.number().optional(),
    impressions: z.number().optional(),
    statusReasons: z.record(z.string(), z.number()).optional(),
    levels: z.record(z.string(), z.number()).optional(),
    proposedReplacement: z.string().optional(),
    replacementSource: z.string().optional(),
    whySafer: z.string().optional(),
    replacementOptions: z.array(TextReplacementOptionDetailSchema).default([]),
    defaultReplacementCategory: z
      .union([PolicyReplacementCategorySchema, z.literal('')])
      .optional(),
  })
  .passthrough()
export type TextReplacementMappingDetail = z.infer<typeof TextReplacementMappingDetailSchema>

const AnchorExampleDetailSchema = z
  .object({
    assetType: z.string().optional(),
    text: z.string().optional(),
    level: z.string().optional(),
    impressions: z.number().optional(),
  })
  .passthrough()
export type AnchorExampleDetail = z.infer<typeof AnchorExampleDetailSchema>

export const PolicyReplacementPacketDetailSchema = z.object({
  packetId: z.string().trim().min(1),
  generatedAt: z.string().nullable(),
  summary: z
    .object({
      reportRows: z.number().optional(),
      limitedAssociations: z.number().optional(),
      limitedTextAssociations: z.number().optional(),
      uniqueLimitedTexts: z.number().optional(),
      limitedVisualAssociations: z.number().optional(),
      uniqueLimitedVisualAssets: z.number().optional(),
      visualAssociationsByType: z.record(z.string(), z.number()).optional(),
      limitedTextAssociationsByType: z.record(z.string(), z.number()).optional(),
      googleAdsQuotaUsedForPlanning: z.number().optional(),
      textReplacementMappings: z.number().optional(),
    })
    .passthrough()
    .nullable(),
  applyPlan: z.array(z.string()).default([]),
  llmSafePatterns: z.array(z.string()).default([]),
  llmRiskPatterns: z.array(z.string()).default([]),
  visualReplacementPlans: z.array(VisualReplacementPlanDetailSchema).default([]),
  headlines: z.array(CopyEntryDetailSchema).default([]),
  longHeadlines: z.array(CopyEntryDetailSchema).default([]),
  descriptions: z.array(CopyEntryDetailSchema).default([]),
  templateFamilies: z.array(TemplateFamilyDetailSchema).default([]),
  textReplacementMappings: z.array(TextReplacementMappingDetailSchema).default([]),
  replacementCategoryLabels: z.record(z.string(), z.string()).default({}),
  anchorExamples: z
    .object({
      eligible: z.array(AnchorExampleDetailSchema).default([]),
      limited: z.array(AnchorExampleDetailSchema).default([]),
    })
    .default({ eligible: [], limited: [] }),
})
export type PolicyReplacementPacketDetail = z.infer<typeof PolicyReplacementPacketDetailSchema>

/**
 * Compute the canonical set of item ids reachable from a loaded packet.
 * Mirrors `allowed_item_ids` in
 * `ads/google/serve_asset_policy_limited_replacement_review.py`.
 */
export function computePolicyReplacementItemIds(packet: PolicyReplacementPacket): Set<PolicyReplacementItemId> {
  const ids = new Set<PolicyReplacementItemId>()
  ;(packet.visualReplacementPlans ?? []).forEach((_value, index) => {
    ids.add(`visual-${index + 1}` as PolicyReplacementItemId)
  })
  const llm = packet.llmCopy ?? {}
  ;(llm.headlines ?? []).forEach((_value, index) => {
    ids.add(`headline-${index + 1}` as PolicyReplacementItemId)
  })
  ;(llm.longHeadlines ?? []).forEach((_value, index) => {
    ids.add(`long-headline-${index + 1}` as PolicyReplacementItemId)
  })
  ;(llm.descriptions ?? []).forEach((_value, index) => {
    ids.add(`description-${index + 1}` as PolicyReplacementItemId)
  })
  ;(llm.templateFamilies ?? []).forEach((_value, index) => {
    ids.add(`template-family-${index + 1}` as PolicyReplacementItemId)
  })
  for (const mapping of packet.textReplacementMappings ?? []) {
    const mappingId = mapping.mappingId.trim()
    if (mappingId) {
      ids.add(mappingId as PolicyReplacementItemId)
    }
  }
  return ids
}

/**
 * Mirror of `normalize_items` from the legacy Python service. Drops
 * unknown ids, unknown decisions, unknown categories, oversize fields, and
 * pure `unreviewed` entries with no fields.
 */
export function normalizePolicyReplacementItems(
  rawItems: unknown,
  allowedIds: ReadonlySet<PolicyReplacementItemId>,
): Record<PolicyReplacementItemId, PolicyReplacementItemState> {
  const normalized: Record<PolicyReplacementItemId, PolicyReplacementItemState> = {}
  if (!rawItems || typeof rawItems !== 'object' || Array.isArray(rawItems)) {
    return normalized
  }

  for (const [rawId, rawValue] of Object.entries(rawItems as Record<string, unknown>)) {
    const itemId = rawId.trim()
    if (!itemId || !allowedIds.has(itemId as PolicyReplacementItemId)) {
      continue
    }
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
      continue
    }
    const candidate = rawValue as { decision?: unknown; fields?: unknown }
    const decisionParse = PolicyReplacementDecisionSchema.safeParse(candidate.decision)
    const decision: PolicyReplacementDecision = decisionParse.success ? decisionParse.data : 'unreviewed'

    const fields: PolicyReplacementItemFields = {}
    const rawFields = candidate.fields
    if (rawFields && typeof rawFields === 'object' && !Array.isArray(rawFields)) {
      for (const [rawKey, rawFieldValue] of Object.entries(rawFields as Record<string, unknown>)) {
        const keyParse = PolicyReplacementFieldKeySchema.safeParse(rawKey)
        if (!keyParse.success || rawFieldValue == null) {
          continue
        }
        const key = keyParse.data
        const text = String(rawFieldValue).slice(0, POLICY_REPLACEMENT_FIELD_MAX_LEN)
        if (key === 'replacementCategory') {
          if (text === '' || PolicyReplacementCategorySchema.safeParse(text).success) {
            fields[key] = text as PolicyReplacementCategory | ''
          }
          continue
        }
        fields[key] = text
      }
    }

    if (decision === 'unreviewed' && Object.keys(fields).length === 0) {
      continue
    }
    normalized[itemId as PolicyReplacementItemId] = { decision, fields }
  }

  return normalized
}
