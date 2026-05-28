// Canonical product-review row — UI component.
//
// Renders one CanonicalProductRow (see
// helios/src/shared/contracts/domain/canonicalProductRow.ts).
//
// Source-agnostic: this component does NOT know whether the row
// came from /catalog/review's proposal pipeline, /catalog/pending-
// purchases, market-drift detection, or operator repricing. All
// approve / reject / edit / note dispatches go to URLs the row's
// `actions` object supplied, so each pipeline's server-side adapter
// chooses the right executor.
//
// State held locally:
//   - draftPrice: the proposed price the reviewer is editing via
//     the canonical pricing-ladder slider (snapped to $0.25 by the
//     slider itself). Reverted to row.pricingLadder.proposedPrice
//     whenever the row identity changes.
//   - draftNote: the operator note text the reviewer is typing.
//
// Save flows:
//   - 'Save edit' PATCHes the pricing field's editUrl (when present)
//     with { editedValue: draftPrice, expectedVersion }.
//   - 'Save note' PATCHes actions.saveNote.url (when present).
//   - 'Approve' / 'Reject' POSTs to each entry in actions.{approve,reject}Ops
//     in order, until all succeed or one fails.
import { useEffect, useState } from 'react'
import { Link, useRevalidator } from 'react-router-dom'

import {
  MutationAcceptedResponseSchema,
  type CanonicalFieldProposal,
  type CanonicalPricingLadder as CanonicalPricingLadderShape,
  type CanonicalProductRow as CanonicalProductRowType,
  type CanonicalRowApplyOp,
} from '../../../shared/contracts/index.js'
import { mutateJson } from '../../app/fetchJson.js'
import { waitForJob } from '../../app/jobPolling.js'
import { CanonicalPricingLadder } from '../CanonicalPricingLadder.js'
import { Pill } from '../Pill.js'

import { formatCurrency, rollupTone, truncateForTooltip, truncatePreview } from './formatters.js'

export interface CanonicalProductRowProps {
  row: CanonicalProductRowType
}

