// Helios → Reviews → Submission detail
//
// Customer-Sentiment Capture (issue #13, A4 phase). Operator surface
// for a single submission: shows the row + drawing-entry state, and
// exposes the A4 + A5 action buttons:
//   - acknowledge
//   - re-run LLM
//   - force-add / force-remove (per segment)
//   - mark / clear fraudulent
//
// Per helios/AGENTS.md, the table of operator-relevant facts +
// actions is the only default-visible content; raw payload + audit
// metadata sit under <details>.
//
// Resend-email is the only A5 action whose backend wiring lives in
// A3, so we wire the button shape here but display it as disabled
// (Coming in A3) until then.

import { useState } from 'react'
import { useLoaderData, useNavigate, useRevalidator } from 'react-router-dom'
import { z } from 'zod'

import {
  CustomerReviewActionResponseSchema,
  CustomerReviewListItemSchema,
  type CustomerReviewListItem,
  type SegmentKindContract,
} from '../../../shared/contracts/index.js'
import { mutateJson } from '../../app/fetchJson.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill, type PillProps } from '../../components/Pill.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import { REVIEWS_SIDEBAR_SUBTREE } from './customerReviewsSidebar.js'

const DetailResponseSchema = z.object({
  item: CustomerReviewListItemSchema,
  captureEnabled: z.boolean(),
})
type DetailResponse = z.infer<typeof DetailResponseSchema>

export async function customerReviewDetailLoader({
  params,
}: {
  params: { submissionId?: string }
}): Promise<DetailResponse> {
  const id = params.submissionId ?? ''
  return loadJson(`/api/customer-reviews/${encodeURIComponent(id)}`, DetailResponseSchema)
}

function segmentStatusTone(
  status: CustomerReviewListItem['drawingEntry'] extends infer R
    ? R extends { drawingSegmentStatus: infer S }
      ? S
      : never
    : never,
): PillProps['tone'] {
  if (status === 'added') return 'success'
  if (status === 'removed') return 'warning'
  if (status === 'failed') return 'danger'
  if (status === 'skipped') return 'muted'
  return 'muted'
}

