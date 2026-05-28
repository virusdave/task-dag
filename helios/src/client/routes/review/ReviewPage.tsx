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
import { useMemo, useState } from 'react'
import { Form, Link, useLoaderData, useRevalidator } from 'react-router-dom'

import {
  MutationAcceptedResponseSchema,
  ReviewFamilyQueueResponseSchema,
  type ReviewFamily,
  type ReviewFamilyQueueResponse,
  type ReviewRowLineItemHandle,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { waitForJob } from '../../app/jobPolling.js'
import { CanonicalProductRow, formatCurrency } from '../../components/canonicalProductRow/index.js'
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
          <CanonicalProductRow key={row.proposalRowId} row={row} />
        ))}
      </div>
    </article>
  )
}
