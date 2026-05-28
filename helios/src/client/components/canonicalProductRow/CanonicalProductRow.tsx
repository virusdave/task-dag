// Issue #35 (slice 5) — canonical product-review row.
//
// This is the durable home for the row contract first shipped on
// /catalog/review (issue #15). Extracted verbatim from
// ReviewPage.tsx so the next reviewer surface that needs the same
// before/after comparator + canonical pricing ladder + decision bar
// can import from one place instead of forking.
//
// This slice extracts the implementation without changing behavior.
// /catalog/review consumes it directly here; migrating
// /catalog/pending-purchases to consume it is the follow-on slice
// (its row data model needs an adapter to the ReviewRow shape this
// component takes).
import { useEffect, useState } from 'react'
import { Link, useRevalidator } from 'react-router-dom'

import {
  MutationAcceptedResponseSchema,
  buildHeliosModulePath,
  type ReviewFieldComparison,
  type ReviewRow,
  type ReviewRowPricingLadder,
} from '../../../shared/contracts/index.js'
import { mutateJson } from '../../app/fetchJson.js'
import { waitForJob } from '../../app/jobPolling.js'
import { CanonicalPricingLadder } from '../CanonicalPricingLadder.js'
import { Pill } from '../Pill.js'

import { formatCurrency, rollupTone, truncateForTooltip, truncatePreview } from './formatters.js'

export interface CanonicalProductRowProps {
  row: ReviewRow
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
  }, [row.proposalRowId, row.pricingLadder?.proposedPrice, row.operatorNote])

  const pricingLine = row.lineItems.find((li) => li.fieldPath === 'products.price') ?? null

  async function handleSavePrice() {
    if (!pricingLine || proposedPrice === null) return
    setBusy(true)
    setError(null)
    try {
      await mutateJson(
        `/api/proposal-line-items/${pricingLine.lineItemId}/edit`,
        MutationAcceptedResponseSchema,
        {
          body: JSON.stringify({ editedValue: proposedPrice, expectedVersion: pricingLine.version }),
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
    // Notes are per-line-item; write to the first one so it's surfaced.
    const first = row.lineItems[0]
    if (!first) return
    setBusy(true)
    setError(null)
    try {
      await mutateJson(
        `/api/proposal-line-items/${first.lineItemId}/note`,
        MutationAcceptedResponseSchema,
        { body: JSON.stringify({ note: draftNote.trim().length === 0 ? null : draftNote }), method: 'PATCH' },
      )
      await revalidator.revalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the note.')
    } finally {
      setBusy(false)
    }
  }

  async function handleDecision(decision: 'approve' | 'reject') {
    setBusy(true)
    setError(null)
    try {
      for (const li of row.lineItems) {
        if (li.approvalStatus !== 'pending') continue
        const response = await mutateJson(
          `/api/proposal-line-items/${li.lineItemId}/${decision}`,
          MutationAcceptedResponseSchema,
          { body: JSON.stringify({ expectedVersion: li.version }), method: 'POST' },
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

  return (
    <article className="review-row-card">
      <header className="review-row-header">
        <div>
          <Link
            className="review-group-link"
            to={buildHeliosModulePath('catalog', `groups/${row.catalogGroupId}`)}
          >
            {row.rowTitle}
          </Link>
          <p className="subtle-copy">
            {row.comparisons.map((c) => c.label).join(' · ')} · catalog group #{row.catalogGroupId}
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone={rollupTone(row.approvalRollup)}>{row.approvalRollup}</Pill>
          <Pill tone={row.reconcileStatus === 'drifted' ? 'danger' : 'muted'}>{row.reconcileStatus}</Pill>
        </div>
      </header>

      <div className="comparison-grid">
        {row.comparisons.map((cmp) => (
          <ComparisonPanel cmp={cmp} key={cmp.lineItemId} />
        ))}
      </div>

      {row.pricingLadder ? (
        <PricingLadderBlock
          ladder={row.pricingLadder}
          onPriceChange={pricingLine ? setProposedPrice : undefined}
        />
      ) : (
        <p className="subtle-copy">No LitAlerts evidence cached for this SKU yet.</p>
      )}

      <label className="stack-field">
        <span>Operator note</span>
        <textarea onChange={(e) => setDraftNote(e.target.value)} rows={2} value={draftNote} />
      </label>

      <div className="inline-row wrap-row">
        {row.validationIssues.map((issue) => (
          <Pill key={`${issue.code}-${issue.detail}`} tone={issue.severity === 'error' ? 'danger' : 'warning'}>
            {issue.code}
          </Pill>
        ))}
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="inline-row wrap-row review-actions">
        {pricingLine && proposedPrice !== null ? (
          <button
            className="ghost-button"
            disabled={busy || proposedPrice === (row.pricingLadder?.proposedPrice ?? null)}
            onClick={() => void handleSavePrice()}
            type="button"
          >
            Save edit ({formatCurrency(proposedPrice)})
          </button>
        ) : null}
        <button className="ghost-button" disabled={busy} onClick={() => void handleSaveNote()} type="button">
          Save note
        </button>
        <button className="primary-button" disabled={busy} onClick={() => void handleDecision('approve')} type="button">
          Approve
        </button>
        <button className="danger-button" disabled={busy} onClick={() => void handleDecision('reject')} type="button">
          Reject
        </button>
        <Link to={buildHeliosModulePath('catalog', `review-details/proposal_row/${row.proposalRowId}`)}>
          Open details
        </Link>
      </div>

      <details className="review-row-details">
        <summary>Raw line items ({row.lineItems.length})</summary>
        <ul className="timeline-list compact-list">
          {row.lineItems.map((li) => (
            <li key={li.lineItemId}>
              <code>{li.fieldPath}</code> · v{li.version} · <em>{li.approvalStatus}</em>
            </li>
          ))}
        </ul>
      </details>
    </article>
  )
}

/**
 * Renders one live → proposed comparison cell.
 *
 * Short text values (price, taxonomy, attribute strings) render inline in a
 * three-column grid cell.
 *
 * Long-form text values (currently `changeKind === 'description'`) need much
 * more room than a normal grid cell, so they:
 *   - span the full grid row width on desktop (`.value-panel--full-row`),
 *   - collapse into a `<details>` summary on mobile (and stay closed by
 *     default) so the reviewer can scan rows without scrolling past 500-word
 *     descriptions, then expand to read the full before/after.
 *
 * The browser `title` tooltip is set to a useful "Live: … → Proposed: …"
 * preview so hovering a row gives a quick before/after even when collapsed,
 * instead of just echoing the column label.
 */
function ComparisonPanel({ cmp }: { cmp: ReviewFieldComparison }): JSX.Element {
  const liveText = cmp.liveValueText || '—'
  const proposedText = cmp.proposedValueText || '—'

  const isLongForm =
    cmp.changeKind === 'description' ||
    liveText.length > 220 ||
    proposedText.length > 220

  const tooltip = `${cmp.label}\n\nLive:\n${truncateForTooltip(liveText)}\n\nProposed:\n${truncateForTooltip(proposedText)}`

  if (!isLongForm) {
    return (
      <div className="value-panel" title={tooltip}>
        <span>{cmp.label} · live → proposed</span>
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
        <span className="value-panel__label">{cmp.label} · live → proposed</span>
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
  ladder: ReviewRowPricingLadder
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
