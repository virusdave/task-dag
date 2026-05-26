import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLoaderData } from 'react-router-dom'

import {
  MetricAnnotationsListResponseSchema,
  MetricListResponseSchema,
  type MetricAggregation,
  type MetricAnnotationRecord,
  type MetricDataStatus,
  type MetricDefSummary,
  type MetricListResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'

import { MetricChart } from './MetricChart.js'
import { TimeAxisProvider, useTimeAxis, type TimeWindow } from './TimeAxisContext.js'

const DAY_MS = 24 * 60 * 60 * 1000
const PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '6mo', days: 180 },
  { label: '1y', days: 365 },
]

const PRIMARY_AGGREGATIONS: ReadonlyArray<MetricAggregation> = ['hour', 'date', 'week', 'month', 'total']
const ADVANCED_AGGREGATIONS: ReadonlyArray<MetricAggregation> = ['dow', 'dom', 'dofortnight']

// Known store dealer ids. Surface a chip-style multi-select instead of the
// free-form input that v1 shipped — operators know "Bronx" / "Midtown", not
// the underlying numeric dealer ids. The values are what the API expects in
// the `?sites=` query string.
//
// If a new store comes online, add it here and the chip strip picks it up.
const KNOWN_SITES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'bronx', label: 'Bronx' },
  { id: 'midtown', label: 'Midtown' },
]

export async function metricsLoader(): Promise<MetricListResponse> {
  return loadJson('/api/metrics', MetricListResponseSchema)
}

