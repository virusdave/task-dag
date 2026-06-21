import { z } from 'zod'

// API contracts for the prospective pending-purchase classifier's HINT
// BUNDLE storage + admin surface (child FreshlyBakedNYC/automation#54,
// parent virusdave/top-level#33, task C2).
//
// Optional side-channel hint material (a distributor's wholesale menu, a
// sibling store's purchase order, a free-text operator note) is the biggest
// accuracy lever for the classifier — and the biggest injection risk. These
// documents are always treated as UNTRUSTED DATA, never instructions.
//
// v1 (operator decision 2): pasted arbitrary hint TEXT only. File uploads
// are a near-term follow-up (epic FT-1) and out of scope here. The extract +
// intent-classify pipeline (which fills hintIntent / extractionStatus /
// extractedFacts) is task C3; the classifier that consumes a bundle is C4.
//
// Satisfies: virusdave/top-level#33

// Public-id formats — mirror newHintBundleId / newHintDocumentId in
// server/pendingPurchases/hintContent.ts and the DB id-format checks.
const HintBundleIdSchema = z
  .string()
  .trim()
  .regex(/^pphint_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/, 'invalid hint bundle id')
const HintDocumentIdSchema = z
  .string()
  .trim()
  .regex(/^pphdoc_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/, 'invalid hint document id')

// How the operator says a document helps (decision 2). Mirrors
// HINT_DOCUMENT_KINDS + the pending_purchase_hint_documents_kind_check
// constraint.
export const PendingPurchaseHintDocumentKindSchema = z.enum([
  'distributor_menu',
  'sibling_purchase_order',
  'operator_note',
  'other',
])
export type PendingPurchaseHintDocumentKind = z.infer<typeof PendingPurchaseHintDocumentKindSchema>

// Bundle lifecycle — mirrors the pending_purchase_hint_bundles_status_check
// constraint. Archive, don't delete.
export const PendingPurchaseHintBundleStatusSchema = z.enum(['active', 'archived'])
export type PendingPurchaseHintBundleStatus = z.infer<typeof PendingPurchaseHintBundleStatusSchema>

// Extraction lifecycle of a document (filled by C3). Mirrors the
// pending_purchase_hint_documents_extraction_status_check constraint.
export const PendingPurchaseHintExtractionStatusSchema = z.enum([
  'pending',
  'extracted',
  'failed',
  'skipped',
])
export type PendingPurchaseHintExtractionStatus = z.infer<
  typeof PendingPurchaseHintExtractionStatusSchema
>

// ── records ───────────────────────────────────────────────────────────

