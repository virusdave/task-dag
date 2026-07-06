import { z } from 'zod'

// ---------------------------------------------------------------------------
// LitAlerts parse-correction feedback inbox (issue #59, task T3).
//
// An INERT operator-feedback store for the brand-categorical-family market-match
// audit panel. From a mis-parsed competitor listing the operator can (A) correct
// the extracted structured fields for THAT listing and (B) optionally record the
// retailer's naming convention (scoped by default to that retailer ×
// category/subcategory).
//
// Cardinal rule (see automation#59 + Oracle design review): this is NOT a second,
// live parser. Unpromoted feedback must NEVER change production scoring/matching,
// `fuzzy_skus`, market aggregates, or IQR. It only improves the OPERATOR WORKFLOW
// (show saved feedback on rows, prefill future corrections, "convention exists"
// hints). Promotion into parsekit / `helios-parser-configs` is an agent/reviewer
// task (T5), never a web-side git write.
// ---------------------------------------------------------------------------

/** Which discriminated kind of feedback a row carries. */
export const ParseFeedbackKindSchema = z.enum(['listing_correction', 'convention_proposal'])
export type ParseFeedbackKind = z.infer<typeof ParseFeedbackKindSchema>

/** Upstream source of the raw listing. `litalerts` is the only source today. */
export const ParseFeedbackUseCaseSchema = z.enum(['litalerts', 'competitor-ecom'])
export type ParseFeedbackUseCase = z.infer<typeof ParseFeedbackUseCaseSchema>

/**
 * Feedback lifecycle. Web writes only ever produce `draft`; the promotion
 * transitions (`promotion_requested` → `promoted`/`rejected`) are driven by the
 * agent/reviewer promotion path (T5). `superseded` marks an older draft replaced
 * by a newer correction for the same listing.
 */
export const ParseFeedbackStatusSchema = z.enum([
  'draft',
  'promotion_requested',
  'promoted',
  'rejected',
  'superseded',
])
export type ParseFeedbackStatus = z.infer<typeof ParseFeedbackStatusSchema>

/** "What's wrong?" chips the operator selected on the drawer. */
export const ParseFeedbackIssueTypeSchema = z.enum([
  'size',
  'pack_qty',
  'category_subcategory',
  'brand',
  'name_tokens_strain',
  'price_genuine',
  'no_match',
])
export type ParseFeedbackIssueType = z.infer<typeof ParseFeedbackIssueTypeSchema>

/** Optional convention scope; defaults (client-side) to `retailer_category`. */
export const ConventionScopeSchema = z.enum([
  'retailer_category',
  'retailer_wide',
  'retailer_brand',
  'listing_only',
])
export type ConventionScope = z.infer<typeof ConventionScopeSchema>

/** Optional convention pattern chips (never authored parsekit JSON/regex). */
export const ConventionPatternChipSchema = z.enum([
  'brand_first',
  'size_at_end',
  'pack_before_size',
  'total_size_shown',
  'unit_size_shown',
])
export type ConventionPatternChip = z.infer<typeof ConventionPatternChipSchema>

// A short unit label (e.g. "g", "mg", "ml"); bounded so a stray paste can't
// balloon the row. Never interpreted server-side — it is operator-authored.
const ShortUnitSchema = z.string().trim().min(1).max(16)

/**
 * The corrected structured fields the operator entered for ONE listing. Every
 * correction field is optional — the operator fixes only what the chips flagged.
 * These are stored verbatim (never re-run through a parser) and only consumed by
 * the drawer prefill + the T5 export.
 */
export const ListingCorrectionDetailsSchema = z
  .object({
    issueTypes: z.array(ParseFeedbackIssueTypeSchema).max(16).default([]),
    packCount: z.number().int().positive().nullable().default(null),
    unitSizeValue: z.number().positive().nullable().default(null),
    unitSizeUnit: ShortUnitSchema.nullable().default(null),
    totalSizeValue: z.number().positive().nullable().default(null),
    totalSizeUnit: ShortUnitSchema.nullable().default(null),
    category: z.string().trim().max(120).nullable().default(null),
    subcategory: z.string().trim().max(120).nullable().default(null),
    brand: z.string().trim().max(200).nullable().default(null),
    strain: z.string().trim().max(200).nullable().default(null),
    nameTokens: z.string().trim().max(500).nullable().default(null),
    note: z.string().trim().max(2000).nullable().default(null),
  })
  .strict()
