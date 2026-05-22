// Helios → Reviews → Submissions
//
// Customer-Sentiment Capture (issue #13, A1 phase).  Read-only list
// of submissions captured by the public POST /v1/reviews/submit
// endpoint.  Operators load this page to confirm the capture API is
// working end-to-end before A2 (LLM gate) and A3 (email pipeline)
// land.
//
// Per helios/AGENTS.md "Optimize the page for reviewer efficiency":
// the submission table is the only default-visible content. The
// methodology / phase-status / capture-disabled explainer is
// collapsed inside <details>.

import { useMemo, useState } from 'react'
import { Link, useLoaderData, useRevalidator } from 'react-router-dom'

import {
  CustomerReviewListResponseSchema,
  type CustomerReviewListItem,
  type CustomerReviewListResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill, type PillProps } from '../../components/Pill.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import { REVIEWS_SIDEBAR_SUBTREE } from './customerReviewsSidebar.js'

type StarFilter = 'all' | '5' | '4' | '3' | '2' | '1'
type KindFilter = 'all' | 'form' | 'drawing' | 'other'

export async function customerReviewsListLoader(): Promise<CustomerReviewListResponse> {
  return loadJson('/api/customer-reviews', CustomerReviewListResponseSchema)
}

function starTone(stars: number | null): PillProps['tone'] {
  if (stars === null) return 'muted'
  if (stars >= 5) return 'success'
  if (stars >= 3) return 'warning'
  return 'danger'
}

function kindTone(kind: CustomerReviewListItem['submissionKind']): PillProps['tone'] {
  switch (kind) {
    case 'drawing':
      return 'warning'
    case 'form':
      return 'muted'
    default:
      return 'muted'
  }
}

