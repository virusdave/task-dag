import { z } from 'zod'

// API contracts for the SEO FAQ control plane (P3).
//
// The Helios control plane lets an operator author / generate / review /
// APPROVE FAQ sets that later feed the signed SEO bundle. Approval is the
// IRONCLAD human gate (canon §1): nothing reaches a published bundle
// without an approver signing off on the EXACT content fingerprint.
//
// child FreshlyBakedNYC/automation#44 (P3) · Satisfies: virusdave/top-level#15

// A single FAQ item — mirrors the frozen seo/contracts.ts FaqItemSchema.
// The `question` is shared across hosts; answers carry both a raw (FB.nyc)
// and a sanitized (FB.us) variant.
export const SeoFaqItemSchema = z
  .object({
    question: z.string().min(1),
    answer_raw: z.string().min(1),
    answer_sanitized: z.string().min(1),
  })
  .strict()
export type SeoFaqItem = z.infer<typeof SeoFaqItemSchema>

export const SeoFaqStatusSchema = z.enum(['draft', 'needs_review', 'approved', 'rejected'])
export type SeoFaqStatus = z.infer<typeof SeoFaqStatusSchema>

export const SeoFaqSourceSchema = z.enum(['manual', 'generated'])
export type SeoFaqSource = z.infer<typeof SeoFaqSourceSchema>

