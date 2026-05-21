// API contracts for the helios Catalog→WhiteGlove→Pricing editor and
// the public freshlybaked.nyc/white-glove/bulk-flower menu it feeds.
//
// Domain notes
// ------------
// * Cost basis is per-gram, derived from the most-recent valid
//   wholesale lot (≥ MIN_COST_USD) at Midtown + Bronx for every
//   {brand, strain} flower SKU with pack size ≥ MIN_PACK_GRAMS.
// * Some SKUs exist in catalog/inventory but every observed lot has
//   cost < MIN_COST_USD (trade samples, data-entry placeholders).
//   Those are "no valid cost" SKUs and the collector imputes their
//   $/g as the average $/g across the SAME brand's priceable
//   {brand, strain} entries. Imputation is non-recursive and
//   brand-scoped only — if a brand has no priceable peer the row is
//   left unresolved (perGram=null) and cannot be auto-priced.
// * The OTD pricing formula bakes the NY combined cannabis-tax
//   markup (1.13×) into the GM equation:
//       GM = 1 − 1.13 × cost / OTD
//       OTD = 1.13 × cost / (1 − GM)
//   Defaults: 60% / 54% / 49% GM at 1/4 lb / 1/2 lb / 1 lb.
// * Per-row decisions ('accept' | 'reject' | 'pending') override
//   per-brand decisions when not 'pending'; the public menu shows
//   only rows whose effective decision is 'accept'.

import { z } from 'zod'

export const WHITEGLOVE_TAX_MULT = 1.13
export const WHITEGLOVE_MIN_PACK_GRAMS = 14
export const WHITEGLOVE_MIN_COST_USD = 1.0

export const WhitegloveDecisionSchema = z.enum(['accept', 'reject', 'pending'])
export type WhitegloveDecision = z.infer<typeof WhitegloveDecisionSchema>

export const WhitegloveSizeKeySchema = z.enum(['quarterLb', 'halfLb', 'lb'])
export type WhitegloveSizeKey = z.infer<typeof WhitegloveSizeKeySchema>

export interface WhitegloveSizeSpec {
  readonly key: WhitegloveSizeKey
  readonly label: string
  readonly grams: number
  readonly defaultGm: number
}

export const WHITEGLOVE_SIZES: readonly WhitegloveSizeSpec[] = [
  { key: 'quarterLb', label: '1/4 lb', grams: 112, defaultGm: 0.60 },
  { key: 'halfLb',    label: '1/2 lb', grams: 224, defaultGm: 0.54 },
  { key: 'lb',        label: '1 lb',   grams: 448, defaultGm: 0.49 },
]

const SizeMapSchema = z.object({
  quarterLb: z.number(),
  halfLb: z.number(),
  lb: z.number(),
})

// ---------------------------------------------------------------------------
// Cost basis (server-collected, never persisted directly — saved only
// when the operator clicks Save, which freezes a snapshot).
// ---------------------------------------------------------------------------

export const CostBasisLotSchema = z.object({
  site: z.string(),
  packGrams: z.number(),
  packLabel: z.string(),
  wholesaleCost: z.number(),
  perGram: z.number(),
  receivedAt: z.string(),
})

export const CostBasisItemSchema = z.object({
  brand: z.string(),
  strainShort: z.string(),
  strainDisplay: z.string(),
  sites: z.array(z.string()),
  // perGram is null when this SKU has no observed cost AND its brand
  // has no priceable peer to impute from. Such rows are surfaced in
  // the editor as "no cost" and cannot be auto-priced.
  perGram: z.number().nullable(),
  imputed: z.boolean(),
  imputationSource: z
    .object({
      kind: z.literal('brand-average'),
      peerCount: z.number().int().nonnegative(),
      peerStrains: z.array(z.string()),
    })
    .nullable(),
  // Provenance: the lot we picked as basis (null when imputed).
  best: z
    .object({
      packGrams: z.number(),
      packLabel: z.string(),
      wholesaleCost: z.number(),
      perGram: z.number(),
      receivedAt: z.string(),
      site: z.string(),
    })
    .nullable(),
  totalLots: z.number().int().nonnegative(),
  lots: z.array(CostBasisLotSchema),
  observedLotCosts: z.array(z.number()),
})
export type CostBasisItem = z.infer<typeof CostBasisItemSchema>

export const CostBasisRefreshResponseSchema = z.object({
  generatedAt: z.string(),
  minPackGrams: z.number(),
  minCostUsd: z.number(),
  taxMult: z.number(),
  defaultGmBySize: SizeMapSchema,
  items: z.array(CostBasisItemSchema),
})
export type CostBasisRefreshResponse = z.infer<typeof CostBasisRefreshResponseSchema>

// ---------------------------------------------------------------------------
// Snapshot payload — what gets persisted on Save.
// ---------------------------------------------------------------------------

export const WhitegloveRowKeySchema = z.object({
  brand: z.string(),
  strainShort: z.string(),
})
export type WhitegloveRowKey = z.infer<typeof WhitegloveRowKeySchema>

export const WhitegloveBrandGmOverridesSchema = z.record(z.string(), SizeMapSchema)