export type ListingCorrectionDetails = z.infer<typeof ListingCorrectionDetailsSchema>

/**
 * The operator's optional retailer naming-convention proposal. Free-text +
 * auto-generated examples + optional pattern chips. The operator NEVER authors
 * parsekit JSON or regex — this is a hint for a later human/agent promotion.
 */
export const ConventionProposalDetailsSchema = z
  .object({
    scope: ConventionScopeSchema,
    note: z.string().trim().max(4000).default(''),
    examples: z.array(z.string().trim().max(500)).max(50).default([]),
    patternChips: z.array(ConventionPatternChipSchema).max(16).default([]),
    // Scope refiners — which category / subcategory / brand this convention is
    // meant to apply to (populated from the correcting listing's family).
    category: z.string().trim().max(120).nullable().default(null),
    subcategory: z.string().trim().max(120).nullable().default(null),
    brand: z.string().trim().max(200).nullable().default(null),
  })
  .strict()
export type ConventionProposalDetails = z.infer<typeof ConventionProposalDetailsSchema>

// Provenance/lifecycle fields shared by every feedback record (mirrors the
// non-`details` columns of `litalerts_parse_feedback`).
const ParseFeedbackRecordBaseSchema = z.object({
  id: z.string().uuid(),
  useCase: ParseFeedbackUseCaseSchema,
  sourceListingId: z.string().nullable(),
  fuzzySkuId: z.number().int().nullable(),
  /** STABLE retailer identifier (never the display name). */
  retailerId: z.number().int().nullable(),
  rawListingName: z.string().nullable(),
  inputHash: z.string().nullable(),
  inputSnapshot: z.record(z.string(), z.unknown()).nullable(),
  familyKey: z.string().nullable(),
  brandKey: z.string().nullable(),
  matchedCatalogProductId: z.number().int().nullable(),
  /** Convention proposals point back to the listing correction that spawned them. */
  sourceFeedbackId: z.string().uuid().nullable(),
  status: ParseFeedbackStatusSchema,
  /**
   * Promotion provenance (task T5). Populated only when the feedback is marked
   * `promoted` (and preserved through a later `superseded`) by the agent/reviewer
   * promotion path — never a web-side git write. `promotedParserId` +
   * `promotedConfigSha` are set together; `promotedRuleId` is optional and only
   * meaningful alongside a parser id.
   */
  promotedParserId: z.string().nullable(),
  promotedRuleId: z.string().nullable(),
  promotedConfigSha: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
  statusChangedBy: z.string().nullable(),
  statusChangedAt: z.string().nullable(),
})

export const ListingCorrectionFeedbackRecordSchema = ParseFeedbackRecordBaseSchema.extend({
  kind: z.literal('listing_correction'),
  details: ListingCorrectionDetailsSchema,
})
export type ListingCorrectionFeedbackRecord = z.infer<typeof ListingCorrectionFeedbackRecordSchema>

export const ConventionProposalFeedbackRecordSchema = ParseFeedbackRecordBaseSchema.extend({
  kind: z.literal('convention_proposal'),
  details: ConventionProposalDetailsSchema,
})
export type ConventionProposalFeedbackRecord = z.infer<typeof ConventionProposalFeedbackRecordSchema>

export const ParseFeedbackRecordSchema = z.discriminatedUnion('kind', [
  ListingCorrectionFeedbackRecordSchema,
  ConventionProposalFeedbackRecordSchema,
])
export type ParseFeedbackRecord = z.infer<typeof ParseFeedbackRecordSchema>

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

/** Cap on how many ids a single feedback fetch may request (bounded read). */
export const PARSE_FEEDBACK_ID_QUERY_LIMIT = 500

const CommaNumberIdsSchema = z
  .string()
  .optional()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number(s)),
  )
  .refine((ids) => ids.every((n) => Number.isInteger(n)), {
    message: 'ids must be integers',
  })
  .refine((ids) => ids.length <= PARSE_FEEDBACK_ID_QUERY_LIMIT, {
    message: `at most ${PARSE_FEEDBACK_ID_QUERY_LIMIT} ids per request`,
  })

/** GET /api/catalog/family-explorer/parse-feedback?fuzzySkuIds=..&retailerIds=.. */
export const ParseFeedbackListQuerySchema = z
  .object({
    fuzzySkuIds: CommaNumberIdsSchema,
    retailerIds: CommaNumberIdsSchema,
  })
  .refine((q) => q.fuzzySkuIds.length > 0 || q.retailerIds.length > 0, {
    message: 'provide at least one of fuzzySkuIds or retailerIds',
  })
