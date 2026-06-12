// SEO → Recommendations (P5 — the GA4/GSC feedback loop).
//
// The operator surface for the recommendation engine: run the generator
// over imported Search Console metrics for a site + date window, then triage
// the resulting DRAFT recommendations. Accepting a faq_gap spawns a draft
// FAQ set (status draft, no approval) and sends the operator straight to its
// editor — where the IRONCLAD human approve→bundle gate still applies
// (canon §1). Nothing here publishes.
//
// child FreshlyBakedNYC/automation#44 (P5) · Satisfies: virusdave/top-level#15

import { useMemo, useState } from 'react'
import { useLoaderData, useNavigate, useRevalidator } from 'react-router-dom'

import {
  SeoRecommendationAcceptResponseSchema,
  SeoRecommendationGenerateResponseSchema,
  SeoRecommendationListResponseSchema,
  type SeoRecommendationListResponse,
  type SeoRecommendationRecord,
  type SeoRecStatus,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyShortDateTime } from '../../app/nyTime.js'
import { Pill, type PillProps } from '../../components/Pill.js'

export async function seoRecommendationsLoader(): Promise<SeoRecommendationListResponse> {
  return loadJson('/api/seo/recommendations?limit=500', SeoRecommendationListResponseSchema)
}

function statusTone(status: SeoRecStatus): PillProps['tone'] {
  switch (status) {
    case 'open':
      return 'warning'
    case 'accepted':
      return 'success'
    case 'dismissed':
      return 'muted'
  }
}

function fmt(value: string | null): string {
  if (value === null) return '—'
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? value : nyShortDateTime(ms)
}

// YYYY-MM-DD `n` days before today (local). Used to seed a sane default
// window whose end excludes GSC's unstable freshest ~3 days.
function isoDaysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export function SeoRecommendationsPage() {
  const data = useLoaderData() as SeoRecommendationListResponse
  const navigate = useNavigate()
  const revalidator = useRevalidator()

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [site, setSite] = useState('all')
  const [startDate, setStartDate] = useState(isoDaysAgo(31))
  const [endDate, setEndDate] = useState(isoDaysAgo(3))
  const [statusFilter, setStatusFilter] = useState<SeoRecStatus | 'all'>('open')

  const visible = useMemo(
    () =>
      statusFilter === 'all'
        ? data.recommendations
        : data.recommendations.filter((r) => r.status === statusFilter),
    [data.recommendations, statusFilter],
  )

  async function generate() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await mutateJson(
        '/api/seo/recommendations/generate',
        SeoRecommendationGenerateResponseSchema,
        { method: 'POST', body: JSON.stringify({ site, startDate, endDate }) },
      )
      setNotice(
        `Generated: ${res.inserted} new, ${res.updated} refreshed, ${res.unchanged} unchanged.`,
      )
      revalidator.revalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function accept(rec: SeoRecommendationRecord) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await mutateJson(
        `/api/seo/recommendations/${rec.recommendationId}/accept`,
        SeoRecommendationAcceptResponseSchema,
        { method: 'POST', body: JSON.stringify({}) },
      )
      // Send the operator straight to the spawned draft (canon §3).
      navigate(`/seo/faq/${res.linkedContentId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  async function dismiss(rec: SeoRecommendationRecord) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await mutateJson(
        `/api/seo/recommendations/${rec.recommendationId}/dismiss`,
        SeoRecommendationListResponseSchema.partial(),
        { method: 'POST', body: JSON.stringify({}) },
      )
      revalidator.revalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1200 }}>
      <h1 style={{ marginTop: 0 }}>SEO · Recommendations</h1>

      {/* Generate controls — the primary action drives the queue. */}
      <div
        className="filter-row wrap-row"
        style={{ gap: 12, alignItems: 'center', marginBottom: 12 }}
      >
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Site
          <input
            type="text"
            value={site}
            onChange={(e) => setSite(e.target.value)}
            disabled={busy}
            title="A concrete site id, or the reserved global token 'all'."
            style={{ width: 120 }}
          />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          From
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            disabled={busy}
          />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          To
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            disabled={busy}
            title="Exclusive; defaults to 3 days ago to skip GSC's unstable freshest days."
          />
        </label>
        <button type="button" onClick={generate} disabled={busy}>
          Generate recommendations
        </button>
        <span style={{ opacity: 0.5 }}>|</span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Show
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as SeoRecStatus | 'all')}
          >
            <option value="open">open</option>
            <option value="accepted">accepted</option>
            <option value="dismissed">dismissed</option>
            <option value="all">all</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => revalidator.revalidate()}
          disabled={busy || revalidator.state === 'loading'}
        >
          Refresh
        </button>
      </div>

      {notice && <p className="subtle-copy">{notice}</p>}
      {error && (
        <p style={{ color: 'var(--danger, #b00020)', whiteSpace: 'pre-wrap' }}>{error}</p>
      )}

      <p className="subtle-copy" style={{ marginTop: 0 }}>
        Recommendations are suggestions only. Accepting a query-gap creates a{' '}
        <strong>draft</strong> FAQ set you still review and approve before it can reach a bundle.
      </p>

      {visible.length === 0 ? (
        <p className="subtle-copy">
          No {statusFilter === 'all' ? '' : statusFilter} recommendations. Import Search Console
          metrics, then generate.
        </p>
      ) : (
        <table className="data-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Type</th>
              <th style={{ textAlign: 'left' }}>Suggestion</th>
              <th style={{ textAlign: 'right' }}>Impressions</th>
              <th style={{ textAlign: 'left' }}>Status</th>
              <th style={{ textAlign: 'left' }}>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.recommendationId}>
                <td>{r.recType}</td>
                <td>
                  <div>{r.title}</div>
                  {r.targetPageUrl && (
                    <div className="subtle-copy" style={{ fontSize: '0.85em' }}>
                      {r.targetPageUrl}
                    </div>
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>{r.priority}</td>
                <td>
                  <Pill tone={statusTone(r.status)}>{r.status}</Pill>
                </td>
                <td>{fmt(r.updatedAt)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {r.status === 'open' ? (
                    <>
                      {r.recType === 'faq_gap' && (
                        <button
                          type="button"
                          onClick={() => accept(r)}
                          disabled={busy}
                          title="Create a draft FAQ set to answer this query."
                        >
                          Accept → draft FAQ
                        </button>
                      )}{' '}
                      <button type="button" onClick={() => dismiss(r)} disabled={busy}>
                        Dismiss
                      </button>
                    </>
                  ) : r.linkedContentKind === 'faq_set' && r.linkedContentId ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/seo/faq/${r.linkedContentId}`)}
                    >
                      Open draft
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