function formatDate(iso: string | null): string {
  if (iso === null) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export function CustomerReviewDetailPage() {
  useRegisterSidebarSubtree('reviews', REVIEWS_SIDEBAR_SUBTREE)
  const initial = useLoaderData() as DetailResponse
  const revalidator = useRevalidator()
  const navigate = useNavigate()
  const [item, setItem] = useState<CustomerReviewListItem>(initial.item)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [lastMessage, setLastMessage] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)

  const drawing = item.drawingEntry

  async function runAction(
    label: string,
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<void> {
    setPendingAction(label)
    setLastError(null)
    try {
      const response = await mutateJson(
        `/api/customer-reviews/${encodeURIComponent(item.submissionId)}${path}`,
        CustomerReviewActionResponseSchema,
        { method: 'POST', body: JSON.stringify(body) },
      )
      setItem(response.item)
      setLastMessage(response.message ?? `${label} complete.`)
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error))
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">
            <a href="#" onClick={(e) => { e.preventDefault(); navigate('/reviews') }}>
              Reviews → Submissions
            </a>{' '}
            → Detail
          </p>
          <h2>
            {item.siteLabel || `dealer ${item.dealerId}`} ·{' '}
            {item.starRating !== null ? `${'★'.repeat(item.starRating)}` : '—'}{' '}
            {item.fraudMarked ? <Pill tone="danger">fraud</Pill> : null}
          </h2>
        </div>
        <div className="inline-row wrap-row">
          <button
            className="ghost-button"
            type="button"
            onClick={() => revalidator.revalidate()}
            disabled={revalidator.state !== 'idle'}
          >
            {revalidator.state === 'idle' ? 'Refresh' : 'Refreshing…'}
          </button>
        </div>
      </div>

      {lastError !== null ? (
        <p style={{ color: 'var(--danger-fg, #b00020)', marginBottom: '0.5rem' }}>
          Action failed: {lastError}
        </p>
      ) : null}
      {lastMessage !== null && lastError === null ? (
        <p className="subtle-copy" style={{ marginBottom: '0.5rem' }}>{lastMessage}</p>
      ) : null}

      <table className="data-table" style={{ marginBottom: '1rem' }}>
        <tbody>
          <tr>
            <th>Submission</th>
            <td><code>{item.submissionId}</code></td>
          </tr>
          <tr>
            <th>Submitted</th>
            <td>{formatDate(item.createdAt)}</td>
          </tr>
          <tr>
            <th>Stars</th>
            <td>{item.starRating ?? '—'}</td>
          </tr>
          <tr>
            <th>Kind</th>
            <td>{item.submissionKind}</td>
          </tr>
          <tr>
            <th>LLM verdict</th>
            <td>
              {item.llmVerdict === null
                ? '— skipped'
                : item.llmVerdict === 'error'
                  ? `error (degraded ${item.degradedPass ? '✓' : '✗'})`
                  : item.llmVerdict}
              {item.llmAt ? ` · at ${formatDate(item.llmAt)}` : ''}
              {item.llmModelRef ? ` · ${item.llmModelRef}` : ''}
            </td>
          </tr>
          <tr>
            <th>Review text</th>
            <td style={{ whiteSpace: 'pre-wrap' }}>
              {item.reviewText ?? <span className="subtle-copy">(no text)</span>}
            </td>
          </tr>
          <tr>
            <th>Contacts</th>
            <td>
              {item.contacts.length === 0
                ? '—'
                : item.contacts.map((c) => `${c.kind}: ${c.value}`).join(' · ')}
            </td>
          </tr>
          <tr>
            <th>Provider review URL</th>
            <td>
              {item.reviewProviderUrl ? (
                <a href={item.reviewProviderUrl} target="_blank" rel="noreferrer">
                  {item.reviewProviderUrl}
                </a>
              ) : (
                '—'
              )}
            </td>
          </tr>
        </tbody>
      </table>

      <h3>Drawing entry</h3>
      {drawing === null ? (
        <p className="subtle-copy">No drawing entry recorded for this submission.</p>
      ) : (
        <table className="data-table" style={{ marginBottom: '1rem' }}>
          <tbody>
            <tr>
              <th>Drawing entry id</th>
              <td><code>{drawing.id}</code></td>
            </tr>
            <tr>
              <th>Accepted paste offer</th>
              <td>{drawing.acceptedPasteOffer ? 'yes' : 'no'}</td>
            </tr>
            <tr>
              <th>Sweed customer id</th>
              <td>{drawing.sweedCustomerId ?? '—'}</td>
            </tr>
            <tr>
              <th>Drawing segment</th>
              <td>
                {drawing.drawingSegmentId ?? '—'}{' '}
                <Pill tone={segmentStatusTone(drawing.drawingSegmentStatus)}>
                  {drawing.drawingSegmentStatus ?? 'not attempted'}
                </Pill>
                {drawing.drawingSegmentError ? ` · ${drawing.drawingSegmentError}` : ''}
              </td>
            </tr>
            <tr>
              <th>Free-preroll segment</th>
              <td>
                {drawing.freePrerollSegmentId ?? '—'}{' '}
                <Pill tone={segmentStatusTone(drawing.freePrerollSegmentStatus)}>
                  {drawing.freePrerollSegmentStatus ?? 'not attempted'}
                </Pill>
                {drawing.freePrerollSegmentError ? ` · ${drawing.freePrerollSegmentError}` : ''}
              </td>
            </tr>
            <tr>
              <th>Acknowledged</th>
              <td>
                {drawing.acknowledged
                  ? `${drawing.acknowledgedBy ?? 'operator'} · ${formatDate(drawing.acknowledgedAt)}`
                  : 'no'}
              </td>
            </tr>
            <tr>
              <th>Fraudulent</th>
              <td>
                {drawing.fraudulent
                  ? `${drawing.fraudulentMarkedBy ?? 'operator'} · ${formatDate(drawing.fraudulentMarkedAt ?? null)}`
                  : 'no'}
              </td>
            </tr>
          </tbody>
        </table>
      )}

      <h3>Actions</h3>
      <div className="inline-row wrap-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={pendingAction !== null || drawing === null || drawing.acknowledged}
          onClick={() => runAction('acknowledge', '/acknowledge')}
        >
          {pendingAction === 'acknowledge' ? 'Acknowledging…' : 'Acknowledge'}
        </button>
        <button
          type="button"
          disabled={pendingAction !== null}
          onClick={() => runAction('re-run-llm', '/re-run-llm')}
        >
          {pendingAction === 're-run-llm' ? 'Running…' : 'Re-run LLM'}
        </button>
        <button
          type="button"
          disabled
          title="Wired in A3 once the email pipeline lands."
        >
          Resend email (A3)
        </button>
        {(['drawing', 'free_preroll'] as SegmentKindContract[]).map((kind) => (
          <span key={kind} className="inline-row" style={{ gap: '0.25rem' }}>
            <button
              type="button"
              disabled={pendingAction !== null || drawing === null}
              onClick={() => runAction(`force-add-${kind}`, '/segment/add', { segment: kind })}
            >
              {pendingAction === `force-add-${kind}` ? '…' : `Force-add ${kind}`}
            </button>
            <button
              type="button"
              disabled={
                pendingAction !== null ||
                drawing === null ||
                drawing.sweedCustomerId === null
              }
              onClick={() => runAction(`force-remove-${kind}`, '/segment/remove', { segment: kind })}
            >
              {pendingAction === `force-remove-${kind}` ? '…' : `Force-remove ${kind}`}
            </button>
          </span>
        ))}
        <button
          type="button"
          disabled={pendingAction !== null}
          onClick={() =>
            runAction(
              item.fraudMarked ? 'clear-fraudulent' : 'mark-fraudulent',
              '/mark-fraudulent',
              { fraudulent: !item.fraudMarked },
            )
          }
        >
          {pendingAction === 'mark-fraudulent' || pendingAction === 'clear-fraudulent'
            ? 'Updating…'
            : item.fraudMarked
              ? 'Clear fraudulent'
              : 'Mark fraudulent'}
        </button>
      </div>

      <details style={{ marginTop: '1.5rem' }}>
        <summary>About this page (A4 phase status, action contract)</summary>
        <div className="subtle-copy" style={{ marginTop: '0.5rem' }}>
          <p>
            This is the A4 surface of the Customer-Sentiment Capture epic
            (<a href="https://github.com/FreshlyBakedNYC/automation/issues/13" target="_blank" rel="noreferrer">issue #13</a>).
            Sweed segment add/remove flows through the operator-pasted Sweed
            session pool (no SWEED_AUTH_TOKEN env shortcut, per
            docs/sweed/getting-a-token-for-one-offs.md).
          </p>
          <p>
            <strong>Force-add</strong> looks up the customer in Sweed by
            phone (preferred) or email, creates a minimal client if no
            match is found, then attempts <code>segments.add_member</code>.
            <strong> Force-remove</strong> only fires when a Sweed customer
            id is already recorded on the row.
            <strong> Mark fraudulent</strong> additionally attempts
            <code>segments.remove_member</code> on both per-site segment
            ids and persists each result independently.
            <strong> Re-run LLM</strong> re-fires the A2 sentiment gate
            against the current review text, updates the verdict columns,
            and pages Dave on <code>verdict='error'</code>.
          </p>
          <p>
            Resend-email is intentionally disabled until the A3 email
            pipeline lands.
          </p>
        </div>
      </details>
    </section>
  )
}