// A control-plane FAQ-set row as returned to the client.
export const SeoFaqSetRecordSchema = z.object({
  faqSetId: z.string().min(1),
  scope: z.string().min(1),
  // The stable logical source identity (e.g. `fbus-global-faq`), or null
  // for a manual/legacy set. An FBUS source key holds the set to the
  // stricter FBUS denylist at approval time (CI gate 2). DB-constrained to
  // the source-key grammar; never settable via the public authoring API.
  sourceKey: z.string().nullable(),
  status: SeoFaqStatusSchema,
  source: SeoFaqSourceSchema,
  items: z.array(SeoFaqItemSchema),
  // Current content fingerprint — the client echoes this back on approve
  // (expectedContentSha256) so an approval can never cover content that
  // changed after the page loaded.
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  approvalId: z.string().nullable(),
  approvedByUserId: z.number().int().positive().nullable(),
  approvedAt: z.string().nullable(),
  approvalNote: z.string().nullable(),
  generationMeta: z.unknown().nullable(),
  createdByUserId: z.number().int().positive().nullable(),
  updatedByUserId: z.number().int().positive().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SeoFaqSetRecord = z.infer<typeof SeoFaqSetRecordSchema>

export const SeoFaqSetListResponseSchema = z.object({
  faqSets: z.array(SeoFaqSetRecordSchema),
})
export type SeoFaqSetListResponse = z.infer<typeof SeoFaqSetListResponseSchema>

export const SeoFaqSetDetailResponseSchema = z.object({
  faqSet: SeoFaqSetRecordSchema,
})
export type SeoFaqSetDetailResponse = z.infer<typeof SeoFaqSetDetailResponseSchema>

// Scope is a concrete site id or the reserved global `all` token; the
// compiler's consistency layer rejects a physical `all` site.
const ScopeFieldSchema = z.string().trim().min(1).max(128)

export const SeoFaqSetCreateBodySchema = z
  .object({
    scope: ScopeFieldSchema,
    // A brand-new set can start empty (operator fills it in) or with items.
    items: z.array(SeoFaqItemSchema).default([]),
  })
  .strict()
export type SeoFaqSetCreateBody = z.infer<typeof SeoFaqSetCreateBodySchema>

// Edits replace scope + items wholesale. Any successful edit resets the
// set to `draft` and clears its approval (server-enforced) so an approval
// can never silently cover edited content.
export const SeoFaqSetUpdateBodySchema = z
  .object({
    scope: ScopeFieldSchema,
    items: z.array(SeoFaqItemSchema),
  })
  .strict()
export type SeoFaqSetUpdateBody = z.infer<typeof SeoFaqSetUpdateBodySchema>

// Dry-run compliance check (no mutation). Lets the editor UI surface the
// same problems the approve path would raise. `sourceKey` is ADVISORY here
// (it lets the UI preview the stricter FBUS rule for an FBUS set); the
// authoritative approval check always reads the set's persisted source key
// from the locked DB row, never client input.
export const SeoFaqSetCheckBodySchema = z
  .object({
    items: z.array(SeoFaqItemSchema),
    sourceKey: z.string().trim().min(1).nullable().optional(),
  })
  .strict()
export type SeoFaqSetCheckBody = z.infer<typeof SeoFaqSetCheckBodySchema>

// Mark a draft as ready for review (no content change).
export const SeoFaqSetSubmitBodySchema = z.object({}).strict()

export const SeoFaqSetApproveBodySchema = z
  .object({
    // The fingerprint the reviewer actually saw. A mismatch with the
    // current row => 409 (stale review).
    expectedContentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
export type SeoFaqSetApproveBody = z.infer<typeof SeoFaqSetApproveBodySchema>

export const SeoFaqSetRejectBodySchema = z
  .object({
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
export type SeoFaqSetRejectBody = z.infer<typeof SeoFaqSetRejectBodySchema>

// Bedrock generation produces a DRAFT PROPOSAL only — never auto-approved,
// never auto-published. The operator reviews/edits, then approves.
export const SeoFaqGenerateBodySchema = z
  .object({
    topic: z.string().trim().min(3).max(2000),
    itemCount: z.number().int().min(1).max(10).default(5),
  })
  .strict()
export type SeoFaqGenerateBody = z.infer<typeof SeoFaqGenerateBodySchema>

// Family-contextual Bedrock generation (#46 P5). `familyId` is a registry
// family id or a known alias (e.g. `conquest` → `compare`); the server
// resolves it against the vendored mss LP-family registry, derives the FBUS
// source key, and persists a DRAFT scoped to that family. `focus` is an
// optional operator-supplied angle. Like topic generation, it produces a
// DRAFT PROPOSAL only — never auto-approved, never auto-published.
export const SeoFaqFamilyGenerateBodySchema = z
  .object({
    familyId: z.string().trim().min(1).max(64),
    itemCount: z.number().int().min(1).max(10).default(5),
    focus: z.string().trim().max(2000).optional(),
  })
  .strict()
export type SeoFaqFamilyGenerateBody = z.infer<typeof SeoFaqFamilyGenerateBodySchema>

export const SeoFaqRouteParamsSchema = z.object({
  faqSetId: z.string().min(1),
})
export type SeoFaqRouteParams = z.infer<typeof SeoFaqRouteParamsSchema>

// ── Review page (#46 P5) ──────────────────────────────────────────────
//
// The single, server-derived "everything a reviewer needs to decide"
// bundle for one FAQ set, returned by GET /api/seo/faq-sets/:id/review.
// Compliance problems are the hard approval blockers (same check the
// approve path enforces); governance problems are advisory warnings; leak
// markers annotate the sanitized-host fields; placement is derived from the
// PERSISTED source key; preview is the no-cloaking JSON-LD for both modes.

// Structural completeness + sanitized-host compliance blocker (mirrors the
// server's FaqComplianceProblem). itemIndex -1 = a set-level problem.
export const SeoFaqComplianceProblemSchema = z.object({
  itemIndex: z.number().int(),
  field: z.enum(['question', 'answer_sanitized', 'answer_raw']),
  message: z.string(),
})
export type SeoFaqComplianceProblem = z.infer<typeof SeoFaqComplianceProblemSchema>

// Advisory governance warning (mirrors the server's FaqGovernanceProblem).
export const SeoFaqGovernanceProblemSchema = z.object({
  category: z.enum([
    'item_count',
    'question_length',
    'answer_length',
    'forbidden_term',
    'duplicate_question',
    'near_duplicate_answer',
  ]),
  itemIndex: z.number().int(),
  relatedItemIndex: z.number().int().optional(),
  field: z.enum(['question', 'answer_raw', 'answer_sanitized']).optional(),
  message: z.string(),
})
export type SeoFaqGovernanceProblem = z.infer<typeof SeoFaqGovernanceProblemSchema>

// Per-field sanitized-host (`.us`) leak markers for one item. Only the
// shared question and the sanitized answer are leak-checked (the raw answer
// is the FB.nyc variant and may carry raw copy).
export const SeoFaqReviewLeakMarkersSchema = z.object({
  itemIndex: z.number().int().nonnegative(),
  field: z.enum(['question', 'answer_sanitized']),
  markers: z.array(z.string()),
})
export type SeoFaqReviewLeakMarkers = z.infer<typeof SeoFaqReviewLeakMarkersSchema>

// Where this set publishes, resolved from its persisted source key. Every
// shape is explicit so the page never pretends a keyless / non-LP / unknown
// set maps to LP route patterns.
export const SeoFaqReviewPlacementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('lp_family'),
    sourceKey: z.string(),
    familyId: z.string(),
    canonicalRepresentativeRoute: z.string(),
    routePatterns: z.array(z.string()),
    indexabilityPolicy: z.unknown(),
  }),
  z.object({
    kind: z.literal('non_lp_source_key'),
    sourceKey: z.string(),
    familySlug: z.string(),
  }),
  z.object({
    kind: z.literal('unknown_source_key'),
    sourceKey: z.string(),
  }),
  z.object({
    kind: z.literal('no_source_key'),
    sourceKey: z.null(),
  }),
])
export type SeoFaqReviewPlacement = z.infer<typeof SeoFaqReviewPlacementSchema>

export const SeoFaqReviewResponseSchema = z.object({
  faqSet: SeoFaqSetRecordSchema,
  compliance: z.object({
    ok: z.boolean(),
    problems: z.array(SeoFaqComplianceProblemSchema),
  }),
  governance: z.object({
    ok: z.boolean(),
    problems: z.array(SeoFaqGovernanceProblemSchema),
  }),
  sanitizedHostLeakMarkers: z.array(SeoFaqReviewLeakMarkersSchema),
  placement: SeoFaqReviewPlacementSchema,
  preview: z.object({
    rawJsonLd: z.record(z.string(), z.unknown()),
    sanitizedJsonLd: z.record(z.string(), z.unknown()),
  }),
})
export type SeoFaqReviewResponse = z.infer<typeof SeoFaqReviewResponseSchema>
