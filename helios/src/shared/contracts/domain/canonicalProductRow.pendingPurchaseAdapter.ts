// Adapter: PendingPurchaseRow (pending_purchase source) → CanonicalProductRow.
//
// Sibling of canonicalProductRow.proposalAdapter.ts. Maps the
// /catalog/pending-purchases data model onto the source-agnostic
// canonical row contract introduced in slice 6 (e3ebc9a).
//
// Status: ADAPTER ONLY (issue #35 slice 4c.1).
//   This file is a pure data mapper. The /catalog/pending-purchases
//   page does NOT yet render via CanonicalProductRow — that's slice
//   4c.3. Landing the adapter ahead of the UI cutover means the
//   pp → canonical mapping is reviewable in isolation, with unit
//   coverage, and the data-model gaps between PendingPurchaseRow
//   and the canonical contract are nailed down before they have to
//   be reconciled at the UI layer.
//
// Outstanding contract gaps the UI cutover (4c.3) still has to solve:
//
//   1. APPROVE / REJECT BODY SHAPE.
//      The pp approval endpoint is a single URL
//      (POST /api/catalog/pending-purchases/:rowId/approval) that
//      discriminates approve-vs-reject via an `approvalStatus`
//      field IN THE BODY, not in the URL. CanonicalRowApplyOp today
//      only carries { url, expectedVersion } and the UI sends
//      { expectedVersion } as the POST body — there's no slot for
//      pipeline-specific body fields like `approvalStatus`.
//      The minimal contract extension is to add an optional
//      `body?: Record<string, unknown>` field to
//      CanonicalRowApplyOpSchema; the canonical UI would merge it
//      with { expectedVersion } when dispatching. Proposal-row
//      consumers wouldn't set it and behavior would be unchanged.
//      Until that lands, approveOps / rejectOps here record the URL
//      + version, but a thin server-side shim route (e.g.
//      /api/catalog/pending-purchases/:rowId/approval/{approve,
//      reject}) OR the body extension is required before the UI
//      can actually dispatch.
//
//   2. PER-FIELD EDIT BODY KEYS.
//      The pp edit endpoint (PATCH /api/catalog/pending-purchases/:rowId)
//      takes named body keys (editedProposedPrice,
//      editedProposedDescription, editedPrimaryImageUrl, …) rather
//      than the canonical { editedValue, expectedVersion } shape.
//      Same fix as (1): either an `editBodyKey` discriminator on
//      CanonicalFieldProposalSchema (default 'editedValue'), OR
//      new per-field shim routes. Until then we leave field.editUrl
//      = null so the canonical UI treats the field as read-only;
//      the existing pp-page-side editors stay authoritative.
//
//   3. STRUCTURED-FIELDS OVERRIDE PANEL.
//      The 9-key structured-fields override map (brand / group /
//      category / subcategory / size / pack / variant / variantTab /
//      strain) doesn't fit CanonicalFieldProposal — FieldPathSchema
//      only enumerates 'description' and 'products.price' today,
//      and the override panel is a single composite editor, not
//      nine independent live→proposed cells. The shared override
//      panel module already lives at
//      client/components/canonicalProductRow/structuredOverrides.tsx
//      (slice 4b.2 / 018157d); the UI cutover needs to render it
//      as an explicit slot on CanonicalProductRow, NOT shoehorn it
//      through `fields`. We surface the effective taxonomy in
//      `family` (so family-grouping keeps working) and leave the
//      override panel to the host page until the slot lands.
//
// Once those three gaps are reconciled, PendingPurchaseRowCard can
// be replaced by <CanonicalProductRow row={pendingPurchaseToCanonicalRow(row)} />
// plus the structured-overrides slot.

import type {
  CanonicalFieldProposal,
  CanonicalPricingLadder,
  CanonicalProductRow,
  CanonicalRowApplyOp,
  ExecutionMechanism,
  ExecutionPreview,
} from './canonicalProductRow.js'
import type { PendingPurchaseRow } from './pendingPurchases.js'

const PENDING_PURCHASE_BASE = '/api/catalog/pending-purchases'

function rowUrl(rowId: number, suffix?: 'approval'): string {
  return suffix ? `${PENDING_PURCHASE_BASE}/${rowId}/${suffix}` : `${PENDING_PURCHASE_BASE}/${rowId}`
}

/**
 * Read the reviewer-effective value of a taxonomy key, preferring
 * the structured-fields override JSONB over the parser-supplied
 * column. Mirrors the resolution that the apply worker does at
 * loadPendingPurchaseRow time (see effectiveStructuredFields in
 * the apply path, issue #35 slice 1 / 963f79f).
 */
