import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  CrmSegmentListResponseSchema,
  CrmSegmentMetricsResponseSchema,
  type CrmRecencyBucketKey,
  type CrmSegmentListItem,
  type CrmSegmentMetricsResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'

import { ControlsSection } from './ControlsSection.js'
import { defaultSiteSelection, toggleSiteSelection } from './metricsSiteSelection.js'

// ---------------------------------------------------------------------------
// CRM "Segments" tab — metrics ABOUT a chosen segment (composition, growth,
// activity, recency, fulfillment). The segment-vs-rest / segment-vs-everyone
// comparison lives on the companion "CRM Segment Analysis" tab.
//
// Phase 1: header-grain only (no margin / category mix yet — those land with
// the per-customer daily fact rollups; see EPIC_PLAN.md §4). Mobile-first:
// the segment picker + filters stack, KPIs flow in an auto-fit grid, and the
// distribution sections render as 100%-width horizontal bars rather than
// dense tables.
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

const RECENCY_LABELS: Record<CrmRecencyBucketKey, string> = {
  '0_30': '0–30 days',
  '31_60': '31–60 days',
  '61_90': '61–90 days',
  '91_180': '91–180 days',
  '181_plus': '181+ days',
  never: 'Never purchased',
}

const FULFILLMENT_LABELS: Record<string, string> = {
  in_store: 'In-store',
  kiosk: 'Kiosk',
  delivery_prepaid: 'Delivery (prepaid)',
  delivery_cod: 'Delivery (COD)',
  pickup: 'Pickup',
  pickup_prepaid: 'Pickup (prepaid)',
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function fmtMoney(n: number | null): string {
  if (n === null) return '—'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function fmtMoney2(n: number | null): string {
  if (n === null) return '—'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtPct(n: number | null): string {
  if (n === null) return '—'
  return `${(n * 100).toFixed(1)}%`
}

function fmtNum(n: number | null, digits = 1): string {
  if (n === null) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

interface BarRow {
  readonly key: string
  readonly label: string
  readonly value: number
  readonly display: string
}

function BarList({ rows, emptyLabel }: { rows: ReadonlyArray<BarRow>; emptyLabel: string }) {
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0)
  if (rows.length === 0 || max === 0) {
    return <p className="crm-seg-empty subtle-copy">{emptyLabel}</p>
  }
  return (
    <ul className="crm-seg-barlist">
      {rows.map((r) => (
        <li key={r.key} className="crm-seg-bar">
          <span className="crm-seg-bar-label">{r.label}</span>
          <span className="crm-seg-bar-track">
            <span
              className="crm-seg-bar-fill"
              style={{ width: `${max > 0 ? (r.value / max) * 100 : 0}%` }}
            />
          </span>
          <span className="crm-seg-bar-value">{r.display}</span>
        </li>
      ))}
    </ul>
  )
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="customer-value-kpi">
      <div className="customer-value-kpi-label" title={hint}>
        {label}
      </div>
      <div className="customer-value-kpi-value">{value}</div>
    </div>
  )
}

export function CrmSegmentsTab() {
  const [segments, setSegments] = useState<ReadonlyArray<CrmSegmentListItem>>([])
  const [segmentsError, setSegmentsError] = useState<string | null>(null)
  const [selectedSegmentId, setSelectedSegmentId] = useState<number | null>(null)

  const [selectedSites, setSelectedSites] = useState<ReadonlySet<string>>(() =>
    defaultSiteSelection(KNOWN_SITES.map((s) => s.id)),
  )
  const [windowDays, setWindowDays] = useState(90)

  const [data, setData] = useState<CrmSegmentMetricsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load the picker list once.
  useEffect(() => {
    let cancelled = false
    loadJson('/api/crm/segments', CrmSegmentListResponseSchema)
      .then((r) => {
        if (cancelled) return
        setSegments(r.segments)
        // Default to the largest segment with cached members.
        const firstWithMembers = r.segments.find((s) => s.cachedMemberCount > 0) ?? r.segments[0]
        if (firstWithMembers) setSelectedSegmentId((cur) => cur ?? firstWithMembers.segmentId)
      })
      .catch((e: unknown) => {
        if (!cancelled) setSegmentsError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const sitesParam = useMemo(
    () => [...selectedSites].sort().join(','),
    [selectedSites],
  )

  // Load metrics whenever the segment / scope / window changes.
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
    loadJson(`/api/crm/segment-metrics?${params.toString()}`, CrmSegmentMetricsResponseSchema)
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

  // Group segments by scope for the picker's optgroups.
  const segmentGroups = useMemo(() => {
    const order: ReadonlyArray<{ key: string; label: string }> = [
      { key: 'state', label: 'All-store / state' },
      { key: 'site', label: 'Site' },
      { key: 'unknown', label: 'Other' },
    ]
    return order
      .map((g) => ({
        ...g,
        items: segments.filter((s) => s.scopeLevel === g.key),
      }))
      .filter((g) => g.items.length > 0)
  }, [segments])

  return (
    <section className="customer-value-tab crm-segments-tab">
      <ControlsSection title="Filters" defaultOpen="always">
        <div className="metrics-controls">
          <div className="metrics-control-group">
            <span className="subtle-copy">segment</span>
            <select
              className="crm-seg-picker"
              value={selectedSegmentId ?? ''}
              onChange={(e) => setSelectedSegmentId(e.target.value ? Number(e.target.value) : null)}
            >
              {selectedSegmentId === null ? <option value="">Select a segment…</option> : null}
              {segmentGroups.map((g) => (
                <optgroup key={g.key} label={g.label}>
                  {g.items.map((s) => (
                    <option key={s.segmentId} value={s.segmentId}>
                      {s.name} · {fmtInt(s.cachedMemberCount)} members
                      {s.enabled === false ? ' · disabled' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

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
            {RANGE_PRESETS.map((p) => {
              const active = windowDays === p.days
              return (
                <button
                  key={p.label}
                  type="button"
                  className={active ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
                  onClick={() => setWindowDays(p.days)}
                  aria-pressed={active}
                >
                  {p.label}
                </button>
              )
            })}
          </div>
        </div>
      </ControlsSection>

      {segmentsError ? <p className="crm-seg-error">Couldn’t load segments: {segmentsError}</p> : null}
      {error ? <p className="crm-seg-error">Couldn’t load metrics: {error}</p> : null}
      {loading && data === null ? <p className="subtle-copy">Loading…</p> : null}

      {data ? <CrmSegmentsBody data={data} /> : null}
    </section>
  )
}

function CrmSegmentsBody({ data }: { data: CrmSegmentMetricsResponse }) {
  const { segment, membership, activity } = data
  const memberCount = membership.cachedMemberCount

  const recencyRows: BarRow[] = data.recencyBuckets.map((b) => ({
    key: b.bucket,
    label: RECENCY_LABELS[b.bucket],
    value: b.memberCount,
    display: fmtInt(b.memberCount),
  }))

  const fulfillmentRows: BarRow[] = data.fulfillmentMix.map((f) => ({
    key: f.channel,
    label: FULFILLMENT_LABELS[f.channel] ?? f.channel,
    value: f.orders,
    display: `${fmtInt(f.orders)} · ${fmtMoney(f.netSalesDollars)}`,
  }))

  const entryRows: BarRow[] = data.entryHistogram.map((e) => ({
    key: e.weekStart,
    label: e.weekStart,
    value: e.count,
    display: fmtInt(e.count),
  }))

  return (
    <>
      <div className="customer-value-tab-header crm-seg-header">
        <div>
          <strong>{segment.name}</strong>{' '}
          <span className="subtle-copy">
            · {segment.type} · {segment.scopeLabel}
            {segment.enabled === false ? ' · disabled' : ''}
          </span>
        </div>
        <div className="crm-seg-header-links">
          <Link to={`/config/marketing/segments/${segment.segmentId}`}>Manage / refresh →</Link>
          <a href={segment.sweedPrimeUrl} target="_blank" rel="noreferrer">
            Open in Sweed →
          </a>
        </div>
      </div>

      {data.dataQuality.length > 0 ? (
        <ul className="crm-seg-notes">
          {data.dataQuality.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}

      <div className="customer-value-kpis">
        <Kpi label="Cached members" value={fmtInt(memberCount)} hint="Customers in the local membership cache for this segment." />
        <Kpi
          label="Active members"
          value={fmtInt(activity.activeMembers)}
          hint="Members with ≥1 non-cancelled order in the selected window & sites."
        />
        <Kpi label="Active rate" value={fmtPct(activity.activeRate)} hint="Active members ÷ cached members." />
        <Kpi label="Orders" value={fmtInt(activity.orders)} />
        <Kpi label="Avg order value" value={fmtMoney2(activity.avgOrderValueDollars)} hint="Gross receipts ÷ orders (incl. tax)." />
        <Kpi label="Orders / active member" value={fmtNum(activity.ordersPerActiveMember, 2)} />
        <Kpi label="Net sales" value={fmtMoney(activity.netSalesDollars)} hint="After-discount, pre-tax." />
        <Kpi label="Net sales / member" value={fmtMoney2(activity.netSalesPerMember)} hint="Per cached member (incl. inactive)." />
        <Kpi label="Net sales / active member" value={fmtMoney2(activity.netSalesPerActiveMember)} />
        <Kpi label="Discounts" value={fmtMoney(activity.discountDollars)} />
      </div>

      <div className="customer-value-grid">
        <div className="customer-value-card crm-seg-section">
          <h3>Recency — days since last purchase</h3>
          <p className="subtle-copy">Per cached member, across all their orders up to the window end.</p>
          <BarList rows={recencyRows} emptyLabel="No purchase history for these members." />
        </div>

        <div className="customer-value-card crm-seg-section">
          <h3>Fulfillment mix</h3>
          <p className="subtle-copy">Orders · net sales by channel, in the selected window.</p>
          <BarList rows={fulfillmentRows} emptyLabel="No orders in the selected window." />
        </div>

        <div className="customer-value-card crm-seg-section">
          <h3>Membership growth — entries / week</h3>
          <p className="subtle-copy">
            Based on current cached members’ entry dates (last 52 weeks). Not historical exits.
          </p>
          <BarList rows={entryRows} emptyLabel="No dated entries in the last 52 weeks." />
        </div>
      </div>
    </>
  )
}
