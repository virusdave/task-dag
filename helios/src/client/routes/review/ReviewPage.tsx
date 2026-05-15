import { useEffect, useState } from 'react'
import { Form, Link, useLoaderData, useRevalidator } from 'react-router-dom'

import {
  MutationAcceptedResponseSchema,
  ReviewLineItemListResponseSchema,
  buildHeliosModulePath,
  type ProposalLineItem,
  type ReviewLineItemListResponse,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { waitForJob } from '../../app/jobPolling.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from '../catalog/catalogSidebarSubtree.js'

export async function reviewLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/review/line-items${url.search}`, ReviewLineItemListResponseSchema)
}

export function ReviewPage() {
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as ReviewLineItemListResponse

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Compact Approval Queue</p>
          <h2>Decision-first line items with detail drill-in</h2>
        </div>
        <Form className="filter-row" method="get">
          <input defaultValue={data.filters.search ?? ''} name="search" placeholder="Search group or brand" />
          <select defaultValue={data.filters.proposalType ?? ''} name="proposalType">
            <option value="">All proposal types</option>
            <option value="description">Description</option>
            <option value="pricing">Pricing</option>
          </select>
          <select defaultValue={data.filters.approvalStatus ?? ''} name="approvalStatus">
            <option value="">All states</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
          <button className="ghost-button" type="submit">
            Filter
          </button>
        </Form>
      </div>
      <div className="review-grid">
        {data.items.map((item) => (
          <ReviewLineItemCard item={item} key={item.lineItemId} />
        ))}
      </div>
    </section>
  )
}

function ReviewLineItemCard({ item }: { item: ProposalLineItem }) {
  const [draftValue, setDraftValue] = useState(readEditableInputValue(item))
  const [draftNote, setDraftNote] = useState(item.notes ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const revalidator = useRevalidator()

  useEffect(() => {
    setDraftValue(readEditableInputValue(item))
    setDraftNote(item.notes ?? '')
  }, [item])

  async function handleSaveEdit() {
    setIsSaving(true)
    setErrorMessage(null)

    let editedValue: number | string
    try {
      editedValue = parseDraftEditedValue(item, draftValue)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not parse the edited value.')
      setIsSaving(false)
      return
    }

    try {
      await mutateJson(`/api/proposal-line-items/${item.lineItemId}/edit`, MutationAcceptedResponseSchema, {
        body: JSON.stringify({ editedValue, expectedVersion: item.version }),
        method: 'PATCH',
      })
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not save the edit.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSaveNote() {
    setIsSaving(true)
    setErrorMessage(null)
    try {
      await mutateJson(`/api/proposal-line-items/${item.lineItemId}/note`, MutationAcceptedResponseSchema, {
        body: JSON.stringify({ note: draftNote || null }),
        method: 'PATCH',
      })
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not save the note.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDecision(decision: 'approve' | 'reject') {
    setIsSaving(true)
    setErrorMessage(null)
    try {
      const response = await mutateJson(
        `/api/proposal-line-items/${item.lineItemId}/${decision}`,
        MutationAcceptedResponseSchema,
        {
          body: JSON.stringify({ expectedVersion: item.version }),
          method: 'POST',
        },
      )
      if (response.jobId) {
        await waitForJob(response.jobId)
      }
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : `Could not ${decision} this line item.`)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <article className="review-card">
      <div className="review-card-header">
        <div>
          <Link className="review-group-link" to={buildHeliosModulePath('catalog', `groups/${item.catalogGroupId}`)}>
            {item.groupSummary.groupName}
          </Link>
          <p className="subtle-copy">{item.groupSummary.brandName ?? 'No brand'} · {item.fieldPath}</p>
        </div>
        <Pill tone={approvalTone(item.approvalStatus)}>{item.approvalStatus}</Pill>
      </div>

      <div className="comparison-grid">
        <ValuePanel label="Live" title={stringValue(item.baselineValue)} value={item.valuePreview.baselineText} />
        <ValuePanel label="Suggested" title={stringValue(item.suggestedValue)} value={item.valuePreview.suggestedText} />
        <ValuePanel label="Effective" title={stringValue(item.effectiveValue)} value={item.valuePreview.effectiveText} />
      </div>

      <label className="stack-field">
        <span>Edit proposal</span>
        {item.fieldPath === 'products.price' ? (
          <input
            inputMode="decimal"
            onChange={(event) => setDraftValue(event.target.value)}
            step="0.01"
            type="number"
            value={draftValue}
          />
        ) : (
          <textarea onChange={(event) => setDraftValue(event.target.value)} rows={5} value={draftValue} />
        )}
      </label>

      <label className="stack-field">
        <span>Operator note</span>
        <textarea onChange={(event) => setDraftNote(event.target.value)} rows={2} value={draftNote} />
      </label>

      <div className="inline-row wrap-row">
        {item.validationIssues.map((issue) => (
          <Pill key={`${issue.code}-${issue.detail}`} tone={issue.severity === 'error' ? 'danger' : 'warning'}>
            {issue.code}
          </Pill>
        ))}
        <Pill tone={item.groupSummary.reconcileStatus === 'drifted' ? 'danger' : 'muted'}>
          {item.groupSummary.reconcileStatus}
        </Pill>
      </div>

      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

      <div className="inline-row wrap-row review-actions">
        <Link to={buildHeliosModulePath('catalog', `review-details/proposal_line_item/${item.lineItemId}`)}>
          Review details
        </Link>
        <button className="ghost-button" disabled={isSaving} onClick={() => void handleSaveEdit()} type="button">
          Save edit
        </button>
        <button className="ghost-button" disabled={isSaving} onClick={() => void handleSaveNote()} type="button">
          Save note
        </button>
        <button className="primary-button" disabled={isSaving} onClick={() => void handleDecision('approve')} type="button">
          Approve
        </button>
        <button className="danger-button" disabled={isSaving} onClick={() => void handleDecision('reject')} type="button">
          Reject
        </button>
      </div>
    </article>
  )
}

function approvalTone(status: string): 'danger' | 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'approved':
      return 'success'
    case 'rejected':
      return 'danger'
    case 'pending':
      return 'warning'
    default:
      return 'muted'
  }
}

function readEditableInputValue(item: ProposalLineItem): string {
  if (typeof item.editedValue === 'string') {
    return item.editedValue
  }
  if (typeof item.editedValue === 'number') {
    return String(item.editedValue)
  }
  if (typeof item.suggestedValue === 'string') {
    return item.suggestedValue
  }
  if (typeof item.suggestedValue === 'number') {
    return String(item.suggestedValue)
  }
  return JSON.stringify(item.suggestedValue, null, 2)
}

function parseDraftEditedValue(item: ProposalLineItem, draftValue: string): number | string {
  if (item.fieldPath === 'products.price') {
    const parsed = Number(draftValue.trim())
    if (!Number.isFinite(parsed)) {
      throw new Error('Price edits must be numeric.')
    }

    return Math.round((parsed + Number.EPSILON) * 100) / 100
  }

  return draftValue
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function ValuePanel({ label, title, value }: { label: string; title: string; value: string }) {
  return (
    <div className="value-panel" title={title}>
      <span>{label}</span>
      <p>{value || '—'}</p>
    </div>
  )
}