function effectiveStructuredString(
  override: string | null | undefined,
  parser: string | null,
): string | null {
  if (override !== undefined) {
    return override
  }
  return parser
}

function effectiveStructuredNumber(
  override: number | null | undefined,
  parser: number | null,
): number | null {
  if (override !== undefined) {
    return override
  }
  return parser
}

function buildFamily(row: PendingPurchaseRow): CanonicalProductRow['family'] {
  const overrides = row.editedStructuredFields ?? null
  return {
    brand: effectiveStructuredString(overrides?.targetBrand, row.targetBrand),
    category: effectiveStructuredString(overrides?.expectedCategory, row.expectedCategory),
    subcategory: effectiveStructuredString(overrides?.expectedSubcategory, row.expectedSubcategory),
    sizeName: effectiveStructuredString(overrides?.targetSize, row.targetSize),
  }
}

function buildExecutionPreview(row: PendingPurchaseRow): ExecutionPreview {
  const willCreateNewEntities =
    row.needsNewBrand || row.needsNewGroup || row.needsNewVariant
  const mechanism: ExecutionMechanism = willCreateNewEntities
    ? 'create_new_catalog_entities'
    : row.catalogAction === 'no_op'
      ? 'no_op'
      : 'direct_catalog_write'

  const warnings: string[] = []
  if (row.lastApplyError) {
    warnings.push(row.lastApplyError)
  }
  for (const flag of row.reviewFlags) {
    warnings.push(flag)
  }

  const summary = (() => {
    if (willCreateNewEntities) {
      const newish: string[] = []
      if (row.needsNewBrand) newish.push('brand')
      if (row.needsNewGroup) newish.push('group')
      if (row.needsNewVariant) newish.push('variant')
      return `Apply pending-purchase row · creates new ${newish.join(' + ')} in Sweed.`
    }
    if (row.catalogAction === 'no_op') {
      return 'Apply pending-purchase row · no Sweed catalog change.'
    }
    return `Apply pending-purchase row · ${row.catalogAction}.`
  })()

  return {
    mechanism,
    summary,
    needsNewBrand: row.needsNewBrand,
    needsNewGroup: row.needsNewGroup,
    needsNewVariant: row.needsNewVariant,
    warnings,
  }
}

function buildPricingLadder(row: PendingPurchaseRow): CanonicalPricingLadder | null {
  if (row.reuseProductId === null) {
    // No bound Sweed product (yet) — there's no canonical price
    // surface to render against. The pp page falls back to a
    // text-only display in that case; the canonical row can too.
    return null
  }
  const hasMarketEvidence =
    row.marketListings.length > 0 ||
    row.averageCompetitorPostTaxPrice !== null ||
    row.marketMedianPostTaxPrice !== null
  return {
    productId: row.reuseProductId,
    livePrice: row.currentPrice,
    proposedPrice: row.effectiveProposedPrice,
    marketAveragePostTax: row.averageCompetitorPostTaxPrice,
    marketMedianPostTax: row.marketMedianPostTaxPrice,
    competitorListings: row.marketListings,
    // pp rows don't record evidence-freshness explicitly today;
    // 'fresh' vs 'absent' is the only signal we can derive from
    // the row shape alone. A future enhancement could thread the
    // market-fetch timestamp through.
    evidenceFreshness: hasMarketEvidence ? 'fresh' : 'absent',
    evidenceCapturedAt: null,
    priceSpread: null,
  }
}

function buildFields(row: PendingPurchaseRow): CanonicalFieldProposal[] {
  const fields: CanonicalFieldProposal[] = []

  // Pricing field. editUrl left null until per-field edit body
  // shape is reconciled (gap #2 in the file header). The pricing-
  // ladder block above is the primary edit surface anyway.
  if (row.proposedPrice !== null || row.currentPrice !== null) {
    const live = row.currentPrice !== null ? formatPrice(row.currentPrice) : '—'
    const proposed = row.proposedPrice !== null ? formatPrice(row.proposedPrice) : '—'
    const effective = row.effectiveProposedPrice !== null ? formatPrice(row.effectiveProposedPrice) : '—'
    fields.push({
      fieldPath: 'products.price',
      label: 'Price',
      changeKind: 'pricing',
      liveValueText: live,
      proposedValueText: proposed,
      effectiveValueText: effective,
      approvalStatus: mapApprovalStatus(row.approvalStatus),
      validationIssues: [],
      editUrl: null,
      expectedVersion: row.version,
    })
  }

  // Description field. Same gap-#2 caveat as pricing.
  if (row.proposedDescription !== null || row.currentDescription !== null) {
    fields.push({
      fieldPath: 'description',
      label: 'Description',
      changeKind: 'description',
      liveValueText: row.currentDescription ?? '—',
      proposedValueText: row.proposedDescription ?? '—',
      effectiveValueText: row.effectiveProposedDescription ?? row.proposedDescription ?? '—',
      approvalStatus: mapApprovalStatus(row.approvalStatus),
      validationIssues: [],
      editUrl: null,
      expectedVersion: row.version,
    })
  }

  return fields
}

