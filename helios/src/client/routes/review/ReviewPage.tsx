/**
 * `/catalog/review` — canonical family-grouped review queue.
 *
 * Issue #15. Replaces the legacy "Compact Approval Queue" with a
 * family-grouped queue rendered against the canonical product-review
 * row contract documented at `docs/helios/canonical-review-row/`.
 *
 * Each family panel is a brand × category × subcategory × size band
 * carrying one row per family member. Each row shows live-vs-proposed
 * side-by-side, the canonical pricing-ladder prepopulated with the
 * latest cached LitAlerts evidence, and an attached slider for proposed
 * price (snapped to $0.25). Family headers carry roll-up approve/reject.
 */
import { useEffect, useMemo, useState } from 'react'
import { Form, Link, useLoaderData, useRevalidator } from 'react-router-dom'

import {
  MutationAcceptedResponseSchema,
  ReviewFamilyQueueResponseSchema,
  buildHeliosModulePath,
  type ReviewFamily,
  type ReviewFamilyQueueResponse,
  type ReviewFieldComparison,
  type ReviewRow,
  type ReviewRowLineItemHandle,
  type ReviewRowPricingLadder,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { waitForJob } from '../../app/jobPolling.js'
import { CanonicalPricingLadder } from '../../components/CanonicalPricingLadder.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from '../catalog/catalogSidebarSubtree.js'

export async function reviewLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/review/family-queue${url.search}`, ReviewFamilyQueueResponseSchema)
}

export function ReviewPage() {
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as ReviewFamilyQueueResponse

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Review queue</p>
          <h2>{data.totalFamilyCount} families · {data.totalRowCount} rows pending</h2>
        </div>
        <Form className="filter-row" method="get">
          <input defaultValue={data.filters.search ?? ''} name="search" placeholder="Search group or brand" />
          <select defaultValue={data.filters.proposalType ?? ''} name="proposalType">
            <option value="">All proposal types</option>
            <option value="pricing">Pricing</option>
            <option value="description">Description</option>
          </select>
          <select defaultValue={data.filters.approvalStatus ?? ''} name="approvalStatus">
            <option value="">Pending (default)</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
          <label className="inline-row">
            <input
              defaultChecked={data.filters.driftOnly ?? false}
              name="driftOnly"
              type="checkbox"
              value="true"
            />
            <span>Drifted only</span>
          </label>
          <label className="inline-row">
            <input
              defaultChecked={data.filters.msoOnly ?? false}
              name="msoOnly"
              type="checkbox"
              value="true"
            />
            <span>MSO only</span>
          </label>
          <button className="ghost-button" type="submit">Filter</button>
        </Form>
      </div>

      {data.families.length === 0 ? (
        <p className="subtle-copy">No families match the current filters.</p>
      ) : (
        <div className="review-family-stack">
          {data.families.map((family) => (
            <FamilyPanel family={family} key={familyKeyString(family)} />
          ))}
        </div>
      )}

      <details className="review-page-about">
        <summary>About this page</summary>
        <p>
          Families group catalog rows by (brand × category × subcategory ×
          size). Within a family, rows are ordered drift-first, then by
          price spread. Across families: drifted first, then MSO, then
          largest market spread.
        </p>
        <p>
          The pricing ladder for each row is prepopulated from the most
          recent cached LitAlerts competitor observation for that SKU.
          Drag the proposed marker to adjust price — it snaps to the
          nearest $0.25 — then click <strong>Save edit</strong> to write
          back to the proposal line item.
        </p>
        <p>
          See <Link to="https://github.com/FreshlyBakedNYC/automation/blob/master/docs/helios/canonical-review-row/README.md" target="_blank">the canonical-review-row design doc</Link>{' '}
          for the full row contract this surface implements.
        </p>
      </details>
    </section>
  )
}

function familyKeyString(family: ReviewFamily): string {
  const k = family.familyKey
  return [k.brand ?? '∅', k.category ?? '∅', k.subcategory ?? '∅', k.sizeName ?? '∅'].join('|')
}

function FamilyPanel({ family }: { family: ReviewFamily }) {
  const revalidator = useRevalidator()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const familyLabel = useMemo(() => {
    const k = family.familyKey
    const parts = [k.brand, k.category, k.subcategory, k.sizeName].filter(
      (v): v is string => !!v && v.trim().length > 0,
    )
    return parts.length > 0 ? parts.join(' · ') : 'Unattributed family'
  }, [family.familyKey])

  const spreadLabel = family.ordering.maxPriceSpread !== null
    ? `spread ${formatCurrency(family.ordering.maxPriceSpread)}`
    : null

  async function handleBulk(decision: 'approve' | 'reject') {
    setBusy(true)
    setError(null)
    const pending: ReviewRowLineItemHandle[] = []
    for (const row of family.rows) {
      for (const li of row.lineItems) {
        if (li.approvalStatus === 'pending') pending.push(li)
      }
    }
    if (pending.length === 0) {
      setBusy(false)
      return
    }
    try {
      // Fan-out sequentially to make partial-failure handling simple;
      // each call is small and the family panel rarely has > ~20 rows.
      for (const li of pending) {
        const response = await mutateJson(
          `/api/proposal-line-items/${li.lineItemId}/${decision}`,
          MutationAcceptedResponseSchema,
          { body: JSON.stringify({ expectedVersion: li.version }), method: 'POST' },
        )
        if (response.jobId) await waitForJob(response.jobId)
      }
      await revalidator.revalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : `Bulk ${decision} failed.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="review-family-panel">
      <header className="review-family-header">
        <div className="review-family-title">
          <h3>{familyLabel}</h3>
          <div className="inline-row wrap-row">
            {family.mso.isMSOBrand ? <Pill tone="warning">MSO</Pill> : null}
            <Pill tone={family.ordering.driftedRowCount > 0 ? 'danger' : 'muted'}>
              {`${family.rows.length} ${family.rows.length === 1 ? 'row' : 'rows'}${
                family.ordering.driftedRowCount > 0 ? ` · ${family.ordering.driftedRowCount} drifted` : ''
              }`}
            </Pill>
            {spreadLabel ? <Pill tone="muted">{spreadLabel}</Pill> : null}
          </div>
        </div>
        <div className="inline-row wrap-row">
          <button className="primary-button" disabled={busy} onClick={() => void handleBulk('approve')} type="button">
            Approve all pending
          </button>
          <button className="danger-button" disabled={busy} onClick={() => void handleBulk('reject')} type="button">
            Reject all pending
          </button>
        </div>
      </header>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="review-row-stack">
        {family.rows.map((row) => (
          <ReviewRowCard key={row.proposalRowId} row={row} />
        ))}
      </div>
    </article>
  )
}

function ReviewRowCard({ row }: { row: ReviewRow }) {
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

function truncateForTooltip(text: string): string {
  if (text.length <= 400) return text
  return `${text.slice(0, 400).trimEnd()}…`
}

function truncatePreview(text: string): string {
  if (text.length <= 110) return text
  return `${text.slice(0, 110).trimEnd()}…`
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

function rollupTone(rollup: ReviewRow['approvalRollup']): 'danger' | 'muted' | 'success' | 'warning' {
  switch (rollup) {
    case 'approved':
      return 'success'
    case 'rejected':
      return 'danger'
    case 'mixed':
      return 'warning'
    case 'pending':
    default:
      return 'warning'
  }
}

function formatCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `$${value.toFixed(2)}`
}