function formatStars(n: number | null): string {
  if (n === null) return '—'
  return `${'★'.repeat(n)}${'☆'.repeat(Math.max(0, 5 - n))} (${n})`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function summarizeContacts(item: CustomerReviewListItem): string {
  if (item.contacts.length === 0) return '—'
  return item.contacts
    .map((c) => `${c.kind}: ${c.value}`)
    .join(' · ')
}

// A2: render the LLM verdict pill. "error (degraded ✓)" makes the
// operator-settled fallback case visually distinguishable from a
// plain error so an at-a-glance scan tells you whether the customer
// still got the paste-text offer.
function renderVerdictPill(item: CustomerReviewListItem) {
  if (item.llmVerdict === null) {
    return <span className="subtle-copy">— skipped</span>
  }
  let tone: PillProps['tone'] = 'muted'
  let label: string = item.llmVerdict
  if (item.llmVerdict === 'strong-with-text') {
    tone = 'success'
  } else if (item.llmVerdict === 'strong-no-text') {
    tone = 'muted'
  } else if (item.llmVerdict === 'lukewarm') {
    tone = 'warning'
  } else if (item.llmVerdict === 'negative') {
    tone = 'danger'
  } else if (item.llmVerdict === 'error') {
    tone = item.degradedPass ? 'warning' : 'danger'
    label = item.degradedPass ? 'error (degraded ✓)' : 'error'
  }
  return <Pill tone={tone}>{label}</Pill>
}

export function CustomerReviewsListPage() {
  useRegisterSidebarSubtree('reviews', REVIEWS_SIDEBAR_SUBTREE)
  const initial = useLoaderData() as CustomerReviewListResponse
  const revalidator = useRevalidator()
  const [starFilter, setStarFilter] = useState<StarFilter>('all')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [showFraud, setShowFraud] = useState(true)

  const filtered = useMemo<CustomerReviewListItem[]>(() => {
    return initial.items.filter((item) => {
      if (!showFraud && item.fraudMarked) return false
      if (starFilter !== 'all' && String(item.starRating ?? '') !== starFilter) return false
      if (kindFilter !== 'all' && item.submissionKind !== kindFilter) return false
      return true
    })
  }, [initial.items, starFilter, kindFilter, showFraud])

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Reviews → Submissions</p>
          <h2>Customer-sentiment capture</h2>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone={initial.captureEnabled ? 'success' : 'warning'}>
            {initial.captureEnabled ? 'Capture enabled' : 'Capture disabled (HELIOS_REVIEWS_CAPTURE_V1=0)'}
          </Pill>
          <Pill tone="muted">{`${initial.totalCount} total`}</Pill>
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

      <div className="filter-row" style={{ marginBottom: '0.75rem' }}>
        <label>
          Stars:{' '}
          <select value={starFilter} onChange={(e) => setStarFilter(e.target.value as StarFilter)}>
            <option value="all">All</option>
            <option value="5">5★</option>
            <option value="4">4★</option>
            <option value="3">3★</option>
            <option value="2">2★</option>
            <option value="1">1★</option>
          </select>
        </label>
        <label>
          Kind:{' '}
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as KindFilter)}>
            <option value="all">All</option>
            <option value="form">form</option>
            <option value="drawing">drawing</option>
            <option value="other">other</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={showFraud}
            onChange={(e) => setShowFraud(e.target.checked)}
          />{' '}
          Show fraud-marked
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="subtle-copy">No submissions match these filters.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Submitted</th>
              <th>Site</th>
              <th>Stars</th>
              <th>Kind</th>
              <th>Review text</th>
              <th>LLM verdict</th>
              <th>Contacts</th>
              <th>Drawing</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => (
              <tr key={item.submissionId}>
                <td>
                  <Link to={`/reviews/${item.submissionId}`}>{formatDate(item.createdAt)}</Link>
                </td>
                <td>{item.siteLabel || `dealer ${item.dealerId}`}</td>
                <td>
                  <Pill tone={starTone(item.starRating)}>{formatStars(item.starRating)}</Pill>
                </td>
                <td>
                  <Pill tone={kindTone(item.submissionKind)}>{item.submissionKind}</Pill>
                </td>
                <td style={{ maxWidth: '24rem', whiteSpace: 'pre-wrap' }}>
                  {item.reviewText ?? <span className="subtle-copy">(no text)</span>}
                </td>
                <td>{renderVerdictPill(item)}</td>
                <td style={{ fontSize: '0.85em' }}>{summarizeContacts(item)}</td>
                <td>
                  {item.drawingEntry === null ? (
                    <span className="subtle-copy">—</span>
                  ) : item.drawingEntry.acknowledged ? (
                    <Pill tone="success">acknowledged</Pill>
                  ) : (
                    <Pill tone="warning">pending</Pill>
                  )}
                </td>
                <td>
                  {item.fraudMarked ? (
                    <Pill tone="danger">fraud</Pill>
                  ) : (
                    <span className="subtle-copy">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <details style={{ marginTop: '1.5rem' }}>
        <summary>About this page (A1 phase status, methodology)</summary>
        <div className="subtle-copy" style={{ marginTop: '0.5rem' }}>
          <p>
            This page is the A1 surface of the Customer-Sentiment Capture epic (
            <a href="https://github.com/FreshlyBakedNYC/automation/issues/13" target="_blank" rel="noreferrer">
              issue #13
            </a>
            ). It is intentionally read-only and shows whatever the public
            POST <code>/v1/reviews/submit</code> and POST{' '}
            <code>/v1/reviews/&lt;submission_id&gt;/drawing-entry</code> endpoints
            have captured. Server-level kill switch:{' '}
            <code>HELIOS_REVIEWS_CAPTURE_V1</code>. Per-site kill switches live
            in <code>site_review_settings</code>.
          </p>
          <p>
            Remaining phases queued for follow-up workers:
          </p>
          <ul>
            <li>
              <strong>A2</strong> — wire the private-LLM gateway client into{' '}
              <code>review_submissions</code> to produce a sentiment +
              safe-to-post-publicly verdict; degraded heuristic + P3 page Dave
              on every LLM error.
            </li>
            <li>
              <strong>A3</strong> — email pipeline + templates under{' '}
              <code>helios/email_templates/reviews/</code> (negative, lukewarm,
              strong-with-text). From: <code>reviews@freshlybaked.us</code>{' '}
              (mailbox provisioning owned by nixos-sbc).
            </li>
            <li>
              <strong>A4</strong> — Sweed segment add (drawing segment always
              on drawing-form submit; free-preroll segment on
              strong-with-text + accepted-offer path). Adds detail-page
              force-add/remove + mark-fraudulent.
            </li>
            <li>
              <strong>A5</strong> — <code>/reviews/drawing</code> exportable
              list + acknowledge / resend-email / re-run-llm actions on the
              detail page.
            </li>
          </ul>
        </div>
      </details>
    </section>
  )
}