export const WhitegloveRowDecisionSchema = z.object({
  brand: z.string(),
  strainShort: z.string(),
  decision: WhitegloveDecisionSchema,
})
export const WhitegloveBrandDecisionSchema = z.object({
  brand: z.string(),
  decision: WhitegloveDecisionSchema,
})

export const WhitegloveComputedRowSchema = z.object({
  brand: z.string(),
  strainShort: z.string(),
  strainDisplay: z.string(),
  perGram: z.number().nullable(),
  imputed: z.boolean(),
  sites: z.array(z.string()),
  effectiveDecision: WhitegloveDecisionSchema,
  // null when perGram is null (cannot be priced).
  prices: SizeMapSchema.nullable(),
  // GM used per size (after brand override + joint default).
  gmsApplied: SizeMapSchema,
})
export type WhitegloveComputedRow = z.infer<typeof WhitegloveComputedRowSchema>

export const WhitegloveSnapshotPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  taxMult: z.number(),
  defaultGmBySize: SizeMapSchema,
  jointGmBySize: SizeMapSchema,
  brandGmBySize: WhitegloveBrandGmOverridesSchema,
  rowDecisions: z.array(WhitegloveRowDecisionSchema),
  brandDecisions: z.array(WhitegloveBrandDecisionSchema),
  costBasis: CostBasisRefreshResponseSchema,
  computed: z.array(WhitegloveComputedRowSchema),
  note: z.string().nullable(),
})
export type WhitegloveSnapshotPayload = z.infer<typeof WhitegloveSnapshotPayloadSchema>

// Save request — client sends the inputs and the server recomputes
// `computed`, persists, and returns the same shape from getCurrent.
export const WhitegloveSnapshotSubmissionSchema = z.object({
  taxMult: z.number(),
  defaultGmBySize: SizeMapSchema,
  jointGmBySize: SizeMapSchema,
  brandGmBySize: WhitegloveBrandGmOverridesSchema,
  rowDecisions: z.array(WhitegloveRowDecisionSchema),
  brandDecisions: z.array(WhitegloveBrandDecisionSchema),
  costBasis: CostBasisRefreshResponseSchema,
  note: z.string().max(2000).nullable().optional(),
})
export type WhitegloveSnapshotSubmission = z.infer<typeof WhitegloveSnapshotSubmissionSchema>

export const WhitegloveSnapshotEnvelopeSchema = z.object({
  id: z.number().int(),
  createdAt: z.string(),
  createdBy: z.string(),
  costBasisGeneratedAt: z.string(),
  payload: WhitegloveSnapshotPayloadSchema,
})
export type WhitegloveSnapshotEnvelope = z.infer<typeof WhitegloveSnapshotEnvelopeSchema>

export const WhitegloveCurrentSnapshotResponseSchema = z.object({
  snapshot: WhitegloveSnapshotEnvelopeSchema.nullable(),
})
export type WhitegloveCurrentSnapshotResponse = z.infer<typeof WhitegloveCurrentSnapshotResponseSchema>

// ---------------------------------------------------------------------------
// Public projection — what freshlybaked.nyc/white-glove/bulk-flower
// reads. Strictly the visible menu; no cost, no GM, no provenance.
// ---------------------------------------------------------------------------

export const PublicBulkFlowerItemSchema = z.object({
  brand: z.string(),
  strain: z.string(),
  stockedAt: z.array(z.string()),
  prices: SizeMapSchema,
})
export type PublicBulkFlowerItem = z.infer<typeof PublicBulkFlowerItemSchema>

export const PublicBulkFlowerResponseSchema = z.object({
  publishedAt: z.string(),
  costBasisGeneratedAt: z.string(),
  sizes: z.array(
    z.object({
      key: WhitegloveSizeKeySchema,
      label: z.string(),
      grams: z.number(),
    }),
  ),
  items: z.array(PublicBulkFlowerItemSchema),
})
export type PublicBulkFlowerResponse = z.infer<typeof PublicBulkFlowerResponseSchema>

// ---------------------------------------------------------------------------
// Computation helpers — kept in the shared package so both the
// client editor's live preview and the server's authoritative
// computation use identical math.
// ---------------------------------------------------------------------------

/** OTD = 1.13 × cost / (1 − GM). Returns null when GM≥1. */
export function computeWhitegloveOtd(cost: number, gm: number, taxMult: number = WHITEGLOVE_TAX_MULT): number | null {
  if (gm >= 0.999) return null
  if (!Number.isFinite(cost) || cost <= 0) return null
  return (taxMult * cost) / (1 - gm)
}

/** Brand override wins over joint default; missing/zero falls back to default. */
export function pickWhitegloveGm(
  brand: string,
  size: WhitegloveSizeKey,
  jointGmBySize: { quarterLb: number; halfLb: number; lb: number },
  brandGmBySize: Record<string, { quarterLb: number; halfLb: number; lb: number }>,
): number {
  const override = brandGmBySize[brand]?.[size]
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) return override
  return jointGmBySize[size]
}

/** Brand decision is the default; row overrides only when row ≠ 'pending'. */
export function pickWhitegloveEffectiveDecision(
  rowDecision: WhitegloveDecision | undefined,
  brandDecision: WhitegloveDecision | undefined,
): WhitegloveDecision {
  if (rowDecision && rowDecision !== 'pending') return rowDecision
  return brandDecision ?? 'pending'
}