export function MetricsLayoutPage() {
  const { metrics } = useLoaderData() as MetricListResponse

  // Site filter: empty Set = all sites. Multi-select against KNOWN_SITES.
  const [selectedSites, setSelectedSites] = useState<ReadonlySet<string>>(() => new Set<string>())
  const sitesParam = useMemo(() => Array.from(selectedSites).join(','), [selectedSites])
  const [pageAgg, setPageAgg] = useState<MetricAggregation>('week')
  // 90d default window matching the parent epic spec.
  const [initialWindow] = useState<TimeWindow>(() => ({
    fromMs: Date.now() - 90 * DAY_MS,
    toMs: Date.now(),
  }))

  // Operator may opt in to seeing pending stubs (engineering view) but they
  // are hidden by default so synthetic random walks can't be mistaken for real
  // business signal.
  const [showPending, setShowPending] = useState(false)

  // Annotations are fetched ONCE at the dashboard level and handed to every
  // card. A global annotation creates an event indicator on every chart at
  // its timestamp.
  const [annotations, setAnnotations] = useState<MetricAnnotationRecord[]>([])
  const [annotationsSeq, setAnnotationsSeq] = useState(0)
  useEffect(() => {
    let cancelled = false
    loadJson('/api/metric-annotations', MetricAnnotationsListResponseSchema)
      .then((r) => {
        if (!cancelled) setAnnotations(r.annotations)
      })
      .catch(() => {
        if (!cancelled) setAnnotations([])
      })
    return () => {
      cancelled = true
    }
  }, [annotationsSeq])
  const onAnnotationsChanged = useCallback(() => setAnnotationsSeq((n) => n + 1), [])

  // Click-to-expand focus panel: at most one expanded metric at a time.
  const [expandedMetricId, setExpandedMetricId] = useState<string | null>(null)
  const focusPanelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!expandedMetricId) return
    // Scroll the focus panel into view on expand. requestAnimationFrame
    // lets the layout settle first so getBoundingClientRect is correct.
    const raf = requestAnimationFrame(() => {
      focusPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return () => cancelAnimationFrame(raf)
  }, [expandedMetricId])
  // Escape closes the focus panel.
  useEffect(() => {
    if (!expandedMetricId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpandedMetricId(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [expandedMetricId])

  const expandedMetric = useMemo(
    () => metrics.find((m) => m.id === expandedMetricId) ?? null,
    [metrics, expandedMetricId],
  )

  // Partition metrics by data status and group.
  const partitioned = useMemo(() => partitionMetrics(metrics), [metrics])
  const realGroups = useMemo(() => groupByMetricGroup(partitioned.real), [partitioned.real])
  const pendingGroups = useMemo(() => groupByMetricGroup(partitioned.pending), [partitioned.pending])

  return (
    <TimeAxisProvider initial={initialWindow}>
      <section className="metrics-dashboard">
        <header className="page-header metrics-dashboard-header">
          <div>
            <p className="eyebrow">Business &amp; Performance Metrics</p>
            <h2>Dashboard</h2>
          </div>
          <DataCoverageBadge
            realCount={partitioned.real.length}
            pendingCount={partitioned.pending.length}
            showPending={showPending}
            onToggleShowPending={setShowPending}
          />
        </header>

        <DashboardControls
          selectedSites={selectedSites}
          onSitesChange={setSelectedSites}
          pageAgg={pageAgg}
          onAggChange={setPageAgg}
        />

        {expandedMetric ? (
          <div className="metrics-focus-panel" ref={focusPanelRef}>
            <div className="metrics-focus-panel-toolbar">
              <span className="subtle-copy">Focus:</span>
              <strong>
                {expandedMetric.group} — {expandedMetric.title}
              </strong>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setExpandedMetricId(null)}
                aria-label="Close focus panel"
              >
                ✕ close
              </button>
            </div>
            <MetricChart
              key={`focus-${expandedMetric.id}`}
              metric={expandedMetric}
              sitesParam={sitesParam}
              defaultAgg={pageAgg}
              annotations={annotations}
              onAnnotationsChanged={onAnnotationsChanged}
              variant="expanded"
            />
          </div>
        ) : null}

        {realGroups.length === 0 ? (
          <p className="subtle-copy">No live metrics registered yet.</p>
        ) : (
          realGroups.map((g) => (
            <MetricGroupSection
              key={`live-${g.group}`}
              group={g.group}
              metrics={g.metrics}
              sitesParam={sitesParam}
              pageAgg={pageAgg}
              annotations={annotations}
              onAnnotationsChanged={onAnnotationsChanged}
              expandedMetricId={expandedMetricId}
              onExpand={setExpandedMetricId}
            />
          ))
        )}

        {pendingGroups.length > 0 ? (
          <details className="metrics-pending-section" open={showPending}>
            <summary>
              <span className="metrics-section-title">Data pending</span>{' '}
              <span className="subtle-copy">
                ({partitioned.pending.length} metric{partitioned.pending.length === 1 ? '' : 's'} awaiting ingest)
              </span>
            </summary>
            <p className="subtle-copy metrics-pending-explainer">
              These metrics are part of the spec but their data sources aren't wired up yet. Click any card to
              read its definition and follow the link to the ingest issue tracking the unblock work.
            </p>
            {pendingGroups.map((g) => (
              <PendingGroupSection key={`pending-${g.group}`} group={g.group} metrics={g.metrics} />
            ))}
          </details>
        ) : null}

        <details className="page-collapsible metrics-help-collapsible">
          <summary>How this dashboard works</summary>
          <ul className="subtle-copy">
            <li>All cards share one time axis (the range picker above). Click any card to open a focus panel with pan / zoom / annotate.</li>
            <li>In the focus panel, use the 🔒/🔓 button to unlock that chart from the shared axis, then pan/zoom independently.</li>
            <li>Hover any chart for a per-timestamp readout; other charts dim a crosshair at the same moment so you can compare.</li>
            <li>Annotations created with scope <em>global</em> appear as event indicators on every chart at their timestamp.</li>
            <li>Site filter: leave all chips off for an all-sites view, or pick one or more stores.</li>
          </ul>
        </details>
      </section>
    </TimeAxisProvider>
  )
}

// ---------------------------------------------------------------------------
// Dashboard chrome
// ---------------------------------------------------------------------------

interface DataCoverageBadgeProps {
  readonly realCount: number
  readonly pendingCount: number
  readonly showPending: boolean
  readonly onToggleShowPending: (v: boolean) => void
}

function DataCoverageBadge({ realCount, pendingCount, showPending, onToggleShowPending }: DataCoverageBadgeProps) {
  return (
    <div className="metrics-coverage-badge">
      <span className="metrics-coverage-chip metrics-coverage-chip--real">{realCount} live</span>
      <span
        className="metrics-coverage-chip metrics-coverage-chip--pending"
        title={pendingCount === 0 ? 'No pending metrics' : 'Click to show or hide pending metrics'}
      >
        {pendingCount} pending
      </span>
      {pendingCount > 0 ? (
        <label className="metrics-coverage-toggle subtle-copy">
          <input type="checkbox" checked={showPending} onChange={(e) => onToggleShowPending(e.target.checked)} />{' '}
          show pending
        </label>
      ) : null}
    </div>
  )
}

interface DashboardControlsProps {
  readonly selectedSites: ReadonlySet<string>
  readonly onSitesChange: (next: ReadonlySet<string>) => void
  readonly pageAgg: MetricAggregation
  readonly onAggChange: (next: MetricAggregation) => void
}

function DashboardControls({ selectedSites, onSitesChange, pageAgg, onAggChange }: DashboardControlsProps) {
  return (
    <div className="metrics-controls">
      <div className="metrics-control-group">
        <span className="subtle-copy">sites</span>
        <button
          type="button"
          className={selectedSites.size === 0 ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
          onClick={() => onSitesChange(new Set())}
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
              onClick={() => {
                const next = new Set(selectedSites)
                if (active) next.delete(s.id)
                else next.add(s.id)
                onSitesChange(next)
              }}
              aria-pressed={active}
            >
              {s.label}
            </button>
          )
        })}
      </div>

      <div className="metrics-control-group">
        <label>
          aggregation{' '}
          <select value={pageAgg} onChange={(e) => onAggChange(e.target.value as MetricAggregation)}>
            {PRIMARY_AGGREGATIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
            <optgroup label="advanced">
              {ADVANCED_AGGREGATIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
      </div>

      <div className="metrics-control-group">
        <span className="subtle-copy">range</span>
        {PRESETS.map((p) => (
          <PresetButton key={p.label} label={p.label} days={p.days} />
        ))}
        <details className="metrics-range-custom">
          <summary>custom</summary>
          <ManualRangeInputs />
        </details>
      </div>
    </div>
  )
}

