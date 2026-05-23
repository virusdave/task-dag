// Helios → Reviews → Drawing
//
// Customer-Sentiment Capture (issue #13, A5 phase).  Operator-facing
// drawing-pool surface: the rows the operator hands to the
// drawing-prize workflow are exactly the rows in this table's default
// view (not fraudulent + not acknowledged).
//
// Per helios/AGENTS.md "Optimize the page for reviewer efficiency":
// the drawing-entry table is the only default-visible content; the
// methodology / CSV / acknowledge-undo explainer is collapsed inside
// <details>.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLoaderData, useRevalidator, useSearchParams } from 'react-router-dom'
import type { LoaderFunctionArgs } from 'react-router-dom'

import {
  CustomerReviewDrawingListResponseSchema,
  type CustomerReviewDrawingListItem,
  type CustomerReviewDrawingListResponse,
} from '../../../shared/contracts/index.js'
import { buildAppPath } from '../../app/paths.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill, type PillProps } from '../../components/Pill.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import { REVIEWS_SIDEBAR_SUBTREE } from './customerReviewsSidebar.js'

function buildDrawingApiQuery(search: URLSearchParams): string {
  const params = new URLSearchParams()
  const site = search.get('site')
  if (site) params.set('site', site)
  const since = search.get('since')
  if (since) params.set('since', since)
  const include = search.get('include')
  if (include) params.set('include', include)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export async function customerReviewsDrawingLoader({
  request,
}: LoaderFunctionArgs): Promise<CustomerReviewDrawingListResponse> {
  const url = new URL(request.url)
  return loadJson(
    `/api/customer-reviews/drawing${buildDrawingApiQuery(url.searchParams)}`,
    CustomerReviewDrawingListResponseSchema,
  )
}

function starTone(stars: number | null): PillProps['tone'] {
  if (stars === null) return 'muted'
  if (stars >= 5) return 'success'
  if (stars >= 3) return 'warning'
  return 'danger'
}

function formatStars(n: number | null): string {
  if (n === null) return '—'
  return `${'★'.repeat(n)}${'☆'.repeat(Math.max(0, 5 - n))} (${n})`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function maskEmail(email: string | null): string {
  if (!email) return ''
  const [user, domain] = email.split('@')
  if (!domain) return email
  const head = user.slice(0, 2)
  return `${head}${user.length > 2 ? '…' : ''}@${domain}`
}

function maskPhone(phone: string | null): string {
  if (!phone) return ''
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return phone
  return `…${digits.slice(-4)}`
}

function contactSummary(item: CustomerReviewDrawingListItem): string {
  const parts: string[] = []
  if (item.contactName) parts.push(item.contactName)
  if (item.contactEmail) parts.push(maskEmail(item.contactEmail))
  if (item.contactPhone) parts.push(maskPhone(item.contactPhone))
  return parts.length === 0 ? '—' : parts.join(' · ')
}

function segmentPill(status: string | null, label: string) {
  if (!status) return <span className="subtle-copy">{label}: —</span>
  let tone: PillProps['tone'] = 'muted'
  if (status === 'added') tone = 'success'
  else if (status === 'failed') tone = 'danger'
  else if (status === 'removed') tone = 'warning'
  return <Pill tone={tone}>{`${label}: ${status}`}</Pill>
}

export function CustomerReviewsDrawingPage() {
  useRegisterSidebarSubtree('reviews', REVIEWS_SIDEBAR_SUBTREE)
  const data = useLoaderData() as CustomerReviewDrawingListResponse
  const [searchParams, setSearchParams] = useSearchParams()
  const revalidator = useRevalidator()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // Local clock to drive the "undo for 5 minutes" countdown without
  // refetching every second.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 5_000)
    return () => clearInterval(t)
  }, [])

  const include = searchParams.get('include') ?? ''
  const showAcked = data.filters.includeAcked
  const showFraud = data.filters.includeFraudulent

  const toggleInclude = useCallback(
    (key: 'acked' | 'fraudulent') => {
      const current = new Set(
        include
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      )
      if (current.has(key)) current.delete(key)
      else current.add(key)
      const next = new URLSearchParams(searchParams)
      if (current.size === 0) next.delete('include')
      else next.set('include', Array.from(current).join(','))
      setSearchParams(next, { replace: true })
    },
    [include, searchParams, setSearchParams],
  )

  const updateParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(searchParams)
      if (value.trim().length === 0) next.delete(key)
      else next.set(key, value.trim())
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const items = data.items
  const undoWindowMs = data.undoWindowSeconds * 1000

  const csvHref = useMemo(() => {
    return buildAppPath(`/api/customer-reviews/drawing.csv${buildDrawingApiQuery(searchParams)}`)
  }, [searchParams])

  async function doAction(submissionId: string, path: string, msg: string) {
    setBusyId(submissionId)
    setActionError(null)
    try {
      const res = await fetch(buildAppPath(path), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        setActionError(`${msg} failed (${res.status}): ${txt.slice(0, 240)}`)
        return
      }
      revalidator.revalidate()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const onAcknowledge = (id: string) =>
    doAction(id, `/api/customer-reviews/${id}/acknowledge`, 'Acknowledge')
  const onUndo = (id: string) =>
    doAction(id, `/api/customer-reviews/${id}/unacknowledge`, 'Undo acknowledge')

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Reviews → Drawing</p>
          <h2>Drawing pool</h2>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone="muted">{`${items.length} shown`}</Pill>
          <a className="ghost-button" href={csvHref} download>
            Export CSV
          </a>
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
          Site (dealerId):{' '}
          <input
            type="text"
            inputMode="numeric"
            value={searchParams.get('site') ?? ''}
            onChange={(e) => updateParam('site', e.target.value)}
            style={{ width: '7rem' }}
            placeholder="any"
          />
        </label>
        <label>
          Since (ISO):{' '}
          <input
            type="text"
            value={searchParams.get('since') ?? ''}
            onChange={(e) => updateParam('since', e.target.value)}
            style={{ width: '14rem' }}
            placeholder="2026-05-01"
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={showAcked}
            onChange={() => toggleInclude('acked')}
          />{' '}
          Include acknowledged
        </label>
        <label>
          <input
            type="checkbox"
            checked={showFraud}
            onChange={() => toggleInclude('fraudulent')}
          />{' '}
          Include fraud-marked
        </label>
      </div>

      {actionError !== null && (
        <p style={{ color: '#b91c1c', marginBottom: '0.5rem' }}>{actionError}</p>
      )}

      {items.length === 0 ? (
        <p className="subtle-copy">No drawing entries match these filters.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Site</th>
              <th>Contact</th>
              <th>Rating + snippet</th>
              <th>Segments</th>
              <th>State</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const ackedMsAgo =
                it.acknowledgedAt === null ? null : nowMs - new Date(it.acknowledgedAt).getTime()
              const canUndo =
                it.acknowledged &&
                ackedMsAgo !== null &&
                ackedMsAgo >= 0 &&
                ackedMsAgo < undoWindowMs
              const undoSecondsLeft =
                canUndo && ackedMsAgo !== null
                  ? Math.max(0, Math.ceil((undoWindowMs - ackedMsAgo) / 1000))
                  : 0
              return (
                <tr key={it.drawingEntryId}>
                  <td>
                    <Link to={`/reviews/${it.submissionId}`}>{formatDate(it.createdAt)}</Link>
                  </td>
                  <td>{it.siteLabel || `dealer ${it.dealerId}`}</td>
                  <td style={{ fontSize: '0.9em' }}>{contactSummary(it)}</td>
                  <td style={{ maxWidth: '24rem' }}>
                    <Pill tone={starTone(it.starRating)}>{formatStars(it.starRating)}</Pill>
                    {it.reviewTextSnippet && (
                      <div className="subtle-copy" style={{ marginTop: '0.25rem' }}>
                        {it.reviewTextSnippet}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: '0.85em' }}>
                    <div>{segmentPill(it.drawingSegmentStatus, 'drawing')}</div>
                    <div style={{ marginTop: '0.25rem' }}>
                      {segmentPill(it.freePrerollSegmentStatus, 'free preroll')}
                    </div>
                  </td>
                  <td>
                    {it.fraudulent && <Pill tone="danger">fraud</Pill>}
                    {it.acknowledged && (
                      <Pill tone="success">
                        {it.acknowledgedBy ? `acked (${it.acknowledgedBy})` : 'acked'}
                      </Pill>
                    )}
                    {!it.fraudulent && !it.acknowledged && (
                      <span className="subtle-copy">open</span>
                    )}
                  </td>
                  <td>
                    {!it.acknowledged && !it.fraudulent && (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => onAcknowledge(it.submissionId)}
                        disabled={busyId !== null}
                      >
                        {busyId === it.submissionId ? '…' : 'Acknowledge'}
                      </button>
                    )}
                    {it.acknowledged && canUndo && (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => onUndo(it.submissionId)}
                        disabled={busyId !== null}
                        title={`Reversible for ${undoSecondsLeft}s`}
                      >
                        {busyId === it.submissionId ? '…' : `Undo (${undoSecondsLeft}s)`}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <details style={{ marginTop: '1.5rem' }}>
        <summary>About this page (A5 phase status, methodology)</summary>
        <div className="subtle-copy" style={{ marginTop: '0.5rem' }}>
          <p>
            This is the A5 surface of the Customer-Sentiment Capture epic (
            <a
              href="https://github.com/FreshlyBakedNYC/automation/issues/13"
              target="_blank"
              rel="noreferrer"
            >
              issue #13
            </a>
            ). It lists rows in <code>review_drawing_entries</code> that
            have not yet been acknowledged or marked fraudulent — i.e. the
            actionable drawing pool.
          </p>
          <ul>
            <li>
              <strong>Export CSV</strong> streams the rows matching the
              current filters as <code>reviews-drawing-&lt;site&gt;-&lt;YYYYMMDD&gt;.csv</code>{' '}
              with <code>Content-Disposition: attachment</code> (works on
              mobile Safari).
            </li>
            <li>
              <strong>Acknowledge</strong> records the operator + timestamp
              on the row and removes it from the default view. It stays
              queryable via the <em>Include acknowledged</em> filter.
            </li>
            <li>
              <strong>Undo acknowledge</strong> is reversible for{' '}
              {Math.round(data.undoWindowSeconds / 60)} minutes after the
              acknowledge timestamp. After the window expires the
              operator must mark fraudulent (from{' '}
              <code>/reviews/&lt;id&gt;</code>) to re-surface the entry.
            </li>
            <li>
              <strong>Mark fraudulent</strong> (from the detail page) also
              removes the row from the default view here without needing
              an acknowledge — see A4 docs for the segment-remove behaviour.
            </li>
          </ul>
          <p>
            Filters via URL query string: <code>?site=&lt;dealerId&gt;</code>,{' '}
            <code>&amp;since=&lt;ISO date&gt;</code>,{' '}
            <code>&amp;include=acked,fraudulent</code> (comma-separated).
          </p>
        </div>
      </details>
    </section>
  )
}