export type ParseFeedbackListQuery = z.infer<typeof ParseFeedbackListQuerySchema>

export const ParseFeedbackListResponseSchema = z.object({
  feedback: z.array(ParseFeedbackRecordSchema),
})
export type ParseFeedbackListResponse = z.infer<typeof ParseFeedbackListResponseSchema>

/**
 * POST body for a single drawer "save". A save always carries the listing
 * correction and OPTIONALLY a convention proposal; both are persisted in one
 * transaction and the convention is linked back to the correction. Provenance
 * (source listing id / retailer id / raw name / hash / snapshot / use case) is
 * derived server-side from `fuzzySkuId` — never trusted from the browser.
 */
export const CreateParseFeedbackBodySchema = z.object({
  listingCorrection: z.object({
    fuzzySkuId: z.number().int(),
    familyKey: z.string().min(1),
    brandKey: z.string().nullable(),
    matchedCatalogProductId: z.number().int().nullable(),
    details: ListingCorrectionDetailsSchema,
  }),
  conventionProposal: z
    .object({
      details: ConventionProposalDetailsSchema,
    })
    .optional(),
})
export type CreateParseFeedbackBody = z.infer<typeof CreateParseFeedbackBodySchema>

export const CreateParseFeedbackResponseSchema = z.object({
  listingCorrection: ListingCorrectionFeedbackRecordSchema,
  conventionProposal: ConventionProposalFeedbackRecordSchema.nullable(),
})
export type CreateParseFeedbackResponse = z.infer<typeof CreateParseFeedbackResponseSchema>

export const ParseFeedbackRouteParamsSchema = z.object({
  feedbackId: z.string().uuid(),
})
export type ParseFeedbackRouteParams = z.infer<typeof ParseFeedbackRouteParamsSchema>

/**
 * PATCH body to re-edit a still-`draft` feedback row. `details` must match the
 * row's existing `kind` (enforced server-side). `matchedCatalogProductId` may be
 * updated on a listing correction.
 */
export const UpdateParseFeedbackBodySchema = z.object({
  details: z.union([ListingCorrectionDetailsSchema, ConventionProposalDetailsSchema]),
  matchedCatalogProductId: z.number().int().nullable().optional(),
})
export type UpdateParseFeedbackBody = z.infer<typeof UpdateParseFeedbackBodySchema>

/**
 * PATCH status body. Transitioning to `promoted` REQUIRES promotion provenance
 * (`promotedParserId` + `promotedConfigSha`; `promotedRuleId` optional) — this
 * is the agent/reviewer marking a DB row as realized in `helios-parser-configs`
 * (task T5). Every other status carries no provenance (the server preserves any
 * prior provenance on `superseded` and clears it on the draft-cycle statuses).
 */
export const UpdateParseFeedbackStatusBodySchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('promoted'),
      promotedParserId: z.string().trim().min(1).max(200),
      promotedRuleId: z.string().trim().min(1).max(200).nullable().optional(),
      // parser-configs release commit sha (40-hex).
      promotedConfigSha: z
        .string()
        .trim()
        .regex(/^[0-9a-f]{40}$/i, 'promotedConfigSha must be a 40-char hex commit sha'),
    })
    .strict(),
  z
    .object({
      status: z.enum(['draft', 'promotion_requested', 'rejected', 'superseded']),
    })
    .strict(),
])
export type UpdateParseFeedbackStatusBody = z.infer<typeof UpdateParseFeedbackStatusBodySchema>

export const ParseFeedbackRecordResponseSchema = z.object({
  feedback: ParseFeedbackRecordSchema,
})
export type ParseFeedbackRecordResponse = z.infer<typeof ParseFeedbackRecordResponseSchema>

// ---------------------------------------------------------------------------
// Promotion export (task T5)
//
// A READ-ONLY, agent/reviewer-facing report that shapes the inert feedback
// inbox into material for turning corrections into parsekit goldens + a
// `helios-parser-configs/use-cases/litalerts/parsers/<tenantId>.jsonc` entry.
// It NEVER writes a parser config (no web-side git writes) and never joins the
// production scorer / market-match read path. See
// docs/helios/catalog-market-data/PARSE_FEEDBACK_PROMOTION.md.
// ---------------------------------------------------------------------------

