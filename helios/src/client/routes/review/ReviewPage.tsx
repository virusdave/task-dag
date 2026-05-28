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
 *
 * Issue #35 (slice 4b.1): the per-row layout is now provided by the
 * shared model-agnostic `CanonicalProductRow` shell. The Review-
 * specific row state (proposed-price draft, operator note, approve /
 * reject mutations) lives in `ReviewRowCard` below, which adapts the
 * ReviewRow contract into shell props + slot content.
 */
import { useEffect, useMemo, useState } from 'react'
import { Form, Link, useLoaderData, useRevalidator } from 'react-router-dom'

import {
  MutationAcceptedResponseSchema,
  ReviewFamilyQueueResponseSchema,
  buildHeliosModulePath,
  type ReviewFamily,
  type ReviewFamilyQueueResponse,
  type ReviewRow,
  type ReviewRowLineItemHandle,
  type ReviewRowPricingLadder,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { waitForJob } from '../../app/jobPolling.js'
import {
  CanonicalProductRow,
  formatCurrency,
  rollupTone,
  type CanonicalProductRowComparisonCell,
  type CanonicalProductRowValidationIssue,
} from '../../components/canonicalProductRow/index.js'
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

/**
 * Review-specific adapter that holds per-row state (proposed-price
 * draft, operator note) and the approve / reject mutation handlers,
 * then renders the model-agnostic `CanonicalProductRow` shell with
 * the appropriate slots.
 *
 * Issue #35 slice 4b.1: this used to be `CanonicalProductRow` itself
 * — that component is now a slot-based layout shell, with the
 * Review-specific behaviour moved here so `/catalog/pending-purchases`
 * can adopt the same shell with its own state shape.
 */
function ReviewRowCard({ row }: { row: ReviewRow }): JSX.Element {
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

  const comparisons: CanonicalProductRowComparisonCell[] = row.comparisons.map((cmp) => ({
    key: cmp.lineItemId,
    label: cmp.label,
    liveText: cmp.liveValueText,
    proposedText: cmp.proposedValueText,
    changeKind: cmp.changeKind,
  }))

  const validationIssues: CanonicalProductRowValidationIssue[] = row.validationIssues.map((issue) => ({
    key: `${issue.code}-${issue.detail}`,
    code: issue.code,
    severity: issue.severity,
  }))

  return (
    <CanonicalProductRow
      title={
        <Link
          className="review-group-link"
          to={buildHeliosModulePath('catalog', `groups/${row.catalogGroupId}`)}
        >
          {row.rowTitle}
        </Link>
      }
      subtitle={`${row.comparisons.map((c) => c.label).join(' · ')} · catalog group #${row.catalogGroupId}`}
      statusPills={
        <>
          <Pill tone={rollupTone(row.approvalRollup)}>{row.approvalRollup}</Pill>
          <Pill tone={row.reconcileStatus === 'drifted' ? 'danger' : 'muted'}>{row.reconcileStatus}</Pill>
        </>
      }
      comparisons={comparisons}
      pricingLadder={
        row.pricingLadder ? (
          <PricingLadderBlock
            ladder={row.pricingLadder}
            onPriceChange={pricingLine ? setProposedPrice : undefined}
          />
        ) : (
          <p className="subtle-copy">No LitAlerts evidence cached for this SKU yet.</p>
        )
      }
      overrides={
        <label className="stack-field">
          <span>Operator note</span>
          <textarea onChange={(e) => setDraftNote(e.target.value)} rows={2} value={draftNote} />
        </label>
      }
      validationIssues={validationIssues}
      errorMessage={error}
      decisions={
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
      }
      footer={
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
      }
    />
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