function PresetButton({ label, days }: { label: string; days: number }) {
  const axis = useTimeAxis()
  return (
    <button
      type="button"
      className="ghost-button"
      onClick={() => axis.setWindow({ fromMs: Date.now() - days * DAY_MS, toMs: Date.now() })}
    >
      {label}
    </button>
  )
}

function ManualRangeInputs() {
  const axis = useTimeAxis()
  return (
    <div className="metrics-range-custom-inputs">
      <label className="subtle-copy">
        from{' '}
        <input
          type="datetime-local"
          value={toLocalDtInput(axis.window.fromMs)}
          onChange={(e) => {
            const ms = Date.parse(e.target.value)
            if (!Number.isNaN(ms)) axis.setWindow({ fromMs: ms, toMs: axis.window.toMs })
          }}
        />
      </label>
      <label className="subtle-copy">
        to{' '}
        <input
          type="datetime-local"
          value={toLocalDtInput(axis.window.toMs)}
          onChange={(e) => {
            const ms = Date.parse(e.target.value)
            if (!Number.isNaN(ms)) axis.setWindow({ fromMs: axis.window.fromMs, toMs: ms })
          }}
        />
      </label>
    </div>
  )
}

function toLocalDtInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface MetricGroupSectionProps {
  readonly group: string
  readonly metrics: ReadonlyArray<MetricDefSummary>
  readonly sitesParam: string
  readonly pageAgg: MetricAggregation
  readonly annotations: ReadonlyArray<MetricAnnotationRecord>
  readonly onAnnotationsChanged: () => void
  readonly expandedMetricId: string | null
  readonly onExpand: (id: string) => void
}

