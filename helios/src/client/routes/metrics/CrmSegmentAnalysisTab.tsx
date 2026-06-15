import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  CrmSegmentAnalysisResponseSchema,
  type CrmComparisonMetric,
  type CrmConfidenceLabel,
  type CrmMetricUnit,
  type CrmSegmentAnalysisResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'

import { ControlsSection } from './ControlsSection.js'
import { CrmSegmentPicker, useCrmSegmentPicker } from './crmSegmentPicker.js'
import { defaultSiteSelection, toggleSiteSelection } from './metricsSiteSelection.js'

// ---------------------------------------------------------------------------
// CRM "Segment Analysis" tab — how the chosen segment differs from the REST
// (everyone − segment). Headline share cards, a comparison table with
// lift/index + significance badges, and affinity tables.
//
// Metrics: basket size, net sales / customer, orders / customer, repeat rate,
// discount rate, margin / customer, gross-margin %, plus category,
// subcategory, and fulfillment-channel affinity. Margin rides the
// invoice-grain margin rollup; subcategory rides the Helios catalog taxonomy.
// Baseline is REST; the stats come from the server (segmentStats.ts) so the
// client just formats.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

const RANGE_PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '6mo', days: 180 },
  { label: '1y', days: 365 },
]

const KNOWN_SITES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'bronx', label: 'Bronx' },
  { id: 'midtown', label: 'Midtown' },
]

const FULFILLMENT_LABELS: Record<string, string> = {
  in_store: 'In-store',
  kiosk: 'Kiosk',
  delivery_prepaid: 'Delivery (prepaid)',
  delivery_cod: 'Delivery (COD)',
  pickup: 'Pickup',
  pickup_prepaid: 'Pickup (prepaid)',
}

const CONFIDENCE_LABEL: Record<CrmConfidenceLabel, string> = {
  strong: 'strong',
  notable: 'notable',
  directional: 'directional',
  too_small: 'too small',
}

function fmtMoney(n: number | null): string {
  if (n === null) return '—'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}
function fmtPct(n: number | null): string {
  if (n === null) return '—'
  return `${(n * 100).toFixed(1)}%`
}
function fmtNum(n: number | null, digits = 2): string {
  if (n === null) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}
function fmtValue(v: number | null, unit: CrmMetricUnit): string {
  if (v === null) return '—'
  if (unit === 'money') return fmtMoney(v)
  if (unit === 'rate') return fmtPct(v)
  if (unit === 'count') return fmtNum(v, 0)
  return fmtNum(v, 2)
}
function fmtDelta(v: number | null, unit: CrmMetricUnit): string {
  if (v === null) return '—'
  const sign = v > 0 ? '+' : ''
  if (unit === 'rate') return `${sign}${(v * 100).toFixed(1)}pp`
  if (unit === 'money') return `${sign}${fmtMoney(v)}`
  return `${sign}${fmtNum(v, 2)}`
}
function fmtIndex(v: number | null): string {
  if (v === null) return '—'
  return `${v.toFixed(2)}×`
}

function ConfBadge({ c }: { c: CrmConfidenceLabel }) {
  return <span className={`crm-conf crm-conf-${c}`}>{CONFIDENCE_LABEL[c]}</span>
}