function buildActions(row: PendingPurchaseRow): CanonicalProductRow['actions'] {
  // approveOps / rejectOps point at the single pp approval endpoint
  // for now. Gap #1 (file header) tracks the body-shape mismatch:
  // the canonical UI POSTs { expectedVersion } but the pp endpoint
  // also needs an `approvalStatus` discriminator. Until the
  // CanonicalRowApplyOp `body` extension lands (or per-decision
  // shim routes are added), the UI consuming these ops will not
  // succeed at dispatch — the adapter is correct in URL + version,
  // not yet in body shape.
  const approvalUrl = rowUrl(row.rowId, 'approval')
  const approveOps: CanonicalRowApplyOp[] = row.approvalStatus === 'pending'
    ? [{ url: approvalUrl, expectedVersion: row.version }]
    : []
  const rejectOps: CanonicalRowApplyOp[] = row.approvalStatus === 'pending'
    ? [{ url: approvalUrl, expectedVersion: row.version }]
    : []

  // Notes are stored via the same PATCH row endpoint. Gap #2:
  // canonical UI sends { note, expectedVersion } but the pp PATCH
  // expects { notes, expectedVersion }. Pre-cutover the host page
  // owns notes; once the body-key extension lands this hooks up.
  const saveNote: CanonicalRowApplyOp = {
    url: rowUrl(row.rowId),
    expectedVersion: row.version,
  }

  return {
    approveOps,
    rejectOps,
    saveNote,
    detailsUrl: `/catalog/pending-purchases?packetId=${row.packetId}&rowId=${row.rowId}`,
  }
}

function mapApprovalStatus(
  status: PendingPurchaseRow['approvalStatus'],
): CanonicalFieldProposal['approvalStatus'] {
  // pp rows only ever use {pending, approved, rejected}; 'superseded'
  // is proposal-row-specific. The canonical schema accepts all four
  // because proposal_row sources need it.
  return status
}

function mapApprovalRollup(
  status: PendingPurchaseRow['approvalStatus'],
): CanonicalProductRow['approvalRollup'] {
  return status
}

function buildReconcileStatus(row: PendingPurchaseRow): string {
  // /catalog/review's `reconcileStatus` is a one-token summary of
  // 'is the proposed state still consistent with current Sweed?'.
  // For pp rows the closest analogue is the apply lifecycle:
  // not_requested / queued / running / succeeded / failed. Surface
  // the apply status so the canonical pill shows whether the row
  // has been applied yet.
  return row.lastApplyStatus
}

function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`
}

/**
 * Convert one PendingPurchaseRow to the source-agnostic canonical
 * row contract. See file header for the three open contract gaps
 * that the UI cutover still has to reconcile before this output
 * can actually drive <CanonicalProductRow />.
 */
export function pendingPurchaseToCanonicalRow(row: PendingPurchaseRow): CanonicalProductRow {
  return {
    rowId: `pp:${row.rowId}`,
    source: {
      kind: 'pending_purchase',
      packetId: row.packetId,
      rowId: row.rowId,
    },
    catalogGroupId: row.reuseGroupId,
    rowTitle: row.distributorProductName,
    family: buildFamily(row),
    // pp-side MSO annotation isn't computed yet. The /catalog/review
    // side computes it from a cached brand-list; the equivalent
    // server-side hook for pp would query the same cache keyed by
    // the *effective* (post-override) brand. Out of scope for this
    // slice; null is the contract's documented 'not computed' value.
    mso: null,
    approvalRollup: mapApprovalRollup(row.approvalStatus),
    reconcileStatus: buildReconcileStatus(row),
    fields: buildFields(row),
    pricingLadder: buildPricingLadder(row),
    validationIssues: [],
    operatorNote: row.notes,
    actions: buildActions(row),
    executionPreview: buildExecutionPreview(row),
  }
}
