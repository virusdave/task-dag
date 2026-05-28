// Unified canonical product-review row contract (issue #35, slice 6).
//
// ┌──────────────────────────────┐                ┌──────────────────────────────┐
// │   Ingestion pipelines        │                │   Execution mechanisms        │
// │   (produce 'before' +        │     ┌────┐     │   (apply 'approved' rows)    │
// │    'proposed' state)         │ ──▶ │ROW │ ──▶ │                              │
// │                              │     └────┘     │                              │
// │  • new purchases             │                │  • direct catalog write      │
// │  • operator-selected         │                │  • price via promo action    │
// │    repricing                 │                │  • create new catalog        │
// │  • market-drift detection    │                │    entities                  │
// │  • …                         │                │  • mixed                     │
// └──────────────────────────────┘                └──────────────────────────────┘
//
// This contract is the durable shape that sits in the middle. Every
// reviewer surface in helios — /catalog/review, /catalog/pending-
// purchases, future /catalog/repricing, /catalog/market-data,
// /catalog/promos — renders THIS shape, regardless of which pipeline
// produced the row. Approve/reject affordances are URL-shaped so
// each pipeline's server-side adapter can route to the right
// executor without the UI hard-coding endpoints per source.
//
// When you wire a new ingestion pipeline:
//   1. Add a variant to RowSourceSchema's discriminated union.
//   2. Write a server-side mapper that converts the pipeline's
//      records into CanonicalProductRow values (one row per SKU /
//      decision) and populates `actions.*` with the URL(s) for the
//      executor you want to dispatch to.
//   3. The reviewer UI requires no changes — it consumes the
//      shape and POSTs/PATCHes to the URLs the row supplied.
//
// When you wire a new executor:
//   1. Add a variant to ExecutionMechanismSchema.
//   2. Pipeline mappers that want to dispatch to it set
//      `executionPreview.mechanism` so the reviewer sees what would
//      happen on apply before they hit approve.
//
// Cross-reference: docs/helios/canonical-review-row/README.md
// describes the visual contract this data contract drives.

import { z } from 'zod'

import { PendingPurchaseMarketListingSchema } from './pendingPurchases.js'
import { ValidationIssueSchema } from './proposals.js'
import { FieldPathSchema } from '../../domain/fieldPaths.js'

/* ------------------------------------------------------------------ */
/* RowSource — which ingestion pipeline produced this row              */
/* ------------------------------------------------------------------ */
//
// Add a variant when a new pipeline starts producing canonical rows.
// The `kind` discriminator is the only thing the UI looks at; the
// rest of each variant is provenance the server-side executor uses
// to look the row's source records back up.
export const RowSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('proposal_row'),
    proposalRowId: z.number().int().positive(),
    batchId: z.number().int().positive().nullable(),
  }),
  z.object({
    kind: z.literal('pending_purchase'),
    packetId: z.number().int().positive(),
    rowId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('market_drift_detection'),
    observationId: z.number().int().positive(),
    catalogGroupId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('operator_repricing'),
    sessionId: z.number().int().positive(),
    userId: z.number().int().positive().nullable(),
  }),
])
export type RowSource = z.infer<typeof RowSourceSchema>

/* ------------------------------------------------------------------ */
/* Family key — brand × category × subcategory × size                  */
/* ------------------------------------------------------------------ */
//
// Duplicated from api/review.ts's ReviewFamilyKeySchema rather than
// imported, because this domain module must not depend on api/.
// The shapes are intentionally identical.
export const CanonicalFamilyKeySchema = z.object({
  brand: z.string().nullable(),
  category: z.string().nullable(),
  subcategory: z.string().nullable(),
  sizeName: z.string().nullable(),
})
export type CanonicalFamilyKey = z.infer<typeof CanonicalFamilyKeySchema>

export const CanonicalFamilyMSOAnnotationSchema = z.object({
  isMSOBrand: z.boolean(),
  msoBrandId: z.number().int().positive().nullable(),
  isHouseBrand: z.boolean(),
})
export type CanonicalFamilyMSOAnnotation = z.infer<typeof CanonicalFamilyMSOAnnotationSchema>

/* ------------------------------------------------------------------ */
/* Field-level proposed change                                         */
/* ------------------------------------------------------------------ */
//
// One panel rendered per field. `changeKind` drives whether the value
// gets the long-form treatment (description) or the inline three-up
// (price, taxonomy, attribute).
//
// `editUrl` is optional: when null the field is read-only on this
// row (e.g. a pending-purchase 'category' field that's only editable
// via the structured-fields override panel). When set, the reviewer
// can PATCH `{ editedValue, expectedVersion }` to that URL.
export const CanonicalFieldChangeKindSchema = z.enum([
  'pricing',
  'description',
  'taxonomy',
  'attribute',
  'image',
  'other',
])
export type CanonicalFieldChangeKind = z.infer<typeof CanonicalFieldChangeKindSchema>

export const CanonicalFieldProposalSchema = z.object({
  fieldPath: FieldPathSchema,
  label: z.string(),
  changeKind: CanonicalFieldChangeKindSchema,
  /** Current Sweed / catalog state, formatted for display. */
  liveValueText: z.string(),
  /** Pipeline-recommended new value, formatted for display. */
  proposedValueText: z.string(),
  /** What apply will actually write = editedValue ?? proposedValue, formatted for display. */
  effectiveValueText: z.string(),
  // 'superseded' covers the proposal-row case where a later batch's
  // line item retired this one; pending-purchase + market-drift
  // sources only ever use {pending, approved, rejected}.
  approvalStatus: z.enum(['pending', 'approved', 'rejected', 'superseded']),
  validationIssues: z.array(ValidationIssueSchema).default([]),
  /** PATCH URL for editing this field's proposed value, or null if read-only. */
  editUrl: z.string().nullable(),
  /** Optimistic-concurrency token for edits. */
  expectedVersion: z.number().int().positive(),
})
export type CanonicalFieldProposal = z.infer<typeof CanonicalFieldProposalSchema>

