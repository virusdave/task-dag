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

import { useEffect, useMemo, useState } from 'react'
import { Link, useLoaderData, useRevalidator } from 'react-router-dom'

import {
  CustomerReviewCandidatePurchasesBulkResponseSchema,
  CustomerReviewListResponseSchema,
  type CustomerReviewEmailRow,
  type CustomerReviewListItem,
  type CustomerReviewListResponse,
  type CustomerReviewPurchaseCandidate,
  type SegmentKindContract,
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

interface CandidateState {
  loading: boolean
  error: string | null
  candidates: CustomerReviewPurchaseCandidate[] | null
  // submissionId currently being added (so we can disable buttons).
  busyKey: string | null
  // Set of `${clientId}::${segment}` strings that have been added
  // successfully — used to badge those buttons '✓ Added' so the
  // operator can still pick the OTHER segment for the same client
  // (drawing + free-preroll are not mutually exclusive) and to
  // prevent accidental double-adds.
  completedKeys: ReadonlySet<string>
}

function formatDeltaSeconds(s: number): string {
  const abs = Math.abs(s)
  const mins = Math.floor(abs / 60)
  const secs = abs % 60
  const sign = s >= 0 ? 'after' : 'before'
  if (mins === 0) return `${secs}s ${sign} submit`
  return `${mins}m ${secs}s ${sign} submit`
}

function confidenceTone(c: number): PillProps['tone'] {
  if (c >= 0.85) return 'success'
  if (c >= 0.5) return 'warning'
  return 'muted'
}

function candidateSummaryLine(c: CustomerReviewPurchaseCandidate): string {
  const bits: string[] = []
  if (c.clientName) bits.push(c.clientName)
  if (c.clientPhone) bits.push(c.clientPhone)
  if (c.clientEmail) bits.push(c.clientEmail)
  if (bits.length === 0) bits.push(`client #${c.clientId ?? '?'}`)
  return bits.join(' · ')
}

function candidateButtonProps(args: {
  state: CandidateState | undefined
  submissionId: string
  candidate: CustomerReviewPurchaseCandidate
  segment: SegmentKindContract
}): { label: string; disabled: boolean; done: boolean } {
  const { state, submissionId, candidate, segment } = args
  const key = `${submissionId}::${candidate.clientId}::${segment}`
  const completed = state?.completedKeys?.has(key) ?? false
  const busy = state?.busyKey === key
  const anyBusy = state?.busyKey !== null && state?.busyKey !== undefined
  const segmentLabel = segment === 'drawing' ? 'drawing' : 'free-preroll'
  let label: string
  if (busy) label = 'Adding…'
  else if (completed) label = `✓ Added to ${segmentLabel}`
  else label = `Add to ${segmentLabel}`
  return {
    label,
    done: completed,
    disabled: completed || anyBusy || candidate.clientId === null,
  }
}

// Contacts cell for the list row. Renders any persisted contacts on
// top; below that, always renders the bulk-prefetched candidate
// panel when one has been loaded. Drawing + free-preroll are NOT
// mutually exclusive, and the panel must stay visible after a
// successful "Add to drawing" so the operator can still pick
// "Add to free-preroll" for the same client (or pick a different
// candidate entirely for the OTHER segment).
function ContactsCell(props: {
  item: CustomerReviewListItem
  state: CandidateState | undefined
  bulkLoading: boolean
  bulkError: string | null
  onAdd: (
    candidate: CustomerReviewPurchaseCandidate,
    segment: SegmentKindContract,
  ) => void
}) {
  const { item, state, bulkLoading, bulkError, onAdd } = props
  const contactsKnown = item.contacts.length > 0
  const candidates = state?.candidates ?? null
  // We surface the candidate panel whenever the bulk fetch ran for
  // this submission — i.e. whenever there is local candidate state
  // for it OR a global bulk request is still in flight that may
  // populate it. Once contacts arrive (either originally or via an
  // add-candidate-to-segment success), we still show the panel for
  // the same row so the second segment can be picked.
  const showPanel = candidates !== null || bulkLoading || bulkError !== null

  return (
    <div>
      {contactsKnown ? (
        <div>{summarizeContacts(item)}</div>
      ) : (
        <div className="subtle-copy">— (no contact captured)</div>
      )}
      {showPanel && (
        <div style={{ marginTop: '0.35rem', fontSize: '0.85em' }}>
          {candidates === null && bulkLoading && (
            <span className="subtle-copy">Looking up Sweed invoices…</span>
          )}
          {candidates === null && !bulkLoading && bulkError !== null && (
            <span style={{ color: '#b91c1c' }}>{bulkError}</span>
          )}
          {candidates !== null && candidates.length === 0 && (
            <span className="subtle-copy">
              No invoices found within ±30 min of the submission.
            </span>
          )}
          {candidates !== null && candidates.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: '1rem' }}>
              {candidates.map((c, idx) => {
                const draw = candidateButtonProps({
                  state,
                  submissionId: item.submissionId,
                  candidate: c,
                  segment: 'drawing',
                })
                const free = candidateButtonProps({
                  state,
                  submissionId: item.submissionId,
                  candidate: c,
                  segment: 'free_preroll',
                })
                return (
                  <li
                    key={`${c.invoiceId ?? c.clientId ?? idx}`}
                    style={{ marginBottom: '0.4rem' }}
                  >
                    <Pill tone={confidenceTone(c.confidence)}>
                      {`${Math.round(c.confidence * 100)}%`}
                    </Pill>
                    {idx === 0 && (
                      <span style={{ marginLeft: '0.25rem', fontSize: '0.9em' }}>
                        ★ closest
                      </span>
                    )}{' '}
                    <span>{candidateSummaryLine(c)}</span>
                    <div className="subtle-copy" style={{ fontSize: '0.85em' }}>
                      {formatDeltaSeconds(c.deltaSeconds)}
                      {c.total !== null ? ` · $${c.total.toFixed(2)}` : ''}
                      {c.invoiceId ? ` · invoice ${c.invoiceId}` : ''}
                    </div>
                    <div style={{ marginTop: '0.15rem' }}>
                      <button
                        type="button"
                        className="ghost-button"
                        style={{
                          fontSize: '0.85em',
                          marginRight: '0.25rem',
                          opacity: draw.done ? 0.6 : 1,
                        }}
                        disabled={draw.disabled}
                        onClick={() => onAdd(c, 'drawing')}
                      >
                        {draw.label}
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        style={{ fontSize: '0.85em', opacity: free.done ? 0.6 : 1 }}
                        disabled={free.disabled}
                        onClick={() => onAdd(c, 'free_preroll')}
                      >
                        {free.label}
                      </button>
                    </div>
                    {state?.error !== undefined && state?.error !== null && (
                      <div style={{ color: '#b91c1c', fontSize: '0.85em' }}>
                        {state.error}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// A3: collapse the per-recipient send-attempt list into a small
// status summary for the list row. Detail is exposed below the
// summary on hover via the <details> drawer.
function summarizeEmailRows(emails: CustomerReviewEmailRow[]): {
  tone: PillProps['tone']
  label: string
} {
  if (emails.length === 0) return { tone: 'muted', label: '—' }
  const counts = { sent: 0, queued: 0, failed: 0, skipped: 0 }
  for (const e of emails) counts[e.sendStatus]++
  if (counts.failed > 0) return { tone: 'danger', label: `${counts.failed} failed / ${emails.length}` }
  if (counts.queued > 0) return { tone: 'warning', label: `${counts.queued} queued / ${emails.length}` }
  if (counts.sent > 0) return { tone: 'success', label: `${counts.sent} sent` }
  return { tone: 'muted', label: `${emails.length} skipped` }
}

function emailStatusTone(status: CustomerReviewEmailRow['sendStatus']): PillProps['tone'] {
  switch (status) {
    case 'sent':
      return 'success'
    case 'queued':
      return 'warning'
    case 'failed':
      return 'danger'
    default:
      return 'muted'
  }
}

// A3: verdicts that DO drive an email per the pipeline contract. Used
// to gate the resend button so we don't surface it for strong-no-text
// / null-verdict rows where a resend would 409 with "no template".
function verdictEmailEligible(item: CustomerReviewListItem): boolean {
  if (item.llmVerdict === null) return false
  if (item.llmVerdict === 'strong-no-text') return false
  return true
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
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [resendError, setResendError] = useState<string | null>(null)
  const [candidatesBySubmission, setCandidatesBySubmission] = useState<
    Record<string, CandidateState>
  >({})
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)

  // Number of contactless submissions visible on the page — used to
  // decide whether to fire the bulk prefetch at all, and to drive the
  // status banner.
  const contactlessCount = useMemo(
    () => initial.items.filter((it) => it.contacts.length === 0).length,
    [initial.items],
  )

  // Fire the one-shot bulk prefetch on mount (and after any revalidate
  // that adds new contactless submissions). The server opens a single
  // Sweed session, does one store.sale.invoice.list per distinct
  // dealer, and returns candidates keyed by submissionId.
  useEffect(() => {
    if (contactlessCount === 0) return
    let cancelled = false
    setBulkLoading(true)
    setBulkError(null)
    void (async () => {
      try {
        const res = await loadJson(
          '/api/customer-reviews/candidate-purchases-bulk',
          CustomerReviewCandidatePurchasesBulkResponseSchema,
        )
        if (cancelled) return
        setCandidatesBySubmission((prev) => {
          const next = { ...prev }
          for (const row of res.bySubmission) {
            next[row.submissionId] = {
              loading: false,
              error: null,
              candidates: row.candidates,
              busyKey: prev[row.submissionId]?.busyKey ?? null,
              completedKeys: prev[row.submissionId]?.completedKeys ?? new Set<string>(),
            }
          }
          return next
        })
      } catch (err) {
        if (cancelled) return
        setBulkError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setBulkLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // Intentionally mount-only: re-firing the bulk fetch on every
    // revalidate (e.g. after each Add-to-segment success) would
    // lease another Sweed session and re-fetch invoices we already
    // hold in state. Operator can hit Refresh / reload the page to
    // pick up newly-landed contactless submissions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addCandidateToSegment = async (
    submissionId: string,
    candidate: CustomerReviewPurchaseCandidate,
    segment: SegmentKindContract,
  ) => {
    const key = `${submissionId}::${candidate.clientId}::${segment}`
    setCandidatesBySubmission((prev) => ({
      ...prev,
      [submissionId]: {
        loading: prev[submissionId]?.loading ?? false,
        error: null,
        candidates: prev[submissionId]?.candidates ?? null,
        busyKey: key,
        completedKeys: prev[submissionId]?.completedKeys ?? new Set<string>(),
      },
    }))
    try {
      const res = await fetch(
        `/api/customer-reviews/${encodeURIComponent(submissionId)}/candidate-purchases/add-to-segment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            segment,
            sweedClientId: candidate.clientId,
            contactPhone: candidate.clientPhone,
            contactEmail: candidate.clientEmail,
            contactName: candidate.clientName,
            invoiceId: candidate.invoiceId,
          }),
        },
      )
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        setCandidatesBySubmission((prev) => ({
          ...prev,
          [submissionId]: {
            ...prev[submissionId],
            busyKey: null,
            completedKeys: prev[submissionId]?.completedKeys ?? new Set<string>(),
            error: `Add failed (${res.status}): ${errText.slice(0, 200)}`,
          },
        }))
        return
      }
      // On success: record the (clientId, segment) pair as completed
      // so the button badges '✓ Added' (but stays present so the
      // operator can still pick the OTHER segment for the same
      // client), clear busy, and revalidate so the persisted
      // contact info shows up on the row.
      setCandidatesBySubmission((prev) => {
        const existing = prev[submissionId]?.completedKeys ?? new Set<string>()
        const nextSet = new Set<string>(existing)
        nextSet.add(key)
        return {
          ...prev,
          [submissionId]: {
            ...prev[submissionId],
            busyKey: null,
            error: null,
            completedKeys: nextSet,
          },
        }
      })
      revalidator.revalidate()
    } catch (err) {
      setCandidatesBySubmission((prev) => ({
        ...prev,
        [submissionId]: {
          ...prev[submissionId],
          busyKey: null,
          completedKeys: prev[submissionId]?.completedKeys ?? new Set<string>(),
          error: err instanceof Error ? err.message : String(err),
        },
      }))
    }
  }

  const onResend = async (submissionId: string) => {
    setResendingId(submissionId)
    setResendError(null)
    try {
      const res = await fetch(`/api/customer-reviews/${submissionId}/resend-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        setResendError(`Resend failed (${res.status}): ${errText.slice(0, 200)}`)
        return
      }
      revalidator.revalidate()
    } catch (err) {
      setResendError(err instanceof Error ? err.message : String(err))
    } finally {
      setResendingId(null)
    }
  }

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

      {resendError !== null && (
        <p style={{ color: '#b91c1c', marginBottom: '0.5rem' }}>{resendError}</p>
      )}

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
              <th>Emails</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => {
              const emailSummary = summarizeEmailRows(item.emails)
              const canResend = verdictEmailEligible(item)
              return (
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
                  <td style={{ fontSize: '0.85em', minWidth: '18rem' }}>
                    <ContactsCell
                      item={item}
                      state={candidatesBySubmission[item.submissionId]}
                      bulkLoading={bulkLoading}
                      bulkError={bulkError}
                      onAdd={(candidate, segment) =>
                        addCandidateToSegment(item.submissionId, candidate, segment)
                      }
                    />
                  </td>
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
                    <Pill tone={emailSummary.tone}>{emailSummary.label}</Pill>
                    {item.emails.length > 0 && (
                      <details style={{ marginTop: '0.25rem' }}>
                        <summary className="subtle-copy" style={{ fontSize: '0.8em' }}>
                          per-recipient
                        </summary>
                        <ul style={{ margin: '0.25rem 0', paddingLeft: '1rem', fontSize: '0.8em' }}>
                          {item.emails.map((e) => (
                            <li key={e.id}>
                              <Pill tone={emailStatusTone(e.sendStatus)}>{e.sendStatus}</Pill>{' '}
                              {e.toAddress}
                              {e.sendError !== null && (
                                <div style={{ color: '#b91c1c' }}>{e.sendError}</div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {canResend && (
                      <div style={{ marginTop: '0.25rem' }}>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => onResend(item.submissionId)}
                          disabled={resendingId !== null}
                          style={{ fontSize: '0.8em' }}
                        >
                          {resendingId === item.submissionId ? 'Resending…' : 'Resend email'}
                        </button>
                      </div>
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
              )
            })}
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
              <strong>A3 (shipped)</strong> — email pipeline + templates under{' '}
              <code>helios/email_templates/reviews/</code> (negative, lukewarm,
              strong-with-text). Sender <code>reviews@freshlybaked.us</code>{' '}
              (env: <code>REVIEWS_EMAIL_FROM</code>). When{' '}
              <code>REVIEWS_SMTP_HOST</code> is unset, sends queue with{' '}
              <code>send_status='queued'</code> while we wait on{' '}
              <em>nixos-sbc</em> provisioning the mailbox; when set, a minimal
              plain-TCP SMTP exchange is attempted and{' '}
              <code>'sent'</code>/<code>'failed'</code> is recorded. The Emails
              column above shows the per-recipient outcomes; the{' '}
              <em>Resend email</em> action enqueues a fresh send attempt
              without mutating earlier rows.
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