/** Cap on how many listing corrections a single export may return (bounded read). */
export const PROMOTION_EXPORT_MAX_CORRECTIONS = 500

const CommaStatusSchema = z
  .string()
  .optional()
  .default('draft,promotion_requested')
  .transform((raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  .pipe(z.array(ParseFeedbackStatusSchema).min(1, 'provide at least one status'))

/** GET /api/catalog/family-explorer/parse-feedback/promotion-export?retailerId=..&statuses=.. */
export const PromotionExportQuerySchema = z.object({
  retailerId: z.coerce.number().int(),
  statuses: CommaStatusSchema,
})
export type PromotionExportQuery = z.infer<typeof PromotionExportQuerySchema>

/**
 * Best-effort mapping of the operator's corrected fields into parsekit's
 * LitAlerts projection shape. Fields the operator didn't supply (or that can't
 * be normalized to the parsekit enums) stay null — this is a hint, not a golden.
 */
export const PromotionBestEffortExpectedSchema = z
  .object({
    brand: z.string().nullable(),
    productLine: z.null(),
    variantName: z.string().nullable(),
    category: z.string().nullable(),
    packCount: z.number().int().nullable(),
    unitSize: z.object({ value: z.number(), unit: z.string() }).nullable(),
    totalSize: z.object({ value: z.number(), unit: z.string() }).nullable(),
    prevalence: z.null(),
    searchTerm: z.null(),
  })
  .strict()
export type PromotionBestEffortExpected = z.infer<typeof PromotionBestEffortExpectedSchema>

/**
 * A ready-to-paste parsekit golden — present ONLY when the best-effort mapping
 * forms a full, valid LitAlerts descriptor. `expected` mirrors parsekit's
 * `GoldenCase.expected` (validated server-side against the descriptor schema).
 */
export const PromotionParsekitGoldenSchema = z.object({
  kind: z.literal('match'),
  id: z.string(),
  input: z.string(),
  expected: z.unknown(),
})
export type PromotionParsekitGolden = z.infer<typeof PromotionParsekitGoldenSchema>

export const PromotionExportConventionSchema = z.object({
  id: z.string().uuid(),
  status: ParseFeedbackStatusSchema,
  details: ConventionProposalDetailsSchema,
  createdAt: z.string(),
})
export type PromotionExportConvention = z.infer<typeof PromotionExportConventionSchema>

export const PromotionExportCorrectionSchema = z.object({
  feedbackId: z.string().uuid(),
  status: ParseFeedbackStatusSchema,
  sourceListingId: z.string().nullable(),
  fuzzySkuId: z.number().int().nullable(),
  rawListingName: z.string().nullable(),
  inputSnapshot: z.record(z.string(), z.unknown()).nullable(),
  familyKey: z.string().nullable(),
  brandKey: z.string().nullable(),
  matchedCatalogProductId: z.number().int().nullable(),
  rawCorrection: ListingCorrectionDetailsSchema,
  bestEffortExpected: PromotionBestEffortExpectedSchema,
  parsekitGolden: PromotionParsekitGoldenSchema.nullable(),
  /** Why `parsekitGolden` is null / caveats for the reviewer. */
  issues: z.array(z.string()),
  conventionProposals: z.array(PromotionExportConventionSchema),
})
export type PromotionExportCorrection = z.infer<typeof PromotionExportCorrectionSchema>

/** All corrections for one retailer that resolve to the same parsekit tenant. */
export const PromotionExportTenantGroupSchema = z.object({
  tenantId: z.string(),
  /** `litalerts.<tenantId>` — the parsekit parser id to create/update. */
  parserId: z.string(),
  /** `use-cases/litalerts/parsers/<tenantId>.jsonc` — the config file to author. */
  configPath: z.string(),
  dispensaryName: z.string().nullable(),
  useCase: ParseFeedbackUseCaseSchema,
  corrections: z.array(PromotionExportCorrectionSchema),
})
export type PromotionExportTenantGroup = z.infer<typeof PromotionExportTenantGroupSchema>

export const PromotionExportResponseSchema = z.object({
  retailerId: z.number().int(),
  statuses: z.array(ParseFeedbackStatusSchema),
  totalCorrections: z.number().int(),
  /** True when the correction cap was hit (re-run narrower / by status). */
  truncated: z.boolean(),
  groups: z.array(PromotionExportTenantGroupSchema),
})
export type PromotionExportResponse = z.infer<typeof PromotionExportResponseSchema>
