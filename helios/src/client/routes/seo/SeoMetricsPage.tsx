// SEO → Metrics (P5 — the GA4/GSC feedback loop).
//
// Read-only dashboard over the imported Search Console daily facts: top
// queries and top pages for a site + date window, plus a collapsed import-
// provenance panel. The recommendation engine (SEO · Recommendations) turns
// the gaps these surface into actionable drafts.
//
// child FreshlyBakedNYC/automation#44 (P5) · Satisfies: virusdave/top-level#15

import { useState } from 'react'
import { useLoaderData } from 'react-router-dom'

import {
  SeoMetricsOverviewResponseSchema,
  type SeoMetricsOverviewResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { nyShortDateTime } from '../../app/nyTime.js'

function isoDaysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

const DEFAULT_SITE = 'all'
const DEFAULT_START = isoDaysAgo(31)
const DEFAULT_END = isoDaysAgo(3)

function overviewUrl(site: string, startDate: string, endDate: string): string {
  const p = new URLSearchParams({ site, startDate, endDate })
  return `/api/seo/metrics/overview?${p.toString()}`
}

export async function seoMetricsLoader(): Promise<SeoMetricsOverviewResponse> {
  return loadJson(
    overviewUrl(DEFAULT_SITE, DEFAULT_START, DEFAULT_END),
    SeoMetricsOverviewResponseSchema,
  )
}

function pct(ctr: number): string {
  return `${(ctr * 100).toFixed(1)}%`
}

function pos(p: number | null): string {
  return p === null ? '—' : p.toFixed(1)
}

function fmt(value: string): string {
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? value : nyShortDateTime(ms)
}

export function SeoMetricsPage() {
  const initial = useLoaderData() as SeoMetricsOverviewResponse
  const [data, setData] = useState<SeoMetricsOverviewResponse>(initial)
  const [site, setSite] = useState(initial.site)
  const [startDate, setStartDate] = useState(initial.startDate)
  const [endDate, setEndDate] = useState(initial.endDate)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function apply() {
    setBusy(true)
    setError(null)
    try {
      const res = await loadJson(
        overviewUrl(site, startDate, endDate),
        SeoMetricsOverviewResponseSchema,
      )
      setData(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1200 }}>
      <h1 style={{ marginTop: 0 }}>SEO · Metrics</h1>

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
          />
        </label>
        <button type="button" onClick={apply} disabled={busy}>
          Apply
        </button>
      </div>

      {error && (
        <p style={{ color: 'var(--danger, #b00020)', whiteSpace: 'pre-wrap' }}>{error}</p>
      )}

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 420 }}>
          <h2>Top queries</h2>
          {data.topQueries.length === 0 ? (
            <p className="subtle-copy">No Search Console data for this window. Import some first.</p>
          ) : (
            <table className="data-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Query</th>
                  <th style={{ textAlign: 'right' }}>Impr.</th>
                  <th style={{ textAlign: 'right' }}>Clicks</th>
                  <th style={{ textAlign: 'right' }}>CTR</th>
                  <th style={{ textAlign: 'right' }}>Pos.</th>
                </tr>
              </thead>
              <tbody>
                {data.topQueries.map((q) => (
                  <tr key={q.query}>
                    <td>{q.query}</td>
                    <td style={{ textAlign: 'right' }}>{q.impressions}</td>
                    <td style={{ textAlign: 'right' }}>{q.clicks}</td>
                    <td style={{ textAlign: 'right' }}>{pct(q.ctr)}</td>
                    <td style={{ textAlign: 'right' }}>{pos(q.avgPosition)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 420 }}>
          <h2>Top pages</h2>
          {data.topPages.length === 0 ? (
            <p className="subtle-copy">No page data for this window.</p>
          ) : (
            <table className="data-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Page</th>
                  <th style={{ textAlign: 'right' }}>Impr.</th>
                  <th style={{ textAlign: 'right' }}>Clicks</th>
                  <th style={{ textAlign: 'right' }}>CTR</th>
                  <th style={{ textAlign: 'right' }}>Pos.</th>
                </tr>
              </thead>
              <tbody>
                {data.topPages.map((p) => (
                  <tr key={p.pageUrl}>
                    <td style={{ wordBreak: 'break-all' }}>{p.pageUrl}</td>
                    <td style={{ textAlign: 'right' }}>{p.impressions}</td>
                    <td style={{ textAlign: 'right' }}>{p.clicks}</td>
                    <td style={{ textAlign: 'right' }}>{pct(p.ctr)}</td>
                    <td style={{ textAlign: 'right' }}>{pos(p.avgPosition)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Import provenance — collapsed by default per helios page rules. */}
      <details style={{ marginTop: 20 }}>
        <summary>Recent imports</summary>
        {data.recentImports.length === 0 ? (
          <p className="subtle-copy">No imports yet. Run scripts/import-seo-metrics.ts.</p>
        ) : (
          <table className="data-table" style={{ width: '100%', marginTop: 8 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>When</th>
                <th style={{ textAlign: 'left' }}>Source</th>
                <th style={{ textAlign: 'left' }}>Site</th>
                <th style={{ textAlign: 'left' }}>Status</th>
                <th style={{ textAlign: 'left' }}>Range</th>
                <th style={{ textAlign: 'right' }}>Ins/Upd/Unch/Rej</th>
              </tr>
            </thead>
            <tbody>
              {data.recentImports.map((b) => (
                <tr key={b.importBatchId}>
                  <td>{fmt(b.createdAt)}</td>
                  <td>{b.source}</td>
                  <td>{b.site}</td>
                  <td>{b.status}</td>
                  <td>
                    {b.exportStartDate ?? '—'}..{b.exportEndDate ?? '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {b.rowsInserted}/{b.rowsUpdated}/{b.rowsUnchanged}/{b.rowsRejected}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
    </div>
  )
}
