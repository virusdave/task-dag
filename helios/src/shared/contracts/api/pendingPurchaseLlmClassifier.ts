import { z } from 'zod'

// Output contract for the PROSPECTIVE LLM pending-purchase classifier
// (child FreshlyBakedNYC/automation#54, task C4, parent virusdave/top-level#33).
//
// C4 replaces the reactive one-name-at-a-time classifier with an event-level
// pass: the model sees the WHOLE delivery (every line item), the live catalog
// candidates, and the inert cited hint facts produced by C3, and emits one
// draft row per line item. The model is a PROPOSER, never an authorizer:
//
//   - It may PROPOSE reusing an existing live product (reuseProductIdCandidate
//     + cited evidence), but C5's deterministic validator decides whether that
//     candidate ever becomes the authoritative raw_row_json.reuseProductId.
//   - It does NOT compute price or market evidence (Helios does that
//     deterministically in C5).
//
// This contract is therefore deliberately NARROWER than the persisted
// PendingPurchaseRow. The model returns only `{ drafts: [...] }`; the worker
// wraps it with provenance (schemaVersion / model / promptVersion) so the
// model can never fabricate its own provenance.
//
// Citations point at the C3 facts the claim rests on, formatted
// "<hintDocumentId>#<factId>" (see PENDING_PURCHASE_HINT_CITED_ID_RE). The
// worker validates every cited id against the facts actually put in the prompt
// and rejects hallucinated references.
//
// Satisfies: virusdave/top-level#33

export const PENDING_PURCHASE_CLASSIFIER_SCHEMA_VERSION = 1 as const

// A cited-hint id ties a model claim back to one inert C3 fact:
// "<hintDocumentId>#<factId>", e.g. "pphdoc_2026-06-21_000123_ab12cd#f3".
export const PENDING_PURCHASE_HINT_CITED_ID_RE =
  /^pphdoc_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}#f[1-9][0-9]*$/
const CitedHintIdSchema = z.string().regex(PENDING_PURCHASE_HINT_CITED_ID_RE)

// How a proposed reuse link was arrived at. `model-inference` is the weakest
// (no external corroboration); the validator (C5) weighs the source.
export const PendingPurchaseReuseEvidenceSourceSchema = z.enum([
  'current-distributor-link',
  'sweed-suggestion',
  'sibling-po',
  'live-catalog-search',
  'model-inference',
])
export type PendingPurchaseReuseEvidenceSource = z.infer<
  typeof PendingPurchaseReuseEvidenceSourceSchema
>

export const PendingPurchaseProposedActionSchema = z.enum([
  'catalog-create',
  'mapping-only',
  'needs-review',
])
export type PendingPurchaseProposedAction = z.infer<typeof PendingPurchaseProposedActionSchema>

const BoundedNullableString = (max: number) => z.string().trim().min(1).max(max).nullable()

export const PendingPurchaseReuseEvidenceSchema = z
  .object({
    source: PendingPurchaseReuseEvidenceSourceSchema,
    rationale: z.string().trim().min(1).max(2000),
    citedHintIds: z.array(CitedHintIdSchema).max(50),
  })
  .strict()
export type PendingPurchaseReuseEvidence = z.infer<typeof PendingPurchaseReuseEvidenceSchema>

// One draft classification row, keyed to a single distributor line-item group.
// `rowKey` ties it back to the input event row; the worker verifies coverage
// (exactly one draft per expected row key) and copies distributor identity
// from the input rather than trusting the model's echo.
export const PendingPurchaseLlmDraftRowSchema = z
  .object({
    rowKey: z.string().trim().min(1).max(200),
    distributorProductId: z.string().trim().min(1).max(200),
    distributorProductName: z.string().trim().min(1).max(500),

    targetBrand: BoundedNullableString(160),
    targetCategory: BoundedNullableString(120),
    targetSubcategory: BoundedNullableString(120),
    targetGroupName: BoundedNullableString(200),
    targetVariantName: BoundedNullableString(200),
    targetVariantTab: BoundedNullableString(120),
    targetStrainName: BoundedNullableString(160),
    targetSize: BoundedNullableString(80),
    targetPackCount: z.number().int().positive().max(1000).nullable(),

    proposedAction: PendingPurchaseProposedActionSchema,

    // CANDIDATE ONLY — never the authoritative reuse link. C5 validates it
    // against the live product before it can ever become reuseProductId.
    reuseProductIdCandidate: z.number().int().positive().nullable(),
    reuseEvidence: PendingPurchaseReuseEvidenceSchema.nullable(),

    confidence: z.number().min(0).max(1),
    rationale: z.string().trim().min(1).max(4000),
    citedHintIds: z.array(CitedHintIdSchema).max(50),
    warningFlags: z.array(z.string().trim().min(1).max(200)).max(50),
  })
  .strict()
  .superRefine((row, ctx) => {
    // A candidate and its evidence travel together — a candidate with no
    // evidence is unreviewable; evidence with no candidate is meaningless.
    if ((row.reuseProductIdCandidate === null) !== (row.reuseEvidence === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'reuseProductIdCandidate and reuseEvidence must both be null or both set.',
      })
    }
    // Action ↔ candidate coherence. The model PROPOSES; this keeps the
    // proposal internally consistent so the validator never has to guess.
    if (row.proposedAction === 'mapping-only' && row.reuseProductIdCandidate === null) {
      ctx.addIssue({
        code: 'custom',
        message: "proposedAction 'mapping-only' requires a reuseProductIdCandidate.",
      })
    }
    if (row.proposedAction === 'catalog-create' && row.reuseProductIdCandidate !== null) {
      ctx.addIssue({
        code: 'custom',
        message: "proposedAction 'catalog-create' must not carry a reuseProductIdCandidate.",
      })
    }
  })
export type PendingPurchaseLlmDraftRow = z.infer<typeof PendingPurchaseLlmDraftRowSchema>

// The RAW model envelope: the model returns only its drafts. Provenance is
// added by the worker, never by the model.
export const PendingPurchaseLlmClassifierModelOutputSchema = z
  .object({
    drafts: z.array(PendingPurchaseLlmDraftRowSchema).max(2000),
  })
  .strict()
export type PendingPurchaseLlmClassifierModelOutput = z.infer<
  typeof PendingPurchaseLlmClassifierModelOutputSchema
>

// The worker-wrapped result the rest of Helios (C5/C8) consumes.
export const PendingPurchaseLlmClassifierResultSchema = z.object({
  schemaVersion: z.literal(PENDING_PURCHASE_CLASSIFIER_SCHEMA_VERSION),
  // The model id that actually ran (resolved override-then-default).
  model: z.string().trim().min(1).max(200),
  // Bumped whenever the prompt's semantics change, for audit/replay.
  promptVersion: z.string().trim().min(1).max(120),
  drafts: z.array(PendingPurchaseLlmDraftRowSchema),
})
export type PendingPurchaseLlmClassifierResult = z.infer<
  typeof PendingPurchaseLlmClassifierResultSchema
>
