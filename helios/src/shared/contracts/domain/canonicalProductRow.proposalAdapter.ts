// Adapter: ReviewRow (proposal-row source) → CanonicalProductRow.
//
// /catalog/review's loader emits ReviewRow today. This adapter is
// the boundary between the proposal-specific shape and the
// source-agnostic canonical contract so the UI only has to know
// about CanonicalProductRow.
//
// When a new ingestion pipeline lands, write a sibling adapter
// (pendingPurchaseToCanonicalRow, marketDriftToCanonicalRow, …)
// that returns the same shape. The UI is unchanged.

import type {
  CanonicalFieldChangeKind,
  CanonicalFieldProposal,
  CanonicalProductRow,
  CanonicalRowApplyOp,
  ExecutionPreview,
} from './canonicalProductRow.js'
import type {
  ReviewFamilyKey,
  ReviewFamilyMSOAnnotation,
  ReviewFieldComparison,
  ReviewRow,
} from '../api/review.js'

// /api/proposal-line-items/:lineItemId/{approve,reject,edit,note}
// — the proposal-row pipeline's executor endpoints. Hard-coded here
// because they're the contract the helios server already exposes;
// the canonical-row consumer doesn't need to know they exist.
function proposalLineItemUrl(lineItemId: number, suffix: 'approve' | 'reject' | 'edit' | 'note'): string {
  return `/api/proposal-line-items/${lineItemId}/${suffix}`
}

export function reviewRowToCanonicalRow(
  row: ReviewRow,
  family: ReviewFamilyKey,
  mso: ReviewFamilyMSOAnnotation | null,
): CanonicalProductRow {
  const fields: CanonicalFieldProposal[] = row.comparisons.map((cmp) => {
    const lineItem = row.lineItems.find((li) => li.lineItemId === cmp.lineItemId)
    return {
      fieldPath: cmp.fieldPath,
      label: cmp.label,
      changeKind: mapChangeKind(cmp.changeKind),
      liveValueText: cmp.liveValueText,
      proposedValueText: cmp.proposedValueText,
      effectiveValueText: cmp.effectiveValueText,
      approvalStatus: cmp.approvalStatus,
      validationIssues: [],
      // Every proposal line item is editable via /edit (price slider,
      // description redactor, etc.); the UI decides which fields to
      // show an inline editor for based on changeKind.
      editUrl: proposalLineItemUrl(cmp.lineItemId, 'edit'),
      expectedVersion: lineItem?.version ?? 1,
    }
  })

  // For the proposal model, row-level approve/reject fans out one
  // POST per pending line item. The canonical contract carries that
  // list as approveOps / rejectOps so the UI doesn't need to know
  // about line items.
  const pendingLineItems = row.lineItems.filter((li) => li.approvalStatus === 'pending')
  const approveOps: CanonicalRowApplyOp[] = pendingLineItems.map((li) => ({
    url: proposalLineItemUrl(li.lineItemId, 'approve'),
    expectedVersion: li.version,
  }))
  const rejectOps: CanonicalRowApplyOp[] = pendingLineItems.map((li) => ({
    url: proposalLineItemUrl(li.lineItemId, 'reject'),
    expectedVersion: li.version,
  }))

  // Notes are written to the first line item (current /catalog/review
  // behavior). Future server-side row-level note endpoint would
  // collapse this into a single op.
  const firstLine = row.lineItems[0]
  const saveNote: CanonicalRowApplyOp | null = firstLine
    ? { url: proposalLineItemUrl(firstLine.lineItemId, 'note'), expectedVersion: firstLine.version }
    : null

  // Proposal rows in the current system always dispatch to the
  // direct catalog writer. (When the promo-vs-catalog executor split
  // lands, this preview will key off the pipeline's recommendation.)
  const executionPreview: ExecutionPreview = {
    mechanism: 'direct_catalog_write',
    summary: `Apply ${row.comparisons.length} field change${row.comparisons.length === 1 ? '' : 's'} to catalog group #${row.catalogGroupId}.`,
    needsNewBrand: false,
    needsNewGroup: false,
    needsNewVariant: false,
    warnings: [],
  }

  return {
    rowId: `prop:${row.proposalRowId}`,
    source: {
      kind: 'proposal_row',
      proposalRowId: row.proposalRowId,
      batchId: null,
    },
    catalogGroupId: row.catalogGroupId,
    rowTitle: row.rowTitle,
    family,
    mso,
    approvalRollup: row.approvalRollup,
    reconcileStatus: row.reconcileStatus,
    fields,
    pricingLadder: row.pricingLadder,
    validationIssues: row.validationIssues,
    operatorNote: row.operatorNote,
    actions: {
      approveOps,
      rejectOps,
      saveNote,
      detailsUrl: `/catalog/review-details/proposal_row/${row.proposalRowId}`,
    },
    executionPreview,
  }
}

// ReviewFieldComparison.changeKind has an 'other' the canonical
// schema also accepts; the mapping is identity but typed through
// CanonicalFieldChangeKind so any future drift between the two
// enums is a compiler error here.
function mapChangeKind(kind: ReviewFieldComparison['changeKind']): CanonicalFieldChangeKind {
  switch (kind) {
    case 'pricing':
      return 'pricing'
    case 'description':
      return 'description'
    case 'taxonomy':
      return 'taxonomy'
    case 'attribute':
      return 'attribute'
    case 'other':
      return 'other'
  }
}