/* ------------------------------------------------------------------ */
/* Pricing ladder block (reused verbatim from /catalog/review)         */
/* ------------------------------------------------------------------ */
//
// Distinct from CanonicalFieldProposal because price gets the
// canonical-pricing-ladder visualization in addition to the
// before/after panel.
export const CanonicalPricingLadderSchema = z.object({
  productId: z.number().int().positive(),
  livePrice: z.number().nullable(),
  proposedPrice: z.number().nullable(),
  marketAveragePostTax: z.number().nullable(),
  marketMedianPostTax: z.number().nullable(),
  competitorListings: z.array(PendingPurchaseMarketListingSchema),
  evidenceFreshness: z.enum(['fresh', 'stale', 'very_stale', 'expired', 'absent']),
  evidenceCapturedAt: z.iso.datetime().nullable(),
  /** Largest absolute deviation between any eligible listing and the live price. */
  priceSpread: z.number().nullable(),
})
export type CanonicalPricingLadder = z.infer<typeof CanonicalPricingLadderSchema>

/* ------------------------------------------------------------------ */
/* Execution preview — what 'approve + apply' would do                  */
/* ------------------------------------------------------------------ */
//
// Surfaced loudly in the row UI so the reviewer isn't surprised by
// the side-effects of an approve. Pipeline-supplied.
//
// When wiring a new executor:
//   - add a variant to ExecutionMechanismSchema
//   - pipeline mappers that want to dispatch to it set
//     executionPreview.mechanism accordingly
export const ExecutionMechanismSchema = z.enum([
  'direct_catalog_write',
  'price_via_promo_action',
  'create_new_catalog_entities',
  'mixed',
  'no_op',
])
export type ExecutionMechanism = z.infer<typeof ExecutionMechanismSchema>

export const ExecutionPreviewSchema = z.object({
  mechanism: ExecutionMechanismSchema,
  /** Short, reviewer-facing one-liner: 'Update price on Sweed product #234'. */
  summary: z.string(),
  needsNewBrand: z.boolean().default(false),
  needsNewGroup: z.boolean().default(false),
  needsNewVariant: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
})
export type ExecutionPreview = z.infer<typeof ExecutionPreviewSchema>

/* ------------------------------------------------------------------ */
/* Row-level action affordances                                         */
/* ------------------------------------------------------------------ */
//
// The UI dispatches POST/PATCH to the URLs in this object; each
// pipeline's server-side adapter populates the right endpoint paths.
//
// approveOps / rejectOps are **lists** so a pipeline that approves
// at the line-item level (the current proposal-row model) can pass
// one entry per pending line item, while a pipeline that approves
// at the row level (pending-purchases) passes a single entry. The
// UI POSTs to each entry in order until either all succeed or one
// fails, surfacing the failure on the row.
export const CanonicalRowApplyOpSchema = z.object({
  url: z.string(),
  expectedVersion: z.number().int().positive(),
})
export type CanonicalRowApplyOp = z.infer<typeof CanonicalRowApplyOpSchema>

export const CanonicalRowActionsSchema = z.object({
  approveOps: z.array(CanonicalRowApplyOpSchema),
  rejectOps: z.array(CanonicalRowApplyOpSchema),
  /** PATCH URL for the reviewer's free-form operator note, or null if unsupported. */
  saveNote: CanonicalRowApplyOpSchema.nullable(),
  /** Drill-down URL for full audit / raw payload inspection, or null if unsupported. */
  detailsUrl: z.string().nullable(),
})
export type CanonicalRowActions = z.infer<typeof CanonicalRowActionsSchema>

/* ------------------------------------------------------------------ */
/* CanonicalProductRow — the row itself                                 */
/* ------------------------------------------------------------------ */
//
// rowId is stable across the lifetime of one decision and is
// pipeline-prefixed for collision safety across surfaces:
//   'prop:5678'      proposal_row source
//   'pp:1234'        pending_purchase source
//   'mkt:9876'       market_drift_detection source
//   'reprice:42'     operator_repricing source
export const CanonicalProductRowSchema = z.object({
  rowId: z.string().min(1),
  source: RowSourceSchema,
  catalogGroupId: z.number().int().positive().nullable(),
  rowTitle: z.string(),
  family: CanonicalFamilyKeySchema,
  /** Family-level MSO annotation (cached). Null when the source pipeline doesn't compute it yet. */
  mso: CanonicalFamilyMSOAnnotationSchema.nullable(),
  approvalRollup: z.enum(['pending', 'approved', 'rejected', 'mixed']),
  reconcileStatus: z.string(),
  fields: z.array(CanonicalFieldProposalSchema),
  pricingLadder: CanonicalPricingLadderSchema.nullable(),
  validationIssues: z.array(ValidationIssueSchema).default([]),
  operatorNote: z.string().nullable(),
  actions: CanonicalRowActionsSchema,
  executionPreview: ExecutionPreviewSchema,
})
export type CanonicalProductRow = z.infer<typeof CanonicalProductRowSchema>

export const CanonicalProductFamilySchema = z.object({
  familyKey: CanonicalFamilyKeySchema,
  mso: CanonicalFamilyMSOAnnotationSchema.nullable(),
  rows: z.array(CanonicalProductRowSchema),
})
export type CanonicalProductFamily = z.infer<typeof CanonicalProductFamilySchema>
