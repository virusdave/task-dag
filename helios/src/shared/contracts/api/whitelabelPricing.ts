// API contracts for the helios Catalog→WhiteLabel→Pricing editor and
// the public freshlybaked.nyc/white-label/bulk-flower menu it feeds.
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

export const WHITELABEL_TAX_MULT = 1.13
export const WHITELABEL_MIN_PACK_GRAMS = 14
export const WHITELABEL_MIN_COST_USD = 1.0

export const WhitelabelDecisionSchema = z.enum(['accept', 'reject', 'pending'])
export type WhitelabelDecision = z.infer<typeof WhitelabelDecisionSchema>

export const WhitelabelSizeKeySchema = z.enum(['quarterLb', 'halfLb', 'lb'])
export type WhitelabelSizeKey = z.infer<typeof WhitelabelSizeKeySchema>

export interface WhitelabelSizeSpec {
  readonly key: WhitelabelSizeKey
  readonly label: string
  readonly grams: number
  readonly defaultGm: number
}

export const WHITELABEL_SIZES: readonly WhitelabelSizeSpec[] = [
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

export const WhitelabelRowKeySchema = z.object({
  brand: z.string(),
  strainShort: z.string(),
})
export type WhitelabelRowKey = z.infer<typeof WhitelabelRowKeySchema>

export const WhitelabelBrandGmOverridesSchema = z.record(z.string(), SizeMapSchema)

export const WhitelabelRowDecisionSchema = z.object({
  brand: z.string(),
  strainShort: z.string(),
  decision: WhitelabelDecisionSchema,
})
export const WhitelabelBrandDecisionSchema = z.object({
  brand: z.string(),
  decision: WhitelabelDecisionSchema,
})

export const WhitelabelComputedRowSchema = z.object({
  brand: z.string(),
  strainShort: z.string(),
  strainDisplay: z.string(),
  perGram: z.number().nullable(),
  imputed: z.boolean(),
  sites: z.array(z.string()),
  effectiveDecision: WhitelabelDecisionSchema,
  // null when perGram is null (cannot be priced).
  prices: SizeMapSchema.nullable(),
  // GM used per size (after brand override + joint default).
  gmsApplied: SizeMapSchema,
})
export type WhitelabelComputedRow = z.infer<typeof WhitelabelComputedRowSchema>

export const WhitelabelSnapshotPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  taxMult: z.number(),
  defaultGmBySize: SizeMapSchema,
  jointGmBySize: SizeMapSchema,
  brandGmBySize: WhitelabelBrandGmOverridesSchema,
  rowDecisions: z.array(WhitelabelRowDecisionSchema),
  brandDecisions: z.array(WhitelabelBrandDecisionSchema),
  costBasis: CostBasisRefreshResponseSchema,
  computed: z.array(WhitelabelComputedRowSchema),
  note: z.string().nullable(),
})
export type WhitelabelSnapshotPayload = z.infer<typeof WhitelabelSnapshotPayloadSchema>

// Save request — client sends the inputs and the server recomputes
// `computed`, persists, and returns the same shape from getCurrent.
export const WhitelabelSnapshotSubmissionSchema = z.object({
  taxMult: z.number(),
  defaultGmBySize: SizeMapSchema,
  jointGmBySize: SizeMapSchema,
  brandGmBySize: WhitelabelBrandGmOverridesSchema,
  rowDecisions: z.array(WhitelabelRowDecisionSchema),
  brandDecisions: z.array(WhitelabelBrandDecisionSchema),
  costBasis: CostBasisRefreshResponseSchema,
  note: z.string().max(2000).nullable().optional(),
})
export type WhitelabelSnapshotSubmission = z.infer<typeof WhitelabelSnapshotSubmissionSchema>

export const WhitelabelSnapshotEnvelopeSchema = z.object({
  id: z.number().int(),
  createdAt: z.string(),
  createdBy: z.string(),
  costBasisGeneratedAt: z.string(),
  payload: WhitelabelSnapshotPayloadSchema,
})
export type WhitelabelSnapshotEnvelope = z.infer<typeof WhitelabelSnapshotEnvelopeSchema>

export const WhitelabelCurrentSnapshotResponseSchema = z.object({
  snapshot: WhitelabelSnapshotEnvelopeSchema.nullable(),
})
export type WhitelabelCurrentSnapshotResponse = z.infer<typeof WhitelabelCurrentSnapshotResponseSchema>

// ---------------------------------------------------------------------------
// Public projection — what freshlybaked.nyc/white-label/bulk-flower
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
      key: WhitelabelSizeKeySchema,
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
export function computeWhitelabelOtd(cost: number, gm: number, taxMult: number = WHITELABEL_TAX_MULT): number | null {
  if (gm >= 0.999) return null
  if (!Number.isFinite(cost) || cost <= 0) return null
  return (taxMult * cost) / (1 - gm)
}

/** Brand override wins over joint default; missing/zero falls back to default. */
export function pickWhitelabelGm(
  brand: string,
  size: WhitelabelSizeKey,
  jointGmBySize: { quarterLb: number; halfLb: number; lb: number },
  brandGmBySize: Record<string, { quarterLb: number; halfLb: number; lb: number }>,
): number {
  const override = brandGmBySize[brand]?.[size]
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) return override
  return jointGmBySize[size]
}

/** Brand decision is the default; row overrides only when row ≠ 'pending'. */
export function pickWhitelabelEffectiveDecision(
  rowDecision: WhitelabelDecision | undefined,
  brandDecision: WhitelabelDecision | undefined,
): WhitelabelDecision {
  if (rowDecision && rowDecision !== 'pending') return rowDecision
  return brandDecision ?? 'pending'
}