function MetricGroupSection({
  group,
  metrics,
  sitesParam,
  pageAgg,
  annotations,
  onAnnotationsChanged,
  expandedMetricId,
  onExpand,
}: MetricGroupSectionProps) {
  return (
    <section className="metrics-group">
      <h3 className="metrics-section-title">{group}</h3>
      <div className="metrics-grid">
        {metrics.map((m) => (
          <MetricChart
            key={m.id}
            metric={m}
            sitesParam={sitesParam}
            defaultAgg={pageAgg}
            annotations={annotations}
            onAnnotationsChanged={onAnnotationsChanged}
            variant="card"
            onExpand={() => onExpand(m.id === expandedMetricId ? '' : m.id)}
          />
        ))}
      </div>
    </section>
  )
}

interface PendingGroupSectionProps {
  readonly group: string
  readonly metrics: ReadonlyArray<MetricDefSummary>
}

function PendingGroupSection({ group, metrics }: PendingGroupSectionProps) {
  return (
    <section className="metrics-group">
      <h4 className="metrics-section-subtitle">{group}</h4>
      <div className="metrics-grid">
        {metrics.map((m) => (
          <PendingMetricCard key={m.id} metric={m} />
        ))}
      </div>
    </section>
  )
}

function PendingMetricCard({ metric }: { metric: MetricDefSummary }) {
  // Strip the "STUB:" prefix that the stub factory bakes into the description;
  // it's noise here because the whole card is already labelled "Data pending".
  const friendlyDescription = metric.description.replace(/^STUB:\s*synthetic data — real-data SQL pending\.\s*/i, '')
  return (
    <article className="metric-chart-card metric-chart-card--pending">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">{metric.title}</h3>
          <span className="metric-chart-pending-badge">Data pending</span>
        </div>
      </header>
      <div className="metric-chart-pending-body">
        <p className="subtle-copy">{friendlyDescription || 'Data source for this metric is not yet wired up.'}</p>
        {metric.blockedByUrl ? (
          <p className="subtle-copy">
            Tracked in{' '}
            <a href={metric.blockedByUrl} target="_blank" rel="noreferrer noopener">
              {metric.blockedByUrl.replace(/^https?:\/\//, '')}
            </a>
          </p>
        ) : null}
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PartitionedMetrics {
  readonly real: ReadonlyArray<MetricDefSummary>
  readonly pending: ReadonlyArray<MetricDefSummary>
}

function partitionMetrics(metrics: ReadonlyArray<MetricDefSummary>): PartitionedMetrics {
  const real: MetricDefSummary[] = []
  const pending: MetricDefSummary[] = []
  for (const m of metrics) {
    const status: MetricDataStatus = m.dataStatus ?? 'real'
    if (status === 'real') real.push(m)
    else if (status === 'pending') pending.push(m)
    // 'demo' metrics are hidden from the operator dashboard entirely.
  }
  return { real, pending }
}

function groupByMetricGroup(
  metrics: ReadonlyArray<MetricDefSummary>,
): Array<{ group: string; metrics: MetricDefSummary[] }> {
  const byGroup = new Map<string, MetricDefSummary[]>()
  for (const m of metrics) {
    const list = byGroup.get(m.group) ?? []
    list.push(m)
    byGroup.set(m.group, list)
  }
  return Array.from(byGroup.entries())
    .map(([group, metrics]) => ({ group, metrics: metrics.slice().sort((a, b) => a.title.localeCompare(b.title)) }))
    .sort((a, b) => a.group.localeCompare(b.group))
}