export const PendingPurchaseHintDocumentRecordSchema = z.object({
  hintDocumentId: z.string().min(1),
  bundleId: z.string().min(1),
  kind: PendingPurchaseHintDocumentKindSchema,
  sourceLabel: z.string().nullable(),
  // The document BYTES live out-of-band (content-addressed blob store); the
  // record carries only the pointer metadata, never the text. Fetch the text
  // on demand via GET .../documents/:hintDocumentId/content.
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  storageBackend: z.enum(['fs', 's3']),
  // A stored blob is always > 0 B (empty text is rejected; DB enforces > 0).
  byteSize: z.number().int().positive(),
  // Filled by C3 (nullable until then).
  hintIntent: z.string().nullable(),
  extractionStatus: PendingPurchaseHintExtractionStatusSchema,
  extractionError: z.string().nullable(),
  extractedFacts: z.unknown().nullable(),
  createdByUserId: z.number().int().positive().nullable(),
  updatedByUserId: z.number().int().positive().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type PendingPurchaseHintDocumentRecord = z.infer<
  typeof PendingPurchaseHintDocumentRecordSchema
>

export const PendingPurchaseHintBundleRecordSchema = z.object({
  hintBundleId: z.string().min(1),
  label: z.string().min(1),
  note: z.string().nullable(),
  status: PendingPurchaseHintBundleStatusSchema,
  documentCount: z.number().int().nonnegative(),
  createdByUserId: z.number().int().positive().nullable(),
  updatedByUserId: z.number().int().positive().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type PendingPurchaseHintBundleRecord = z.infer<
  typeof PendingPurchaseHintBundleRecordSchema
>

// Bundle detail includes the full document list (pointer metadata only — the
// text is fetched on demand via the content endpoint); the list view
// deliberately does NOT, so a list response never ships every document.
export const PendingPurchaseHintBundleDetailSchema = PendingPurchaseHintBundleRecordSchema.extend({
  documents: z.array(PendingPurchaseHintDocumentRecordSchema),
})
export type PendingPurchaseHintBundleDetail = z.infer<typeof PendingPurchaseHintBundleDetailSchema>

// ── responses ─────────────────────────────────────────────────────────

export const PendingPurchaseHintBundleListResponseSchema = z.object({
  bundles: z.array(PendingPurchaseHintBundleRecordSchema),
})
export type PendingPurchaseHintBundleListResponse = z.infer<
  typeof PendingPurchaseHintBundleListResponseSchema
>

export const PendingPurchaseHintBundleDetailResponseSchema = z.object({
  bundle: PendingPurchaseHintBundleDetailSchema,
})
export type PendingPurchaseHintBundleDetailResponse = z.infer<
  typeof PendingPurchaseHintBundleDetailResponseSchema
>

// Adding a document returns whether it was newly inserted or deduped to an
// existing identical paste in the same bundle.
export const PendingPurchaseHintDocumentAddResponseSchema = z.object({
  document: PendingPurchaseHintDocumentRecordSchema,
  deduped: z.boolean(),
})
export type PendingPurchaseHintDocumentAddResponse = z.infer<
  typeof PendingPurchaseHintDocumentAddResponseSchema
>

// ── request bodies / params ───────────────────────────────────────────

export const PendingPurchaseHintBundleListQuerySchema = z
  .object({
    status: PendingPurchaseHintBundleStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict()
export type PendingPurchaseHintBundleListQuery = z.infer<
  typeof PendingPurchaseHintBundleListQuerySchema
>

export const CreatePendingPurchaseHintBundleBodySchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
export type CreatePendingPurchaseHintBundleBody = z.infer<
  typeof CreatePendingPurchaseHintBundleBodySchema
>

// PATCH bundle: every field optional (sparse update). A present key means
// "set this"; an absent key leaves the column untouched.
export const UpdatePendingPurchaseHintBundleBodySchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    status: PendingPurchaseHintBundleStatusSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.label !== undefined || value.note !== undefined || value.status !== undefined,
    'at least one field must be provided.',
  )
export type UpdatePendingPurchaseHintBundleBody = z.infer<
  typeof UpdatePendingPurchaseHintBundleBodySchema
>

// Add a pasted-text document to a bundle. v1 = raw text only. The route
// normalizes the text, content-addresses it, and writes the bytes to the
// out-of-band blob store; only the pointer is persisted in the DB. The
// 250k-char cap bounds a single pasted blob.
export const AddPendingPurchaseHintDocumentBodySchema = z
  .object({
    kind: PendingPurchaseHintDocumentKindSchema,
    sourceLabel: z.string().trim().max(200).nullable().optional(),
    rawText: z.string().trim().min(1).max(250_000),
  })
  .strict()
export type AddPendingPurchaseHintDocumentBody = z.infer<
  typeof AddPendingPurchaseHintDocumentBodySchema
>

export const PendingPurchaseHintBundleRouteParamsSchema = z
  .object({ hintBundleId: HintBundleIdSchema })
  .strict()
export type PendingPurchaseHintBundleRouteParams = z.infer<
  typeof PendingPurchaseHintBundleRouteParamsSchema
>

export const PendingPurchaseHintDocumentRouteParamsSchema = z
  .object({ hintBundleId: HintBundleIdSchema, hintDocumentId: HintDocumentIdSchema })
  .strict()
export type PendingPurchaseHintDocumentRouteParams = z.infer<
  typeof PendingPurchaseHintDocumentRouteParamsSchema
>
