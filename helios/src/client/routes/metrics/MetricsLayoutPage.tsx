import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLoaderData } from 'react-router-dom'

import {
  MetricAnnotationsListResponseSchema,
  MetricListResponseSchema,
  type MetricAggregation,
  type MetricAnnotationRecord,
  type MetricDefSummary,
  type MetricListResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'

import { MetricChart } from './MetricChart.js'
import { TimeAxisProvider, useTimeAxis, type TimeWindow } from './TimeAxisContext.js'

const DAY_MS = 24 * 60 * 60 * 1000
const PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '6mo', days: 180 },
  { label: '1y', days: 365 },
]

const ALL_AGGREGATIONS: ReadonlyArray<MetricAggregation> = [
  'total',
  'month',
  'week',
  'date',
  'hour',
  'dow',
  'dom',
  'dofortnight',
]

export async function metricsLoader(): Promise<MetricListResponse> {
  return loadJson('/api/metrics', MetricListResponseSchema)
}

export function MetricsLayoutPage() {
  const { metrics } = useLoaderData() as MetricListResponse

  // Site filter: free-form comma-separated text. Helios doesn't yet
  // have a global site registry to populate a multi-select against;
  // the input is forwarded verbatim as the `sites` query param. P2+
  // can wire in a site-registry-backed multi-select without changing
  // anything else on the page.
  const [sitesParam, setSitesParam] = useState('')
  const [pageAgg, setPageAgg] = useState<MetricAggregation>('date')
  // 90d default window matching the parent epic spec.
  const [initialWindow] = useState<TimeWindow>(() => ({
    fromMs: Date.now() - 90 * DAY_MS,
    toMs: Date.now(),
  }))

  const groups = useMemo(() => groupByMetricGroup(metrics), [metrics])
  const [activeMetricId, setActiveMetricId] = useState<string | null>(metrics[0]?.id ?? null)
  const activeMetric = useMemo(
    () => metrics.find((m) => m.id === activeMetricId) ?? null,
    [metrics, activeMetricId],
  )

  return (
    <TimeAxisProvider initial={initialWindow}>
      <section className="metrics-layout">
        <header className="page-header">
          <div>
            <p className="eyebrow">Business &amp; Performance Metrics</p>
            <h2>{activeMetric?.group ? `${activeMetric.group} — ${activeMetric.title}` : 'Metrics'}</h2>
          </div>
        </header>

        <GlobalControlsBar
          sitesParam={sitesParam}
          onSitesChange={setSitesParam}
          pageAgg={pageAgg}
          onAggChange={setPageAgg}
        />

        {/* Mobile-first metric switcher — visible only at narrow widths
            so the operator never has to scroll past the nav to get to
            the chart on a phone. The left-nav (below) stays available
            for desktop browsing. */}
        <label className="metrics-mobile-switcher">
          metric{' '}
          <select
            value={activeMetricId ?? ''}
            onChange={(e) => setActiveMetricId(e.target.value)}
          >
            {groups.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.metrics.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <div className="metrics-body">
          {/* Chart area FIRST in DOM order so a screen reader / mobile
              user encounters the answer before the navigation. */}
          <div className="metrics-chart-area">
            {activeMetric ? (
              <MetricChartWithAnnotations
                metric={activeMetric}
                sitesParam={sitesParam}
                pageAgg={pageAgg}
              />
            ) : (
              <p className="subtle-copy">No metrics registered.</p>
            )}
          </div>
          <MetricsNav groups={groups} activeMetricId={activeMetricId} onSelect={setActiveMetricId} />
        </div>

        <details className="page-collapsible">
          <summary>About this page</summary>
          <p className="subtle-copy">
            The /metrics page tree is the operator-facing surface for the "Business &amp; Performance Metrics" epic
            (automation#21, satisfying virusdave/top-level#7). All charts on a /metrics page share a single time axis
            by default; toggle the per-chart 🔒/🔓 button to unlock a chart from the shared axis. The annotate mode
            (✏️) lets you click to drop a point annotation or click-drag to mark a range; annotations persist forever
            and appear as coloured ticks at the bottom of every chart whose visible window covers their time.
          </p>
        </details>
      </section>
    </TimeAxisProvider>
  )
}

interface GlobalControlsBarProps {
  readonly sitesParam: string
  readonly onSitesChange: (next: string) => void
  readonly pageAgg: MetricAggregation
  readonly onAggChange: (next: MetricAggregation) => void
}

function GlobalControlsBar({ sitesParam, onSitesChange, pageAgg, onAggChange }: GlobalControlsBarProps) {
  return (
    <div className="metrics-controls">
      <label>
        sites{' '}
        <input
          value={sitesParam}
          onChange={(e) => onSitesChange(e.target.value)}
          placeholder="all sites (comma-separated)"
          size={28}
        />
      </label>
      <label>
        agg{' '}
        <select value={pageAgg} onChange={(e) => onAggChange(e.target.value as MetricAggregation)}>
          {ALL_AGGREGATIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <TimeRangePicker />
    </div>
  )
}

function TimeRangePicker() {
  // Reads/writes the shared TimeAxisContext via children that render
  // inside the provider.
  return (
    <>
      <span className="subtle-copy">range:</span>
      {PRESETS.map((p) => (
        <PresetButton key={p.label} label={p.label} days={p.days} />
      ))}
      <ManualRangeInputs />
    </>
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
    <>
      <input
        type="datetime-local"
        value={toLocalDtInput(axis.window.fromMs)}
        onChange={(e) => {
          const ms = Date.parse(e.target.value)
          if (!Number.isNaN(ms)) axis.setWindow({ fromMs: ms, toMs: axis.window.toMs })
        }}
      />
      <input
        type="datetime-local"
        value={toLocalDtInput(axis.window.toMs)}
        onChange={(e) => {
          const ms = Date.parse(e.target.value)
          if (!Number.isNaN(ms)) axis.setWindow({ fromMs: axis.window.fromMs, toMs: ms })
        }}
      />
    </>
  )
}

function toLocalDtInput(ms: number): string {
  // <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM" in local time.
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`
}

interface MetricsNavProps {
  readonly groups: Array<{ group: string; metrics: MetricDefSummary[] }>
  readonly activeMetricId: string | null
  readonly onSelect: (id: string) => void
}

function MetricsNav({ groups, activeMetricId, onSelect }: MetricsNavProps) {
  return (
    <nav className="metrics-nav" aria-label="Metrics">
      {groups.map((g) => (
        <details key={g.group} open className="metrics-nav-group">
          <summary>{g.group}</summary>
          <ul>
            {g.metrics.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className={
                    'metrics-nav-leaf' + (m.id === activeMetricId ? ' is-active' : '')
                  }
                  onClick={() => onSelect(m.id)}
                  title={m.description}
                >
                  {m.title}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </nav>
  )
}

interface MetricChartWithAnnotationsProps {
  readonly metric: MetricDefSummary
  readonly sitesParam: string
  readonly pageAgg: MetricAggregation
}

function MetricChartWithAnnotations({ metric, sitesParam, pageAgg }: MetricChartWithAnnotationsProps) {
  // Annotation list shared with the chart — we re-fetch on every mutation
  // signal from the chart. We deliberately pull annotations independently
  // of the time window so a freshly-created annotation that lands outside
  // the current view still shows up if the operator pans to it without
  // refetching.
  const [annotations, setAnnotations] = useState<MetricAnnotationRecord[]>([])
  const [refreshSeq, setRefreshSeq] = useState(0)
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
  }, [refreshSeq])
  const onChanged = useCallback(() => setRefreshSeq((n) => n + 1), [])
  return (
    <MetricChart
      metric={metric}
      sitesParam={sitesParam}
      defaultAgg={pageAgg}
      annotations={annotations}
      onAnnotationsChanged={onChanged}
    />
  )
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