export function CrmSegmentAnalysisTab() {
  const { segments, segmentsError, selectedSegmentId, setSelectedSegmentId } = useCrmSegmentPicker()

  const [selectedSites, setSelectedSites] = useState<ReadonlySet<string>>(() =>
    defaultSiteSelection(KNOWN_SITES.map((s) => s.id)),
  )
  const [windowDays, setWindowDays] = useState(90)

  const [data, setData] = useState<CrmSegmentAnalysisResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sitesParam = useMemo(() => [...selectedSites].sort().join(','), [selectedSites])

  useEffect(() => {
    if (selectedSegmentId === null) return
    let cancelled = false
    const to = Date.now()
    const from = to - windowDays * DAY_MS
    const params = new URLSearchParams()
    params.set('segmentId', String(selectedSegmentId))
    if (sitesParam) params.set('sites', sitesParam)
    params.set('from', new Date(from).toISOString())
    params.set('to', new Date(to).toISOString())
    setLoading(true)
    setError(null)
    loadJson(`/api/crm/segment-analysis?${params.toString()}`, CrmSegmentAnalysisResponseSchema)
      .then((r) => {
        if (!cancelled) setData(r)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setData(null)
          setError(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedSegmentId, sitesParam, windowDays])

  return (
    <section className="customer-value-tab crm-segments-tab">
      <ControlsSection title="Filters" defaultOpen="always">
        <div className="metrics-controls">
          <CrmSegmentPicker
            segments={segments}
            selectedSegmentId={selectedSegmentId}
            setSelectedSegmentId={setSelectedSegmentId}
          />
          <div className="metrics-control-group">
            <span className="subtle-copy">sites</span>
            <button
              type="button"
              className={selectedSites.size === 0 ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
              onClick={() => setSelectedSites(new Set())}
              aria-pressed={selectedSites.size === 0}
            >
              All
            </button>
            {KNOWN_SITES.map((s) => {
              const active = selectedSites.has(s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  className={active ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
                  onClick={() =>
                    setSelectedSites(toggleSiteSelection(selectedSites, s.id, KNOWN_SITES.length))
                  }
                  aria-pressed={active}
                >
                  {s.label}
                </button>
              )
            })}
          </div>
          <div className="metrics-control-group">
            <span className="subtle-copy">range</span>
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={windowDays === p.days ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
                onClick={() => setWindowDays(p.days)}
                aria-pressed={windowDays === p.days}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </ControlsSection>

      {segmentsError ? <p className="crm-seg-error">Couldn’t load segments: {segmentsError}</p> : null}
      {error ? <p className="crm-seg-error">Couldn’t load analysis: {error}</p> : null}
      {loading && data === null ? <p className="subtle-copy">Loading…</p> : null}

      {data ? <CrmSegmentAnalysisBody data={data} /> : null}
    </section>
  )
}

function CrmSegmentAnalysisBody({ data }: { data: CrmSegmentAnalysisResponse }) {
  const { segment, populations, shares } = data

  return (
    <>
      <div className="customer-value-tab-header crm-seg-header">
        <div>
          <strong>{segment.name}</strong>{' '}
          <span className="subtle-copy">
            · vs rest (everyone − segment) · {segment.scopeLabel}
          </span>
        </div>
        <div className="crm-seg-header-links">
          <Link to={`/metrics/crm-segments?segmentId=${segment.segmentId}`}>← Segment overview</Link>
        </div>
      </div>

      <ul className="crm-seg-notes">
        <li>
          Baseline is <strong>rest</strong> (everyone minus the segment); “everyone” is shown for
          context. Significance is descriptive, not causal — dynamic segments over-index on their
          own defining behaviour by construction.
        </li>
        {data.dataQuality.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>

      {/* Headline share cards */}
      <div className="customer-value-kpis">
        <div className="customer-value-kpi">
          <div className="customer-value-kpi-label" title="Active segment customers ÷ all active customers (window & sites).">
            Customer share
          </div>
          <div className="customer-value-kpi-value">{fmtPct(shares.customerShare)}</div>
        </div>
        <div className="customer-value-kpi">
          <div className="customer-value-kpi-label" title="Segment net sales ÷ all net sales.">
            Net-sales share
          </div>
          <div className="customer-value-kpi-value">{fmtPct(shares.netSalesShare)}</div>
        </div>
        <div className="customer-value-kpi">
          <div className="customer-value-kpi-label" title="Net-sales share ÷ customer share. >1 means the segment punches above its weight.">
            Value index
          </div>
          <div className="customer-value-kpi-value">{fmtIndex(shares.valueIndex)}</div>
        </div>
        <div className="customer-value-kpi">
          <div className="customer-value-kpi-label">Segment / rest customers</div>
          <div className="customer-value-kpi-value">
            {populations.segment.customers.toLocaleString()} / {populations.rest.customers.toLocaleString()}
          </div>
        </div>
      </div>

      {/* Comparison table */}
      <div className="customer-value-card crm-seg-section">
        <h3>Segment vs rest</h3>
        <div className="crm-cmp-scroll">
          <table className="crm-cmp-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Segment</th>
                <th>Rest</th>
                <th>Everyone</th>
                <th>Δ vs rest</th>
                <th>Index</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {data.metrics.map((m: CrmComparisonMetric) => (
                <tr key={m.key}>
                  <th scope="row" title={m.help}>{m.label}</th>
                  <td>{fmtValue(m.segment, m.unit)}</td>
                  <td>{fmtValue(m.rest, m.unit)}</td>
                  <td className="crm-cmp-context">{fmtValue(m.everyone, m.unit)}</td>
                  <td>{fmtDelta(m.deltaVsRest, m.unit)}</td>
                  <td>{fmtIndex(m.indexVsRest)}</td>
                  <td><ConfBadge c={m.confidence} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Category affinity */}
      <div className="customer-value-card crm-seg-section">
        <h3>Category affinity</h3>
        <p className="subtle-copy">
          Customer penetration — share of each population’s active customers who bought the
          category. Ranked by segment penetration; index &gt;1 = over-indexed vs rest.
        </p>
        {data.categoryAffinity.length === 0 ? (
          <p className="crm-seg-empty subtle-copy">No line items in the selected window.</p>
        ) : (
          <div className="crm-cmp-scroll">
            <table className="crm-cmp-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Segment</th>
                  <th>Rest</th>
                  <th>Δ</th>
                  <th>Index</th>
                  <th>Seg rev %</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {data.categoryAffinity.map((c) => (
                  <tr key={c.category}>
                    <th scope="row">{c.category}</th>
                    <td>{fmtPct(c.segmentPenetration)}</td>
                    <td>{fmtPct(c.restPenetration)}</td>
                    <td>{fmtDelta(c.deltaPp, 'rate')}</td>
                    <td>{fmtIndex(c.index)}</td>
                    <td className="crm-cmp-context">{fmtPct(c.segmentRevenueShare)}</td>
                    <td><ConfBadge c={c.confidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Subcategory affinity */}
      <div className="customer-value-card crm-seg-section">
        <h3>Subcategory affinity</h3>
        <p className="subtle-copy">
          One taxonomy level finer than category (from the Helios catalog). Customer
          penetration, ranked by segment penetration; index &gt;1 = over-indexed vs rest.
        </p>
        {data.subcategoryAffinity.length === 0 ? (
          <p className="crm-seg-empty subtle-copy">No catalogued line items in the selected window.</p>
        ) : (
          <div className="crm-cmp-scroll">
            <table className="crm-cmp-table">
              <thead>
                <tr>
                  <th>Subcategory</th>
                  <th>Segment</th>
                  <th>Rest</th>
                  <th>Δ</th>
                  <th>Index</th>
                  <th>Seg rev %</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {data.subcategoryAffinity.map((s) => (
                  <tr key={s.subcategory}>
                    <th scope="row">{s.subcategory}</th>
                    <td>{fmtPct(s.segmentPenetration)}</td>
                    <td>{fmtPct(s.restPenetration)}</td>
                    <td>{fmtDelta(s.deltaPp, 'rate')}</td>
                    <td>{fmtIndex(s.index)}</td>
                    <td className="crm-cmp-context">{fmtPct(s.segmentRevenueShare)}</td>
                    <td><ConfBadge c={s.confidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Channel affinity */}
      <div className="customer-value-card crm-seg-section">
        <h3>Fulfillment-channel affinity</h3>
        <p className="subtle-copy">Order-share of each channel, segment vs rest. Index &gt;1 = over-indexed.</p>
        {data.channelAffinity.length === 0 ? (
          <p className="crm-seg-empty subtle-copy">No orders in the selected window.</p>
        ) : (
          <div className="crm-cmp-scroll">
            <table className="crm-cmp-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Segment</th>
                  <th>Rest</th>
                  <th>Δ</th>
                  <th>Index</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {data.channelAffinity.map((c) => (
                  <tr key={c.channel}>
                    <th scope="row">{FULFILLMENT_LABELS[c.channel] ?? c.channel}</th>
                    <td>{fmtPct(c.segmentShare)}</td>
                    <td>{fmtPct(c.restShare)}</td>
                    <td>{fmtDelta(c.deltaPp, 'rate')}</td>
                    <td>{fmtIndex(c.index)}</td>
                    <td><ConfBadge c={c.confidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
