// Server-side computation of the persisted snapshot payload. Both the
// helios editor (for live preview) and this module use the same shared
// math helpers (computeWhitegloveOtd, pickWhitegloveGm,
// pickWhitegloveEffectiveDecision). The server recomputes on save so
// the public projection is always derived from the operator's inputs
// rather than from any client-computed values.

import {
  computeWhitegloveOtd,
  pickWhitegloveEffectiveDecision,
  pickWhitegloveGm,
  WhitegloveSnapshotPayloadSchema,
  type PublicBulkFlowerResponse,
  type WhitegloveComputedRow,
  type WhitegloveSnapshotEnvelope,
  type WhitegloveSnapshotPayload,
  type WhitegloveSnapshotSubmission,
  WHITEGLOVE_SIZES,
} from '../../shared/contracts/index.js'

function roundDollars(value: number): number {
  return Math.round(value)
}

export function buildComputedRows(submission: WhitegloveSnapshotSubmission): WhitegloveComputedRow[] {
  const brandDecisionByBrand = new Map<string, 'accept' | 'reject' | 'pending'>()
  for (const bd of submission.brandDecisions) brandDecisionByBrand.set(bd.brand, bd.decision)
  const rowDecisionByKey = new Map<string, 'accept' | 'reject' | 'pending'>()
  for (const rd of submission.rowDecisions) rowDecisionByKey.set(`${rd.brand}||${rd.strainShort}`, rd.decision)

  const computed: WhitegloveComputedRow[] = []
  for (const item of submission.costBasis.items) {
    const effective = pickWhitegloveEffectiveDecision(
      rowDecisionByKey.get(`${item.brand}||${item.strainShort}`),
      brandDecisionByBrand.get(item.brand),
    )
    const gmsApplied = {
      quarterLb: pickWhitegloveGm(item.brand, 'quarterLb', submission.jointGmBySize, submission.brandGmBySize),
      halfLb: pickWhitegloveGm(item.brand, 'halfLb', submission.jointGmBySize, submission.brandGmBySize),
      lb: pickWhitegloveGm(item.brand, 'lb', submission.jointGmBySize, submission.brandGmBySize),
    }

    let prices: { quarterLb: number; halfLb: number; lb: number } | null = null
    if (typeof item.perGram === 'number' && item.perGram > 0) {
      const q = computeWhitegloveOtd(item.perGram * WHITEGLOVE_SIZES[0].grams, gmsApplied.quarterLb, submission.taxMult)
      const h = computeWhitegloveOtd(item.perGram * WHITEGLOVE_SIZES[1].grams, gmsApplied.halfLb, submission.taxMult)
      const l = computeWhitegloveOtd(item.perGram * WHITEGLOVE_SIZES[2].grams, gmsApplied.lb, submission.taxMult)
      if (q !== null && h !== null && l !== null) {
        prices = { quarterLb: roundDollars(q), halfLb: roundDollars(h), lb: roundDollars(l) }
      }
    }

    computed.push({
      brand: item.brand,
      strainShort: item.strainShort,
      strainDisplay: item.strainDisplay,
      perGram: item.perGram,
      imputed: item.imputed,
      sites: item.sites,
      effectiveDecision: effective,
      prices,
      gmsApplied,
    })
  }
  return computed
}

export function buildSnapshotPayload(submission: WhitegloveSnapshotSubmission): WhitegloveSnapshotPayload {
  const computed = buildComputedRows(submission)
  const payload: WhitegloveSnapshotPayload = {
    schemaVersion: 1,
    taxMult: submission.taxMult,
    defaultGmBySize: submission.defaultGmBySize,
    jointGmBySize: submission.jointGmBySize,
    brandGmBySize: submission.brandGmBySize,
    rowDecisions: submission.rowDecisions,
    brandDecisions: submission.brandDecisions,
    costBasis: submission.costBasis,
    computed,
    note: submission.note ?? null,
  }
  return WhitegloveSnapshotPayloadSchema.parse(payload)
}

export function buildPublicProjection(
  snapshot: WhitegloveSnapshotEnvelope,
): PublicBulkFlowerResponse {
  const items = snapshot.payload.computed
    .filter((r): r is WhitegloveComputedRow & { prices: NonNullable<WhitegloveComputedRow['prices']> } =>
      r.effectiveDecision === 'accept' && r.prices !== null,
    )
    .map((r) => ({
      brand: r.brand,
      strain: r.strainShort,
      stockedAt: r.sites,
      prices: r.prices,
    }))
    .sort((a, b) => {
      if (a.brand.toLowerCase() !== b.brand.toLowerCase())
        return a.brand.toLowerCase().localeCompare(b.brand.toLowerCase())
      return a.strain.toLowerCase().localeCompare(b.strain.toLowerCase())
    })
  return {
    publishedAt: snapshot.createdAt,
    costBasisGeneratedAt: snapshot.costBasisGeneratedAt,
    sizes: WHITEGLOVE_SIZES.map((s) => ({ key: s.key, label: s.label, grams: s.grams })),
    items,
  }
}