export function CanonicalProductRow({ row }: CanonicalProductRowProps): JSX.Element {
  const revalidator = useRevalidator()
  const [proposedPrice, setProposedPrice] = useState<number | null>(row.pricingLadder?.proposedPrice ?? null)
  const [draftNote, setDraftNote] = useState<string>(row.operatorNote ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setProposedPrice(row.pricingLadder?.proposedPrice ?? null)
    setDraftNote(row.operatorNote ?? '')
  }, [row.rowId, row.pricingLadder?.proposedPrice, row.operatorNote])

  const pricingField = row.fields.find((f) => f.changeKind === 'pricing' && f.editUrl !== null) ?? null

  async function handleSavePrice() {
    if (!pricingField || pricingField.editUrl === null || proposedPrice === null) return
    setBusy(true)
    setError(null)
    try {
      await mutateJson(
        pricingField.editUrl,
        MutationAcceptedResponseSchema,
        {
          body: JSON.stringify({ editedValue: proposedPrice, expectedVersion: pricingField.expectedVersion }),
          method: 'PATCH',
        },
      )
      await revalidator.revalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the edit.')
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveNote() {
    const saveNote = row.actions.saveNote
    if (!saveNote) return
    setBusy(true)
    setError(null)
    try {
      await mutateJson(
        saveNote.url,
        MutationAcceptedResponseSchema,
        {
          body: JSON.stringify({
            note: draftNote.trim().length === 0 ? null : draftNote,
            expectedVersion: saveNote.expectedVersion,
          }),
          method: 'PATCH',
        },
      )
      await revalidator.revalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the note.')
    } finally {
      setBusy(false)
    }
  }

  async function handleDecision(decision: 'approve' | 'reject') {
    const ops: CanonicalRowApplyOp[] = decision === 'approve' ? row.actions.approveOps : row.actions.rejectOps
    if (ops.length === 0) return
    setBusy(true)
    setError(null)
    try {
      for (const op of ops) {
        const response = await mutateJson(
          op.url,
          MutationAcceptedResponseSchema,
          { body: JSON.stringify({ expectedVersion: op.expectedVersion }), method: 'POST' },
        )
        if (response.jobId) await waitForJob(response.jobId)
      }
      await revalidator.revalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not ${decision}.`)
    } finally {
      setBusy(false)
    }
  }

  const headerSubtitle =
    row.fields.map((f) => f.label).join(' · ') +
    (row.catalogGroupId !== null ? ` · catalog group #${row.catalogGroupId}` : '')

  return (
    <article className="review-row-card">
      <header className="review-row-header">
        <div>
          {row.catalogGroupId !== null ? (
            <Link className="review-group-link" to={`/catalog/groups/${row.catalogGroupId}`}>
              {row.rowTitle}
            </Link>
          ) : (
            <strong>{row.rowTitle}</strong>
          )}
          <p className="subtle-copy">{headerSubtitle}</p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone={rollupTone(row.approvalRollup)}>{row.approvalRollup}</Pill>
          <Pill tone={row.reconcileStatus === 'drifted' ? 'danger' : 'muted'}>{row.reconcileStatus}</Pill>
          {row.mso?.isMSOBrand ? <Pill tone="warning">MSO</Pill> : null}
        </div>
      </header>

      <div className="comparison-grid">
        {row.fields.map((field) => (
          <FieldComparisonPanel field={field} key={`${row.rowId}-${field.fieldPath}-${field.label}`} />
        ))}
      </div>

      {row.pricingLadder ? (
        <PricingLadderBlock
          ladder={row.pricingLadder}
          onPriceChange={pricingField ? setProposedPrice : undefined}
        />
      ) : (
        <p className="subtle-copy">No LitAlerts evidence cached for this SKU yet.</p>
      )}

      {row.actions.saveNote !== null ? (
        <label className="stack-field">
          <span>Operator note</span>
          <textarea onChange={(e) => setDraftNote(e.target.value)} rows={2} value={draftNote} />
        </label>
      ) : null}

      <ExecutionPreviewPanel preview={row.executionPreview} />

      <div className="inline-row wrap-row">
        {row.validationIssues.map((issue) => (
          <Pill key={`${issue.code}-${issue.detail}`} tone={issue.severity === 'error' ? 'danger' : 'warning'}>
            {issue.code}
          </Pill>
        ))}
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="inline-row wrap-row review-actions">
        {pricingField && proposedPrice !== null ? (
          <button
            className="ghost-button"
            disabled={busy || proposedPrice === (row.pricingLadder?.proposedPrice ?? null)}
            onClick={() => void handleSavePrice()}
            type="button"
          >
            Save edit ({formatCurrency(proposedPrice)})
          </button>
        ) : null}
        {row.actions.saveNote !== null ? (
          <button className="ghost-button" disabled={busy} onClick={() => void handleSaveNote()} type="button">
            Save note
          </button>
        ) : null}
        {row.actions.approveOps.length > 0 ? (
          <button className="primary-button" disabled={busy} onClick={() => void handleDecision('approve')} type="button">
            Approve
          </button>
        ) : null}
        {row.actions.rejectOps.length > 0 ? (
          <button className="danger-button" disabled={busy} onClick={() => void handleDecision('reject')} type="button">
            Reject
          </button>
        ) : null}
        {row.actions.detailsUrl !== null ? (
          <Link to={row.actions.detailsUrl}>Open details</Link>
        ) : null}
      </div>

      <details className="review-row-details">
        <summary>Row provenance ({row.source.kind})</summary>
        <ul className="timeline-list compact-list">
          <li><code>row.id</code> · {row.rowId}</li>
          <li><code>source</code> · {JSON.stringify(row.source)}</li>
          {row.fields.map((f) => (
            <li key={`${f.fieldPath}-${f.label}`}>
              <code>{f.fieldPath}</code> · v{f.expectedVersion} · <em>{f.approvalStatus}</em>
            </li>
          ))}
        </ul>
      </details>
    </article>
  )
}

/**
 * One live → proposed comparison cell. See the older inline doc in
 * ReviewPage history for the long-form / short-form rationale.
 */
function FieldComparisonPanel({ field }: { field: CanonicalFieldProposal }): JSX.Element {
  const liveText = field.liveValueText || '—'
  const proposedText = field.proposedValueText || '—'

  const isLongForm =
    field.changeKind === 'description' ||
    liveText.length > 220 ||
    proposedText.length > 220

  const tooltip = `${field.label}\n\nLive:\n${truncateForTooltip(liveText)}\n\nProposed:\n${truncateForTooltip(proposedText)}`

  if (!isLongForm) {
    return (
      <div className="value-panel" title={tooltip}>
        <span>{field.label} · live → proposed</span>
        <p>
          <span className="subtle-copy">{liveText}</span>{' '}
          →{' '}
          <strong>{proposedText}</strong>
        </p>
      </div>
    )
  }

  return (
    <details className="value-panel value-panel--full-row value-panel--long-form" title={tooltip}>
      <summary>
        <span className="value-panel__label">{field.label} · live → proposed</span>
        <span className="value-panel__preview">
          <span className="subtle-copy">{truncatePreview(liveText)}</span>{' '}
          →{' '}
          <strong>{truncatePreview(proposedText)}</strong>
        </span>
      </summary>
      <div className="value-panel__long-body">
        <div className="value-panel__column">
          <h4>Live</h4>
          <p className="long-form-text">{liveText}</p>
        </div>
        <div className="value-panel__column">
          <h4>Proposed</h4>
          <p className="long-form-text">{proposedText}</p>
        </div>
      </div>
    </details>
  )
}

function PricingLadderBlock({
  ladder,
  onPriceChange,
}: {
  ladder: CanonicalPricingLadderShape
  onPriceChange?: (next: number) => void
}) {
  const headHtml = ladder.livePrice !== null
    ? `<span class="metric">Live ${formatCurrency(ladder.livePrice)}</span>`
    : ''
  return (
    <div className="review-pricing-ladder-block">
      <CanonicalPricingLadder
        productId={ladder.productId}
        livePrice={ladder.livePrice}
        proposedPrice={ladder.proposedPrice}
        marketAveragePostTax={ladder.marketAveragePostTax}
        marketMedianPostTax={ladder.marketMedianPostTax}
        competitorListings={ladder.competitorListings.map((l, i) => ({
          listingId: `${l.dispensaryName}-${l.listingName}-${i}`,
          postTaxPrice: l.postTaxPrice,
          distanceMiles: l.distanceMiles,
          dispensaryName: l.dispensaryName,
          listingName: l.listingName,
          dispensaryAddress: null,
          url: l.url,
          eligibleForPricing: l.eligibleForPricing,
        }))}
        variant="detail"
        headHtml={headHtml}
        freshness={ladder.evidenceFreshness}
        onProposedPriceChange={onPriceChange}
      />
    </div>
  )
}

// Tiny preview chip strip — surfaces what 'approve + apply' would
// actually do so the reviewer isn't surprised. Source-pipeline-
// supplied via ExecutionPreviewSchema.
function ExecutionPreviewPanel({ preview }: { preview: CanonicalProductRowType['executionPreview'] }): JSX.Element | null {
  const hasContent =
    preview.mechanism !== 'no_op' ||
    preview.warnings.length > 0 ||
    preview.needsNewBrand ||
    preview.needsNewGroup ||
    preview.needsNewVariant
  if (!hasContent) return null

  return (
    <div className="inline-row wrap-row execution-preview" title={preview.summary}>
      <Pill tone="muted">{mechanismLabel(preview.mechanism)}</Pill>
      {preview.needsNewBrand ? <Pill tone="warning">new brand</Pill> : null}
      {preview.needsNewGroup ? <Pill tone="warning">new group</Pill> : null}
      {preview.needsNewVariant ? <Pill tone="warning">new variant</Pill> : null}
      {preview.warnings.map((w) => (
        <Pill key={w} tone="danger">{w}</Pill>
      ))}
      <span className="subtle-copy">{preview.summary}</span>
    </div>
  )
}

function mechanismLabel(m: CanonicalProductRowType['executionPreview']['mechanism']): string {
  switch (m) {
    case 'direct_catalog_write':
      return 'catalog write'
    case 'price_via_promo_action':
      return 'promo action'
    case 'create_new_catalog_entities':
      return 'create catalog entities'
    case 'mixed':
      return 'mixed executors'
    case 'no_op':
      return 'no-op'
  }
}
