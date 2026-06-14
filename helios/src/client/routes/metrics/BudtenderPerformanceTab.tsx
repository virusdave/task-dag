import { useEffect, useMemo, useState } from 'react'

import {
  BudtenderAnalyticsResponseSchema,
  type BudtenderAnalyticsResponse,
  type BudtenderCashierRow,
  type BudtenderMissingDataCard,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { ControlsSection } from './ControlsSection.js'
import { niceXTicks, niceYTicks } from './gridlines.js'
import { HelpIcon } from './MetricChart.js'
import { defaultSiteSelection, toggleSiteSelection } from './metricsSiteSelection.js'
import { RangeNudgeRow } from './RangeNudgeRow.js'
import { computeCompactDomain } from './scatterAutoZoom.js'
import { useMetricSelection } from './useMetricSelection.js'
import {
  buildStructuredHighlightMatcher,
  emptyHighlightSelection,
  HighlightControls,
  type HighlightDimensionSpec,
  type HighlightSelectionState,
} from './HighlightControls.js'

// v1.4 V4'4: synthetic metric id for the Budtender Advanced cashier
// scatter (this panel is served by /api/budtender-analytics, not the
// /api/metrics registry). The URL `?selection=…` payload keys off
// this so share-links reproduce the drilled cashier dot.
const BUDTENDER_CASHIER_SCATTER_METRIC_ID = 'budtender.cashier-scatter'

// ---------------------------------------------------------------------------
// Budtender Performance dashboard tab.
//
// Two sub-tabs:
//   * Core      — KPI strip, daily trend, leaderboard, dollar-basket
//                 upsell lift, customer/fulfillment mix, MISSING DATA
//                 cards for blocked sources.
//   * Advanced  — one-dot-per-cashier scatter with switchable
//                 X / Y / colour / size / opacity encodings (peer-
//                 percentile colour, transaction-count size, etc.)
//                 and a free-text highlight subset query.
//
// All cards eat from a SINGLE /api/budtender-analytics fetch (see
// budtenderAnalyticsQueries.ts) — the response is small enough that
// any further pivoting happens client-side without another round-trip.
//
// Per oracle's design and the operator's mandate: NEVER fabricate.
// Cards backed by data we don't have today render MISSING DATA
// instead.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

const RANGE_PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '6mo', days: 180 },
  { label: '1y', days: 365 },
]

const KNOWN_SITES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'bronx', label: 'Bronx' },
  { id: 'midtown', label: 'Midtown' },
]

const LOW_SAMPLE_THRESHOLD = 10
const HIDE_BELOW_SAMPLE = 5

type SubTab = 'core' | 'advanced'

export function BudtenderPerformanceTab(): JSX.Element {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('core')
  const [windowDays, setWindowDays] = useState<number>(90)
  const [customRangeOpen, setCustomRangeOpen] = useState<boolean>(false)
  const [customFromMs, setCustomFromMs] = useState<number>(Date.now() - 90 * DAY_MS)
  const [customToMs, setCustomToMs] = useState<number>(Date.now())
  const [useCustomRange, setUseCustomRange] = useState<boolean>(false)
  const [selectedSites, setSelectedSites] = useState<ReadonlySet<string>>(() => defaultSiteSelection())

  const [data, setData] = useState<BudtenderAnalyticsResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const { fromMs, toMs } = useMemo(() => {
    if (useCustomRange) return { fromMs: customFromMs, toMs: customToMs }
    const to = Date.now()
    return { fromMs: to - windowDays * DAY_MS, toMs: to }
  }, [useCustomRange, customFromMs, customToMs, windowDays])

  const sitesParam = useMemo(() => Array.from(selectedSites).join(','), [selectedSites])

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams()
    params.set('from', new Date(fromMs).toISOString())
    params.set('to', new Date(toMs).toISOString())
    if (sitesParam) params.set('sites', sitesParam)
    setLoading(true)
    setError(null)
    loadJson(`/api/budtender-analytics?${params.toString()}`, BudtenderAnalyticsResponseSchema)
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
  }, [fromMs, toMs, sitesParam])

  return (
    <section className="budtender-perf-tab">
      <div className="budtender-perf-controls metrics-controls">
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
                onClick={() => setSelectedSites(toggleSiteSelection(selectedSites, s.id, KNOWN_SITES.length))}
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
            const active = !useCustomRange && windowDays === p.days
            return (
              <button
                key={p.label}
                type="button"
                className={active ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
                onClick={() => {
                  setUseCustomRange(false)
                  setWindowDays(p.days)
                }}
                aria-pressed={active}
              >
                {p.label}
              </button>
            )
          })}
          <details
            className="metrics-range-custom"
            open={customRangeOpen}
            onToggle={(e) => setCustomRangeOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary>custom</summary>
            <div className="metrics-range-custom-inputs">
              <label className="subtle-copy">
                from{' '}
                <input
                  type="datetime-local"
                  value={toLocalDtInput(customFromMs)}
                  onChange={(e) => {
                    const ms = Date.parse(e.target.value)
                    if (!Number.isNaN(ms)) {
                      setCustomFromMs(ms)
                      setUseCustomRange(true)
                    }
                  }}
                />
              </label>
              <label className="subtle-copy">
                to{' '}
                <input
                  type="datetime-local"
                  value={toLocalDtInput(customToMs)}
                  onChange={(e) => {
                    const ms = Date.parse(e.target.value)
                    if (!Number.isNaN(ms)) {
                      setCustomToMs(ms)
                      setUseCustomRange(true)
                    }
                  }}
                />
              </label>
            </div>
            <RangeNudgeRow
              range={{ fromMs, toMs }}
              setRange={(next) => {
                // Nudging from a preset implicitly converts the window
                // to a custom range; the preset chip stops being
                // active because `useCustomRange` is now true.
                setCustomFromMs(next.fromMs)
                setCustomToMs(next.toMs)
                setUseCustomRange(true)
              }}
            />
          </details>
        </div>
      </div>

      <nav
        className="budtender-perf-subtabs"
        role="tablist"
        aria-label="Budtender performance sub-tabs"
      >
        {(['core', 'advanced'] as SubTab[]).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeSubTab === id}
            className={
              activeSubTab === id ? 'metrics-site-chip is-active' : 'metrics-site-chip'
            }
            onClick={() => setActiveSubTab(id)}
          >
            {id === 'core' ? 'Core' : 'Advanced'}
          </button>
        ))}
      </nav>

      {error ? (
        <p className="metric-chart-error">Failed to load: {error}</p>
      ) : loading && !data ? (
        <p className="subtle-copy">Loading…</p>
      ) : data ? (
        activeSubTab === 'core' ? (
          <CoreSubTab data={data} />
        ) : (
          <AdvancedSubTab data={data} />
        )
      ) : null}
    </section>
  )
}

// =============================== Sub-tabs ==================================

function CoreSubTab({ data }: { data: BudtenderAnalyticsResponse }) {
  return (
    <div className="budtender-perf-core">
      <TotalsStrip data={data} />
      <DailyTrendCard data={data} />
      <LeaderboardCard data={data} />
      <UpsellLiftCard data={data} />
      <MixCard data={data} />
      <ShiftProductivityCard data={data} />
      <MissingDataSection cards={data.missingDataCards} />
    </div>
  )
}

function AdvancedSubTab({ data }: { data: BudtenderAnalyticsResponse }) {
  return (
    <div className="budtender-perf-advanced">
      <CashierScatterCard data={data} />
      <MissingDataSection cards={data.missingDataCards} compact />
    </div>
  )
}

// =============================== KPI strip =================================

function TotalsStrip({ data }: { data: BudtenderAnalyticsResponse }) {
  const t = data.totals
  return (
    <div className="budtender-totals-strip">
      <Kpi label="Attributed transactions" value={fmtInt(t.attributedTransactions)} />
      <Kpi
        label="Unassigned (cashier missing)"
        value={fmtInt(t.unassignedTransactions)}
        tone={t.unassignedTransactions > 0 ? 'warn' : 'ok'}
      />
      <Kpi label="Attributed sales" value={fmtMoney(t.attributedSales)} />
      <Kpi label="Active cashiers" value={fmtInt(t.activeCashiers)} />
      <Kpi label="Avg order value" value={fmtMoneyOrDash(t.avgOrderValue)} />
      <Kpi label="Discount rate" value={fmtPctOrDash(t.discountRate)} />
    </div>
  )
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'ok' | 'warn'
}) {
  return (
    <div className={`budtender-kpi${tone === 'warn' ? ' is-warn' : ''}`}>
      <div className="budtender-kpi-value">{value}</div>
      <div className="budtender-kpi-label subtle-copy">{label}</div>
    </div>
  )
}

// =============================== Daily trend ===============================

function DailyTrendCard({ data }: { data: BudtenderAnalyticsResponse }) {
  type Metric = 'sales' | 'transactions' | 'aov' | 'discount'
  const [metric, setMetric] = useState<Metric>('sales')
  if (data.daily.length === 0) {
    return (
      <article className="metric-chart-card">
        <header className="metric-chart-header">
          <div className="metric-chart-titlewrap">
            <h3 className="metric-chart-title">
              Daily attributed activity{' '}
              <HelpIcon text="Per-day sum of orders that carry a cashier attribution (cashier_user_id IS NOT NULL). The 'unassigned' KPI above counts orders that don't — they're excluded from per-cashier metrics." />
            </h3>
          </div>
        </header>
        <p className="subtle-copy">No daily activity in range.</p>
      </article>
    )
  }
  const values = data.daily.map((d) => {
    switch (metric) {
      case 'sales':
        return d.sales
      case 'transactions':
        return d.transactions
      case 'aov':
        return d.avgOrderValue ?? 0
      case 'discount':
        return (d.discountRate ?? 0) * 100
    }
  })
  return (
    <article className="metric-chart-card">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">
            Daily attributed activity{' '}
            <HelpIcon text="Per-day rollup of all orders attributed to any cashier. Switch the metric selector to see sales, transaction count, average order value, or effective discount rate (sum(discount)/sum(subtotal)). Unassigned transactions are visible in the KPI strip above but excluded here." />
          </h3>
        </div>
        <div className="metric-chart-controls">
          <label>
            metric{' '}
            <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
              <option value="sales">sales $</option>
              <option value="transactions">transactions</option>
              <option value="aov">avg order value</option>
              <option value="discount">discount %</option>
            </select>
          </label>
        </div>
      </header>
      <Sparkline
        days={data.daily.map((d) => d.day)}
        values={values}
        format={
          metric === 'sales' || metric === 'aov'
            ? fmtMoney
            : metric === 'discount'
              ? (v) => `${v.toFixed(1)}%`
              : fmtInt
        }
      />
    </article>
  )
}

// Minimal SVG sparkline. Lives here rather than reusing MetricChart
// because MetricChart insists on a registry-driven metric definition
// and a server query — neither of which we want for this tiny derived
// series. It still honours the dashboard look-and-feel: gridlines at
// human-friendly intervals, smooth curve, x markers on points.
function Sparkline({
  days,
  values,
  format,
}: {
  days: string[]
  values: number[]
  format: (v: number) => string
}) {
  const W = 700
  const H = 220
  const PAD_L = 56
  const PAD_R = 8
  const PAD_T = 12
  const PAD_B = 28
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B
  const n = values.length
  if (n === 0) return null
  const minV = Math.min(0, ...values)
  const maxV = Math.max(...values, 1)
  // v1.4 V4'1: shared niceYTicks helper from gridlines.ts so the
  // sparkline's Y-axis ticks match the rest of the dashboard
  // (1 / 2 / 2.5 / 5 / 10 × 10^k ladder; least-significant digit
  // never 3/7/9 — v1.2 R5 oracle-flagged regression guard).
  const ticks = niceYTicks(minV, maxV, 5).ticks
  const yScale = (v: number) =>
    PAD_T + plotH - ((v - ticks[0]!) / Math.max(1e-9, ticks[ticks.length - 1]! - ticks[0]!)) * plotH
  const xScale = (i: number) => PAD_L + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  // Smooth monotone curve approximation via Catmull-Rom-ish quadratic
  // midpoints so a flat run between two peaks doesn't overshoot.
  let path = ''
  for (let i = 0; i < n; i++) {
    const x = xScale(i)
    const y = yScale(values[i]!)
    if (i === 0) path += `M ${x.toFixed(2)} ${y.toFixed(2)}`
    else {
      const xp = xScale(i - 1)
      const yp = yScale(values[i - 1]!)
      const cx = (xp + x) / 2
      path += ` C ${cx.toFixed(2)} ${yp.toFixed(2)}, ${cx.toFixed(2)} ${y.toFixed(2)}, ${x.toFixed(2)} ${y.toFixed(2)}`
    }
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily activity sparkline" className="budtender-sparkline">
      {ticks.map((t, i) => (
        <g key={`hg-${i}`}>
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={yScale(t)}
            y2={yScale(t)}
            stroke="#d8d8d8"
            strokeWidth={0.8}
            strokeDasharray="3 3"
            pointerEvents="none"
          />
          <text x={PAD_L - 6} y={yScale(t)} textAnchor="end" dominantBaseline="central" fontSize={10} fill="#666">
            {format(t)}
          </text>
        </g>
      ))}
      <path d={path} fill="none" stroke="#2c6cb6" strokeWidth={1.75} />
      {values.map((v, i) => (
        <g key={`pt-${i}`}>
          <text
            x={xScale(i)}
            y={yScale(v)}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={9}
            fill="#2c6cb6"
          >
            ×
          </text>
        </g>
      ))}
      {days.map((d, i) => {
        // Sparse x labels — every Nth day so the axis stays readable.
        const step = Math.max(1, Math.ceil(n / 8))
        if (i % step !== 0 && i !== n - 1) return null
        return (
          <text
            key={`xl-${i}`}
            x={xScale(i)}
            y={H - 6}
            textAnchor="middle"
            fontSize={9}
            fill="#666"
          >
            {shortDay(d)}
          </text>
        )
      })}
    </svg>
  )
}

// ============================== Leaderboard ================================

type LeaderboardSort =
  | 'sales'
  | 'transactions'
  | 'aov'
  | 'discountRate'
  | 'firstTime'
  | 'sameLift'
  | 'txnPerHr'

function LeaderboardCard({ data }: { data: BudtenderAnalyticsResponse }) {
  const [sort, setSort] = useState<LeaderboardSort>('sales')
  const cashiers = useMemo(() => sortCashiers(data.cashiers, sort), [data.cashiers, sort])
  if (cashiers.length === 0) {
    return (
      <article className="metric-chart-card">
        <header className="metric-chart-header">
          <div className="metric-chart-titlewrap">
            <h3 className="metric-chart-title">
              Budtender leaderboard{' '}
              <HelpIcon text="Sortable per-cashier scorecard. Each row is one cashier over the selected window. Bars show the sort metric. The 'lift $/order' column is dollar-basket lift vs the same customer's leave-one-out average (not quantity upsell — line items aren't ingested yet)." />
            </h3>
          </div>
          <div className="metric-chart-controls">
            <label>
              sort{' '}
              <select value={sort} onChange={(e) => setSort(e.target.value as LeaderboardSort)}>
                <option value="sales">sales $</option>
                <option value="transactions">transactions</option>
                <option value="aov">avg order value</option>
                <option value="discountRate">discount rate</option>
                <option value="firstTime">first-time cust %</option>
                <option value="sameLift">same-cust lift $</option>
                <option value="txnPerHr">txn / drawer-hr</option>
              </select>
            </label>
          </div>
        </header>
        <p className="subtle-copy">No cashier-attributed orders in range.</p>
      </article>
    )
  }
  const sortValueMax = Math.max(
    1e-9,
    ...cashiers.map((c) => Math.abs(sortValue(c, sort) ?? 0)),
  )
  return (
    <article className="metric-chart-card">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">
            Budtender leaderboard{' '}
            <HelpIcon text="Sortable per-cashier scorecard. Each row is one cashier over the selected window. The horizontal bar shows the sort-by metric on a 0..max scale. Sample-size shading: rows with <10 baseline-lift samples or <5 transactions are dimmed because their per-row metrics are statistically noisy." />
          </h3>
        </div>
        <div className="metric-chart-controls">
          <label>
            sort{' '}
            <select value={sort} onChange={(e) => setSort(e.target.value as LeaderboardSort)}>
              <option value="sales">sales $</option>
              <option value="transactions">transactions</option>
              <option value="aov">avg order value</option>
              <option value="discountRate">discount rate</option>
              <option value="firstTime">first-time cust %</option>
              <option value="sameLift">same-cust lift $</option>
              <option value="txnPerHr">txn / drawer-hr</option>
            </select>
          </label>
        </div>
      </header>
      <table className="budtender-leaderboard">
        <thead>
          <tr>
            <th>Cashier</th>
            <th className="num">Txns</th>
            <th className="num">Sales</th>
            <th className="num">AOV</th>
            <th className="num">Disc %</th>
            <th className="num">1st-time %</th>
            <th className="num">Lift $/order</th>
            <th className="num">Txn/hr</th>
            <th className="bar">{sortLabel(sort)}</th>
          </tr>
        </thead>
        <tbody>
          {cashiers.map((c) => {
            const v = sortValue(c, sort) ?? 0
            const pct = sortValueMax > 0 ? Math.max(0, Math.min(1, Math.abs(v) / sortValueMax)) : 0
            const lowSample = c.transactions < HIDE_BELOW_SAMPLE
            return (
              <tr key={c.cashierId} className={lowSample ? 'is-low-sample' : ''}>
                <td>
                  {c.cashierName || `Cashier ${c.cashierId}`}{' '}
                  {c.userStatus != null && c.userStatus !== 0 ? (
                    <span className="budtender-disabled-pill" title="user_status != 0 in staff_directory_cache">
                      DISABLED
                    </span>
                  ) : null}
                </td>
                <td className="num">{fmtInt(c.transactions)}</td>
                <td className="num">{fmtMoney(c.sales)}</td>
                <td className="num">{fmtMoneyOrDash(c.avgOrderValue)}</td>
                <td className="num">{fmtPctOrDash(c.discountRate)}</td>
                <td className="num">{fmtPctOrDash(c.firstTimeCustomerRate)}</td>
                <td className="num">{liftCell(c.sameCustomerLiftDollars, c.sameCustomerLiftSample)}</td>
                <td className="num">{fmtNumOrDash(c.transactionsPerDrawerHour, 1)}</td>
                <td className="bar">
                  <div className="budtender-leaderboard-bar">
                    <div
                      className="budtender-leaderboard-bar-fill"
                      style={{
                        width: `${(pct * 100).toFixed(1)}%`,
                        background: v < 0 ? '#c44a4a' : '#3c8a4a',
                      }}
                    />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </article>
  )
}

function sortLabel(sort: LeaderboardSort): string {
  switch (sort) {
    case 'sales':
      return 'sales $'
    case 'transactions':
      return 'transactions'
    case 'aov':
      return 'AOV'
    case 'discountRate':
      return 'discount rate'
    case 'firstTime':
      return 'first-time cust %'
    case 'sameLift':
      return 'same-cust lift $'
    case 'txnPerHr':
      return 'txn / drawer-hr'
  }
}

function sortValue(c: BudtenderCashierRow, sort: LeaderboardSort): number | null {
  switch (sort) {
    case 'sales':
      return c.sales
    case 'transactions':
      return c.transactions
    case 'aov':
      return c.avgOrderValue
    case 'discountRate':
      return c.discountRate
    case 'firstTime':
      return c.firstTimeCustomerRate
    case 'sameLift':
      return c.sameCustomerLiftDollars
    case 'txnPerHr':
      return c.transactionsPerDrawerHour
  }
}

function sortCashiers(
  rows: ReadonlyArray<BudtenderCashierRow>,
  sort: LeaderboardSort,
): BudtenderCashierRow[] {
  return rows
    .slice()
    .sort((a, b) => (sortValue(b, sort) ?? -Infinity) - (sortValue(a, sort) ?? -Infinity))
}

function liftCell(value: number | null, sample: number): JSX.Element {
  if (value == null || sample === 0) return <span className="subtle-copy">—</span>
  const colour = value > 0 ? '#3c8a4a' : value < 0 ? '#c44a4a' : '#666'
  return (
    <span style={{ color: colour }} title={`sample n=${sample}`}>
      {value > 0 ? '+' : ''}
      {fmtMoney(value)}
      {sample < LOW_SAMPLE_THRESHOLD ? <span className="subtle-copy"> (n={sample})</span> : null}
    </span>
  )
}

// =============================== Upsell card ===============================

function UpsellLiftCard({ data }: { data: BudtenderAnalyticsResponse }) {
  // Sort by sameCustomerLiftDollars descending; rows with no sample
  // fall to the bottom (null → -Infinity).
  const rows = useMemo(
    () =>
      data.cashiers
        .filter((c) => c.sameCustomerLiftSample > 0 || c.similarCustomerLiftSample > 0)
        .slice()
        .sort(
          (a, b) =>
            (b.sameCustomerLiftDollars ?? -Infinity) - (a.sameCustomerLiftDollars ?? -Infinity),
        ),
    [data.cashiers],
  )
  if (rows.length === 0) {
    return (
      <article className="metric-chart-card">
        <header className="metric-chart-header">
          <div className="metric-chart-titlewrap">
            <h3 className="metric-chart-title">
              Dollar-basket upsell lift{' '}
              <HelpIcon text="No data: we have no cashier with enough same-customer transactions to compute a baseline lift. The metric is the per-order grand_total minus that customer's leave-one-out mean grand_total, averaged per cashier." />
            </h3>
          </div>
        </header>
        <p className="subtle-copy">No same- or similar-customer baseline samples in range.</p>
      </article>
    )
  }
  const maxAbs = Math.max(
    1e-9,
    ...rows.map((r) => Math.max(Math.abs(r.sameCustomerLiftDollars ?? 0), Math.abs(r.similarCustomerLiftDollars ?? 0))),
  )
  return (
    <article className="metric-chart-card">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">
            Dollar-basket upsell lift{' '}
            <HelpIcon text="Two parallel measures of basket-size lift, both in DOLLARS (not item count — line items aren't ingested yet). SAME-CUSTOMER LIFT: per order, grand_total minus that customer's leave-one-out mean grand_total over the window; averaged per cashier. Only non-guest customers with ≥2 orders contribute. SIMILAR-CUSTOMER LIFT: same idea but the baseline is the leave-one-out mean of orders in the same cohort (is_guest, first_time, fulfillment, payment). Positive ⇒ this cashier rings larger-than-baseline baskets. Sample sizes shown in parens; rows with n<5 are not shown." />
          </h3>
        </div>
      </header>
      <table className="budtender-lift-table">
        <thead>
          <tr>
            <th>Cashier</th>
            <th className="num">Same-customer lift</th>
            <th className="num">Similar-cohort lift</th>
            <th className="bar">same lift, ±</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const same = c.sameCustomerLiftDollars
            const ratio = same != null ? Math.max(-1, Math.min(1, same / maxAbs)) : 0
            return (
              <tr key={c.cashierId}>
                <td>{c.cashierName || `Cashier ${c.cashierId}`}</td>
                <td className="num">{liftCell(same, c.sameCustomerLiftSample)}</td>
                <td className="num">
                  {liftCell(c.similarCustomerLiftDollars, c.similarCustomerLiftSample)}
                </td>
                <td className="bar">
                  <div className="budtender-diverging-bar">
                    <div className="budtender-diverging-bar-axis" />
                    <div
                      className="budtender-diverging-bar-fill"
                      style={{
                        left: ratio < 0 ? `${50 + ratio * 50}%` : '50%',
                        width: `${Math.abs(ratio) * 50}%`,
                        background: ratio < 0 ? '#c44a4a' : '#3c8a4a',
                      }}
                    />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </article>
  )
}

// ============================== Mix card ==================================

function MixCard({ data }: { data: BudtenderAnalyticsResponse }) {
  type Dim = 'customer' | 'fulfillment'
  const [dim, setDim] = useState<Dim>('customer')
  const rows = useMemo(
    () => data.cashiers.slice().sort((a, b) => b.sales - a.sales),
    [data.cashiers],
  )
  if (rows.length === 0) {
    return (
      <article className="metric-chart-card">
        <header className="metric-chart-header">
          <div className="metric-chart-titlewrap">
            <h3 className="metric-chart-title">
              Mix by cashier{' '}
              <HelpIcon text="Per-cashier transaction mix. Customer mix segments orders into guest / first-time known / known repeat. Fulfillment mix segments into delivery / pickup / other based on the corrected post-#7 classification (any non-Aeropay delivery = COD; Aeropay-pickup = prepaid)." />
            </h3>
          </div>
        </header>
        <p className="subtle-copy">No cashiers in range.</p>
      </article>
    )
  }
  return (
    <article className="metric-chart-card">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">
            Mix by cashier{' '}
            <HelpIcon text="Per-cashier transaction-share mix. CUSTOMER: guest (no customer_id) vs first-time known customer vs known repeat customer; bars sum to 100%. FULFILLMENT: delivery vs pickup vs other; uses fulfillment_type buckets ('delivery%' / 'pickup%'). Substitute for category mix until line items are ingested." />
          </h3>
        </div>
        <div className="metric-chart-controls">
          <label>
            dim{' '}
            <select value={dim} onChange={(e) => setDim(e.target.value as Dim)}>
              <option value="customer">customer</option>
              <option value="fulfillment">fulfillment</option>
            </select>
          </label>
        </div>
      </header>
      <ul className="budtender-mix-list">
        {rows.map((c) => {
          const segments =
            dim === 'customer'
              ? [
                  { label: 'Guest', value: c.guestRate, colour: '#888' },
                  { label: 'First-time', value: c.firstTimeCustomerRate, colour: '#2c6cb6' },
                  { label: 'Known repeat', value: c.knownRepeatCustomerRate, colour: '#3c8a4a' },
                ]
              : [
                  { label: 'Delivery', value: c.deliveryRate, colour: '#b6862c' },
                  { label: 'Pickup', value: c.pickupRate, colour: '#2c6cb6' },
                  {
                    label: 'Other',
                    value:
                      1 - (c.deliveryRate ?? 0) - (c.pickupRate ?? 0) > 0
                        ? 1 - (c.deliveryRate ?? 0) - (c.pickupRate ?? 0)
                        : 0,
                    colour: '#888',
                  },
                ]
          return (
            <li key={c.cashierId} className="budtender-mix-row">
              <div className="budtender-mix-name">
                {c.cashierName || `Cashier ${c.cashierId}`}{' '}
                <span className="subtle-copy">({fmtInt(c.transactions)})</span>
              </div>
              <div className="budtender-mix-bar">
                {segments.map((s, i) => (
                  <div
                    key={`${c.cashierId}-${i}`}
                    style={{
                      width: `${Math.max(0, (s.value ?? 0) * 100).toFixed(1)}%`,
                      background: s.colour,
                    }}
                    title={`${s.label}: ${fmtPctOrDash(s.value)}`}
                  />
                ))}
              </div>
            </li>
          )
        })}
      </ul>
    </article>
  )
}

// ============================ Shift productivity ===========================

function ShiftProductivityCard({ data }: { data: BudtenderAnalyticsResponse }) {
  const matched = data.cashiers.filter((c) => c.hasDrawerMatch)
  if (matched.length === 0) {
    return (
      <article className="metric-chart-card">
        <header className="metric-chart-header">
          <div className="metric-chart-titlewrap">
            <h3 className="metric-chart-title">
              Drawer-shift productivity{' '}
              <HelpIcon text="Per-cashier transactions per on-the-clock drawer-hour. The cashier's clock-on intervals are taken from sweed_drawer_shift_sessions (whoever was a session participant on a closed drawer-shift). 'Drawer-hours' is the sum of each matched drawer's open-to-close duration intersected with the request window. No cashier here had a drawer-shift session in range." />
            </h3>
          </div>
        </header>
        <p className="subtle-copy">
          No cashiers in range had a matching closed drawer-shift session — productivity per shift-hour cannot be computed.
        </p>
      </article>
    )
  }
  const sorted = matched
    .slice()
    .sort((a, b) => (b.transactionsPerDrawerHour ?? 0) - (a.transactionsPerDrawerHour ?? 0))
  return (
    <article className="metric-chart-card">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">
            Drawer-shift productivity{' '}
            <HelpIcon text="Per-cashier transactions and sales per on-the-clock drawer-hour. Drawer-hours = sum of matched drawer durations clipped to the request window. A cashier counts as on-the-clock for the whole drawer if their user_id is in the sessions[] for that drawer — same operator-approved approximation as the existing transactions-per-hour metric. Excludes cashiers with no matching drawer session in range." />
          </h3>
        </div>
      </header>
      <table className="budtender-leaderboard">
        <thead>
          <tr>
            <th>Cashier</th>
            <th className="num">Drawer hrs</th>
            <th className="num">Txn / hr</th>
            <th className="num">Sales / hr</th>
            <th className="num">Drawers</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={c.cashierId}>
              <td>{c.cashierName || `Cashier ${c.cashierId}`}</td>
              <td className="num">{fmtNumOrDash((c.drawerMinutes ?? 0) / 60, 1)}</td>
              <td className="num">{fmtNumOrDash(c.transactionsPerDrawerHour, 1)}</td>
              <td className="num">{fmtMoneyOrDash(c.salesPerDrawerHour)}</td>
              <td className="num">{fmtInt(c.drawerCount ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  )
}

// ============================== Scatter ===================================

interface AxisDef {
  id: string
  label: string
  short: string
  format: (v: number) => string
  value: (c: BudtenderCashierRow) => number | null
}

const PERCENT_FMT = (v: number) => `${(v * 100).toFixed(1)}%`
const MONEY_FMT = (v: number) => fmtMoney(v)
const NUM_FMT = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 })

const SCATTER_AXES: ReadonlyArray<AxisDef> = [
  // Volume / sales
  { id: 'transactions', short: 'Txn', label: 'Transactions', format: fmtInt, value: (c) => c.transactions },
  { id: 'sales', short: 'Sales', label: 'Sales $', format: MONEY_FMT, value: (c) => c.sales },
  { id: 'avgOrderValue', short: 'AOV', label: 'Avg order value $', format: MONEY_FMT, value: (c) => c.avgOrderValue },
  { id: 'medianOrderValue', short: 'Median', label: 'Median order value $', format: MONEY_FMT, value: (c) => c.medianOrderValue },
  { id: 'p90OrderValue', short: 'P90', label: 'P90 order value $', format: MONEY_FMT, value: (c) => c.p90OrderValue },
  { id: 'transactionsPerActiveDay', short: 'Txn/day', label: 'Transactions per active day', format: NUM_FMT, value: (c) => c.transactionsPerActiveDay },
  { id: 'salesPerActiveDay', short: 'Sales/day', label: 'Sales per active day $', format: MONEY_FMT, value: (c) => c.salesPerActiveDay },
  // Discount
  { id: 'discountRate', short: 'Disc%', label: 'Discount rate', format: PERCENT_FMT, value: (c) => c.discountRate },
  { id: 'avgDiscountPerTransaction', short: 'Disc$/txn', label: 'Avg discount per transaction $', format: MONEY_FMT, value: (c) => c.avgDiscountPerTransaction },
  { id: 'discountedTransactionRate', short: 'Disc rate', label: 'Discounted-transaction rate (txn with any discount)', format: PERCENT_FMT, value: (c) => c.discountedTransactionRate },
  // Customer mix
  { id: 'guestRate', short: 'Guest%', label: 'Guest rate', format: PERCENT_FMT, value: (c) => c.guestRate },
  { id: 'firstTimeCustomerRate', short: '1st%', label: 'First-time customer rate', format: PERCENT_FMT, value: (c) => c.firstTimeCustomerRate },
  { id: 'knownRepeatCustomerRate', short: 'Repeat%', label: 'Known-repeat customer rate', format: PERCENT_FMT, value: (c) => c.knownRepeatCustomerRate },
  { id: 'uniqueKnownCustomers', short: 'Unique', label: 'Unique known customers', format: fmtInt, value: (c) => c.uniqueKnownCustomers },
  // Fulfillment / payment
  { id: 'deliveryRate', short: 'Del%', label: 'Delivery share', format: PERCENT_FMT, value: (c) => c.deliveryRate },
  { id: 'pickupRate', short: 'Pickup%', label: 'Pickup share', format: PERCENT_FMT, value: (c) => c.pickupRate },
  { id: 'cashPaymentRate', short: 'Cash%', label: 'Cash payment share', format: PERCENT_FMT, value: (c) => c.cashPaymentRate },
  // Shift productivity
  { id: 'transactionsPerDrawerHour', short: 'Txn/hr', label: 'Transactions per drawer-hour', format: NUM_FMT, value: (c) => c.transactionsPerDrawerHour },
  { id: 'salesPerDrawerHour', short: 'Sales/hr', label: 'Sales per drawer-hour $', format: MONEY_FMT, value: (c) => c.salesPerDrawerHour },
  // Upsell
  { id: 'sameCustomerLiftDollars', short: 'Same lift', label: 'Same-customer basket lift $/order', format: MONEY_FMT, value: (c) => c.sameCustomerLiftDollars },
  { id: 'sameCustomerLiftPct', short: 'Same lift%', label: 'Same-customer basket lift %', format: PERCENT_FMT, value: (c) => c.sameCustomerLiftPct },
  { id: 'similarCustomerLiftDollars', short: 'Sim lift', label: 'Similar-cohort basket lift $/order', format: MONEY_FMT, value: (c) => c.similarCustomerLiftDollars },
  { id: 'similarCustomerLiftPct', short: 'Sim lift%', label: 'Similar-cohort basket lift %', format: PERCENT_FMT, value: (c) => c.similarCustomerLiftPct },
  // Peer deltas
  { id: 'aovDelta', short: 'ΔAOV', label: 'AOV minus peer median', format: MONEY_FMT, value: (c) => c.peer.avgOrderValueDeltaVsPeerMedian },
  { id: 'discDelta', short: 'ΔDisc%', label: 'Discount rate minus peer median', format: (v) => `${(v * 100).toFixed(2)}pp`, value: (c) => c.peer.discountRateDeltaVsPeerMedian },
  { id: 'txnHrDelta', short: 'ΔTxn/hr', label: 'Txn/hr minus peer median', format: NUM_FMT, value: (c) => c.peer.transactionsPerDrawerHourDeltaVsPeerMedian },
  { id: 'sameLiftDelta', short: 'ΔLift', label: 'Same-cust lift minus peer median $', format: MONEY_FMT, value: (c) => c.peer.sameCustomerLiftDeltaVsPeerMedian },
]

const COLOUR_AXES: ReadonlyArray<AxisDef & { kind: 'continuous'; betterDir: 'high' | 'low' }> = [
  { id: 'samePctRank', short: 'Same lift pct', label: 'Same-cust lift percentile', format: PERCENT_FMT, value: (c) => c.peer.sameCustomerLiftPercentile, kind: 'continuous', betterDir: 'high' },
  { id: 'simPctRank', short: 'Sim lift pct', label: 'Similar-cohort lift percentile', format: PERCENT_FMT, value: (c) => c.peer.similarCustomerLiftPercentile, kind: 'continuous', betterDir: 'high' },
  { id: 'aovPctRank', short: 'AOV pct', label: 'AOV percentile', format: PERCENT_FMT, value: (c) => c.peer.avgOrderValuePercentile, kind: 'continuous', betterDir: 'high' },
  { id: 'discPctRank', short: 'Disc pct', label: 'Discount-rate percentile', format: PERCENT_FMT, value: (c) => c.peer.discountRatePercentile, kind: 'continuous', betterDir: 'low' },
  { id: 'txnHrPctRank', short: 'Txn/hr pct', label: 'Txn/drawer-hr percentile', format: PERCENT_FMT, value: (c) => c.peer.transactionsPerDrawerHourPercentile, kind: 'continuous', betterDir: 'high' },
  { id: 'salesPctRank', short: 'Sales pct', label: 'Sales percentile', format: PERCENT_FMT, value: (c) => c.peer.salesPercentile, kind: 'continuous', betterDir: 'high' },
  { id: 'sameLift', short: 'Same lift $', label: 'Same-cust lift $', format: MONEY_FMT, value: (c) => c.sameCustomerLiftDollars, kind: 'continuous', betterDir: 'high' },
]

const SIZE_AXES: ReadonlyArray<AxisDef> = [
  { id: 'transactions', short: 'Txns', label: 'Transactions', format: fmtInt, value: (c) => c.transactions },
  { id: 'sales', short: 'Sales', label: 'Sales $', format: MONEY_FMT, value: (c) => c.sales },
  { id: 'uniqueKnownCustomers', short: 'Unique', label: 'Unique known customers', format: fmtInt, value: (c) => c.uniqueKnownCustomers },
  { id: 'drawerMinutes', short: 'Mins', label: 'Drawer minutes', format: fmtInt, value: (c) => c.drawerMinutes },
]

function CashierScatterCard({ data }: { data: BudtenderAnalyticsResponse }) {
  const [xId, setXId] = useState<string>('transactionsPerDrawerHour')
  const [yId, setYId] = useState<string>('avgOrderValue')
  const [colourId, setColourId] = useState<string>('samePctRank')
  const [sizeId, setSizeId] = useState<string>('transactions')
  // Issue #38 / task A5: structured Highlight section. `highlight`
  // remains the free-text input (folded into the matcher); the new
  // `highlightState` carries the structured chip selection across
  // the Status / Drawer dims.
  const [highlight, setHighlight] = useState<string>('')
  const [highlightState, setHighlightState] = useState<HighlightSelectionState>(
    () => emptyHighlightSelection(),
  )

  // v1.4 V4'4: URL-backed drill selection. Escape clears at the
  // window level. The scatter dot click handler writes
  // ?selection={kind:'scatterDot', metricId, dotId:cashierId} to the
  // URL so the drilled state survives a copy-paste of the address bar.
  const [selection, setSelection] = useMetricSelection()
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && selection != null) setSelection(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, setSelection])
  const selectedCashierId =
    selection != null &&
    selection.kind === 'scatterDot' &&
    selection.metricId === BUDTENDER_CASHIER_SCATTER_METRIC_ID
      ? selection.dotId
      : null
  const onSelectCashier = (cashierId: string | null): void => {
    setSelection(
      cashierId == null
        ? null
        : {
            kind: 'scatterDot',
            metricId: BUDTENDER_CASHIER_SCATTER_METRIC_ID,
            dotId: cashierId,
          },
    )
  }
  const selectedCashier = useMemo(
    () =>
      selectedCashierId == null
        ? null
        : data.cashiers.find((c) => c.cashierId === selectedCashierId) ?? null,
    [data.cashiers, selectedCashierId],
  )
  const xDef = useMemo(() => SCATTER_AXES.find((a) => a.id === xId) ?? SCATTER_AXES[0]!, [xId])
  const yDef = useMemo(() => SCATTER_AXES.find((a) => a.id === yId) ?? SCATTER_AXES[2]!, [yId])
  const colourDef = useMemo(
    () => COLOUR_AXES.find((a) => a.id === colourId) ?? COLOUR_AXES[0]!,
    [colourId],
  )
  const sizeDef = useMemo(() => SIZE_AXES.find((a) => a.id === sizeId) ?? SIZE_AXES[0]!, [sizeId])
  // Combined matcher: structured chips AND free-text. Pure helper
  // returns null when neither is engaged, matching the legacy "no
  // dimming" UX.
  const matcher = useMemo(
    () =>
      buildStructuredHighlightMatcher(
        CASHIER_HIGHLIGHT_DIMS,
        highlightState,
        highlight,
      ),
    [highlightState, highlight],
  )
  return (
    <article className="metric-chart-card">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">
            Cashier scatter{' '}
            <HelpIcon text="One dot per cashier over the selected window. Switch X / Y to any per-cashier aggregate. Colour encodes a peer-percentile or continuous metric (green = better for the metric's natural direction); size encodes a volume metric. Use the highlight input to glow-pop a subset (e.g. type part of a cashier's name). Hover any dot for the full per-cashier breakdown." />
          </h3>
        </div>
        <div className="metric-chart-controls catalog-card-controls">
          {/* Y before X — matches the reading order on the plot (Y label
              sits to the LEFT of the X label). */}
          <label title={yDef.label}>
            Y:{' '}
            <select value={yId} onChange={(e) => setYId(e.target.value)} title={yDef.label}>
              {SCATTER_AXES.map((a) => (
                <option key={a.id} value={a.id} title={a.label}>
                  {a.short}
                </option>
              ))}
            </select>
          </label>
          <label title={xDef.label}>
            X:{' '}
            <select value={xId} onChange={(e) => setXId(e.target.value)} title={xDef.label}>
              {SCATTER_AXES.map((a) => (
                <option key={a.id} value={a.id} title={a.label}>
                  {a.short}
                </option>
              ))}
            </select>
          </label>
          <label title={colourDef.label}>
            col:{' '}
            <select value={colourId} onChange={(e) => setColourId(e.target.value)}>
              {COLOUR_AXES.map((a) => (
                <option key={a.id} value={a.id} title={a.label}>
                  {a.short}
                </option>
              ))}
            </select>
          </label>
          <label title={sizeDef.label}>
            sz:{' '}
            <select value={sizeId} onChange={(e) => setSizeId(e.target.value)}>
              {SIZE_AXES.map((a) => (
                <option key={a.id} value={a.id} title={a.label}>
                  {a.short}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      {/* Structured Highlight section (issue #38 / task A5). Open by
          default on desktop, collapsed on mobile so the chip row
          doesn't push the scatter off-screen on phones. Renders
          chips for Status / Drawer-match, plus the free-text input
          that substring-matches cashier name / id (cashier identity
          dim contributes its fields to the free-text haystack). */}
      <ControlsSection title="Highlight" defaultOpen="desktop-only">
        <HighlightControls
          dims={CASHIER_HIGHLIGHT_DIMS}
          state={highlightState}
          setState={setHighlightState}
          filteredPoints={data.cashiers}
          freeText={highlight}
          setFreeText={setHighlight}
          freeTextPlaceholder="name or id"
        />
      </ControlsSection>
      {/* v1.4 V4'4: surface the currently-drilled cashier directly
          under the scatter so the operator never sees the 2px stroke
          highlight without an explanatory readout + clear button. */}
      {selectedCashier ? (
        <aside
          className="budtender-scatter-selection-callout"
          role="status"
          aria-live="polite"
        >
          <strong>Drilled:</strong>{' '}
          {selectedCashier.cashierName || `Cashier ${selectedCashier.cashierId}`}{' '}
          <span className="subtle-copy">
            ({fmtInt(selectedCashier.transactions)} txns · {fmtMoney(selectedCashier.sales)} sales)
          </span>{' '}
          <button
            type="button"
            className="ghost-button"
            onClick={() => onSelectCashier(null)}
            aria-label="Clear drill selection"
            title="Clear drill selection (Escape)"
          >
            ✕
          </button>
        </aside>
      ) : null}
      <CashierScatterSvg
        cashiers={data.cashiers}
        xDef={xDef}
        yDef={yDef}
        colourDef={colourDef}
        sizeDef={sizeDef}
        matcher={matcher}
        selectedCashierId={selectedCashierId}
        onSelectCashier={onSelectCashier}
      />
    </article>
  )
}

function buildCashierMatcher(
  query: string,
): ((c: BudtenderCashierRow) => boolean) | null {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return null
  const terms = q.split(/\s+/).filter((t) => t.length > 0)
  return (c) => {
    const hay = `${c.cashierName ?? ''} ${c.cashierId}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  }
}

// ---------------------------------------------------------------------------
// Structured-highlight dimensions for the cashier scatter (issue #38).
//
// The cashier dataset is heavily aggregated, so there are far fewer
// categorical dims than the catalog scatter. Two natural dims live in
// the BudtenderCashierRow itself; the rest of the page already exposes
// the obvious filter dims (sites / date range) at the page level via
// the standard preset chip strip.
//
// Status:  Sweed staff_directory_cache.user_status. 0 / null = active,
//          any non-zero = disabled/terminated (org-wide convention).
//          Useful for hiding ex-employees from a productivity scatter.
// Drawer:  hasDrawerMatch. Cashiers without drawer-shift sessions in
//          the window have null transactionsPerDrawerHour / etc;
//          operators frequently want to highlight just the matched
//          set to compare shift-productivity axes apples-to-apples.
//
// Free-text continues to substring-match cashierName + cashierId.
const CASHIER_HIGHLIGHT_DIMS: ReadonlyArray<HighlightDimensionSpec<BudtenderCashierRow>> = [
  {
    id: 'status',
    label: 'Status',
    getOptions: (rows) => {
      let active = 0
      let disabled = 0
      for (const r of rows) {
        if (r.userStatus == null || r.userStatus === 0) active += 1
        else disabled += 1
      }
      const out: Array<{ id: string; label: string; itemCount: number }> = []
      if (active > 0) out.push({ id: 'active', label: 'Active', itemCount: active })
      if (disabled > 0) out.push({ id: 'disabled', label: 'Disabled', itemCount: disabled })
      return out
    },
    pointKey: (c) => [c.userStatus == null || c.userStatus === 0 ? 'active' : 'disabled'],
  },
  {
    id: 'drawer',
    label: 'Drawer match',
    getOptions: (rows) => {
      let matched = 0
      let unmatched = 0
      for (const r of rows) {
        if (r.hasDrawerMatch) matched += 1
        else unmatched += 1
      }
      const out: Array<{ id: string; label: string; itemCount: number }> = []
      if (matched > 0) out.push({ id: 'matched', label: 'Has drawer match', itemCount: matched })
      if (unmatched > 0)
        out.push({ id: 'unmatched', label: 'No drawer match', itemCount: unmatched })
      return out
    },
    pointKey: (c) => [c.hasDrawerMatch ? 'matched' : 'unmatched'],
  },
  {
    // Cashier identity exposed as a dim so the free-text matcher
    // built into HighlightControls can OR-match against (name + id).
    // No chip dropdown is rendered since `getOptions` returns [] —
    // but `pointKey` IS used by the free-text haystack join.
    id: 'identity',
    label: 'Identity',
    getOptions: () => [],
    pointKey: (c) => [c.cashierName ?? '', c.cashierId].filter((s) => s.length > 0),
  },
]

interface ScatterSvgProps {
  cashiers: ReadonlyArray<BudtenderCashierRow>
  xDef: AxisDef
  yDef: AxisDef
  colourDef: AxisDef & { betterDir: 'high' | 'low' }
  sizeDef: AxisDef
  matcher: ((c: BudtenderCashierRow) => boolean) | null
  /** v1.4 V4'4: currently-selected cashierId (URL drill). */
  selectedCashierId: string | null
  /** v1.4 V4'4: callback when a dot is clicked/keyboard-activated. */
  onSelectCashier: (cashierId: string | null) => void
}

function CashierScatterSvg(p: ScatterSvgProps) {
  const W = 720
  const H = 360
  const PAD_L = 64
  const PAD_R = 14
  const PAD_T = 14
  const PAD_B = 40
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B

  const plotted = useMemo(() => {
    const out: Array<{
      c: BudtenderCashierRow
      x: number
      y: number
      size: number | null
      colour: number | null
    }> = []
    for (const c of p.cashiers) {
      const x = p.xDef.value(c)
      const y = p.yDef.value(c)
      if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue
      out.push({
        c,
        x,
        y,
        size: p.sizeDef.value(c),
        colour: p.colourDef.value(c),
      })
    }
    return out
  }, [p.cashiers, p.xDef, p.yDef, p.sizeDef, p.colourDef])

  // Outlier-resistant default view. Same algorithm and "Show all
  // data (N)" affordance as the catalog scatter — see
  // scatterAutoZoom.ts. We keep the chip / toggle here at the SVG
  // level (rather than at the card level) so EVERY scatter on the
  // dashboard frames its densest ~90% on first render and lets the
  // operator opt back into the full extent. Compact-vs-full chip
  // is intentionally omitted when no points would be hidden.
  const [fitMode, setFitMode] = useState<'compact' | 'full'>('compact')
  const autoZoom = useMemo(
    () => computeCompactDomain(plotted.map((d) => ({ x: d.x, y: d.y }))),
    [plotted],
  )

  if (plotted.length === 0) {
    return <p className="subtle-copy">No cashiers have both X and Y values for the current axes.</p>
  }

  const xs = plotted.map((d) => d.x)
  const ys = plotted.map((d) => d.y)
  // v1.4 V4'1: shared niceXTicks / niceYTicks helpers from
  // gridlines.ts. Same `{1, 2, 2.5, 5, 10} × 10^k` ladder as the
  // time-series MetricChart so scatter axes feel like the rest of
  // the dashboard (operator wishlist #1 — "scatter feels different
  // from the rest of the dashboard"); CI guardrail in gridlines.test
  // covers the 2.5 / 0.25 / 0.025 regression cases.
  //
  // Tick bounds follow the active fit mode: compact mode passes the
  // padded compact rectangle, full mode passes the raw extent. We
  // still feed `niceXTicks` so the resulting axis snaps to a clean
  // ladder rather than the raw quantile cut points.
  const compactView = autoZoom.compact
  const fullView = autoZoom.full
  const useCompact = fitMode === 'compact' && compactView != null
  const xRawMin = useCompact ? compactView.xMin : Math.min(...xs)
  const xRawMax = useCompact ? compactView.xMax : Math.max(...xs)
  const yRawMin = useCompact ? compactView.yMin : Math.min(...ys)
  const yRawMax = useCompact ? compactView.yMax : Math.max(...ys)
  const xTicks = niceXTicks(xRawMin, xRawMax, 5).ticks
  const yTicks = niceYTicks(yRawMin, yRawMax, 5).ticks
  const xLo = xTicks[0]!
  const xHi = xTicks[xTicks.length - 1]!
  const yLo = yTicks[0]!
  const yHi = yTicks[yTicks.length - 1]!
  const xScale = (v: number) => PAD_L + ((v - xLo) / Math.max(1e-9, xHi - xLo)) * plotW
  const yScale = (v: number) => PAD_T + plotH - ((v - yLo) / Math.max(1e-9, yHi - yLo)) * plotH

  const sizes = plotted.map((d) => d.size).filter((v): v is number => v != null && Number.isFinite(v))
  const sLo = sizes.length > 0 ? Math.min(...sizes) : 0
  const sHi = sizes.length > 0 ? Math.max(...sizes) : 1
  const dotR = (v: number | null): number => {
    if (v == null || sHi === sLo) return 5
    return 3 + Math.sqrt(Math.max(0, (v - sLo) / (sHi - sLo))) * 9
  }

  const colourFor = (v: number | null): string => {
    if (v == null) return '#999'
    // Map continuous value to red→gray→green, respecting betterDir.
    const colours = sizes.length === 0 ? [0.5] : plotted.map((d) => d.colour ?? Number.NaN)
    const valid = colours.filter((c) => Number.isFinite(c)) as number[]
    if (valid.length === 0) return '#999'
    const lo = Math.min(...valid)
    const hi = Math.max(...valid)
    let t = hi === lo ? 0.5 : (v - lo) / (hi - lo)
    if (p.colourDef.betterDir === 'low') t = 1 - t
    return interpRedGreen(t)
  }

  const [hovered, setHovered] = useState<{ idx: number; xpx: number; ypx: number } | null>(null)
  const matched: number[] = []
  const dimmed: number[] = []
  plotted.forEach((d, i) => {
    if (p.matcher && p.matcher(d.c)) matched.push(i)
    else if (p.matcher) dimmed.push(i)
    else matched.push(i)
  })

  return (
    <div className="budtender-scatter-wrap" style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Cashier scatter"
        className="budtender-scatter-svg"
      >
        {/* Light dashed gridlines + Y tick labels at nice values.
            Visual treatment (`#d8d8d8`, 0.8px, dashed) matches the
            time-series MetricChart scatter so the operator sees the
            same gridline density on every scatter (v1.4 V4'1). */}
        {yTicks.map((t, i) => (
          <g key={`yt-${i}`}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yScale(t)}
              y2={yScale(t)}
              stroke="#d8d8d8"
              strokeWidth={0.8}
              strokeDasharray="3 3"
              pointerEvents="none"
            />
            <text
              x={PAD_L - 6}
              y={yScale(t)}
              textAnchor="end"
              dominantBaseline="central"
              fontSize={10}
              fill="#666"
            >
              {p.yDef.format(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <g key={`xt-${i}`}>
            <line
              x1={xScale(t)}
              x2={xScale(t)}
              y1={PAD_T}
              y2={PAD_T + plotH}
              stroke="#d8d8d8"
              strokeWidth={0.8}
              strokeDasharray="3 3"
              pointerEvents="none"
            />
            <text
              x={xScale(t)}
              y={H - 6}
              textAnchor="middle"
              fontSize={10}
              fill="#666"
            >
              {p.xDef.format(t)}
            </text>
          </g>
        ))}
        {dimmed.map((i) => {
          const d = plotted[i]!
          return (
            <circle
              key={`dim-${i}`}
              cx={xScale(d.x)}
              cy={yScale(d.y)}
              r={Math.max(2, dotR(d.size) - 1)}
              fill={colourFor(d.colour)}
              fillOpacity={0.18}
            />
          )
        })}
        {matched.map((i) => {
          const d = plotted[i]!
          const r = dotR(d.size)
          // v1.4 V4'4: selected cashier gets a 2px black stroke that
          // overrides the highlight/matched stroke. Toggle on
          // re-click. Tab + Enter / Space activate via the SVG <a>
          // wrapper (role=button + tabindex=0).
          const isSelected = p.selectedCashierId === d.c.cashierId
          const baseStroke = p.matcher ? '#111' : '#fff'
          const baseStrokeW = p.matcher ? 1.25 : 0.5
          const onActivate = (): void => {
            p.onSelectCashier(isSelected ? null : d.c.cashierId)
          }
          return (
            <circle
              key={`pt-${i}`}
              cx={xScale(d.x)}
              cy={yScale(d.y)}
              r={r}
              fill={colourFor(d.colour)}
              fillOpacity={p.matcher || isSelected ? 0.95 : 0.7}
              stroke={isSelected ? '#000' : baseStroke}
              strokeWidth={isSelected ? 2 : baseStrokeW}
              role="button"
              tabIndex={0}
              aria-label={`Drill into cashier ${d.c.cashierName || d.c.cashierId}`}
              aria-pressed={isSelected}
              style={{ cursor: 'pointer', outline: 'none' }}
              onClick={onActivate}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onActivate()
                }
              }}
              onMouseEnter={() => setHovered({ idx: i, xpx: xScale(d.x), ypx: yScale(d.y) })}
              onMouseLeave={() => setHovered(null)}
            />
          )
        })}
      </svg>
      {hovered ? (
        <ScatterTooltip
          cashier={plotted[hovered.idx]!.c}
          xDef={p.xDef}
          yDef={p.yDef}
          xValue={plotted[hovered.idx]!.x}
          yValue={plotted[hovered.idx]!.y}
          dotPx={{ x: hovered.xpx, y: hovered.ypx }}
          wrapW={W}
          wrapH={H}
        />
      ) : null}
      {/* Compact-vs-full fit-mode chip. Mirrors the catalog scatter so
          every scatter on /metrics offers the same outlier-resistant
          default + one-click escape to the full extent. Hidden when
          compact and full would frame the same set of points. */}
      {autoZoom.hiddenCount > 0 && fullView != null ? (
        <button
          type="button"
          className={
            fitMode === 'full' ? 'metric-chart-fit-toggle is-active' : 'metric-chart-fit-toggle'
          }
          onClick={() => setFitMode((m) => (m === 'compact' ? 'full' : 'compact'))}
          aria-pressed={fitMode === 'full'}
          title={
            fitMode === 'compact'
              ? `Default view hides ${autoZoom.hiddenCount} outlier point${
                  autoZoom.hiddenCount === 1 ? '' : 's'
                }. Click to show the full extent.`
              : 'Showing the full data extent. Click to return to the outlier-resistant default view.'
          }
        >
          {fitMode === 'compact'
            ? `Show all data (${autoZoom.hiddenCount})`
            : 'Compact view'}
        </button>
      ) : null}
    </div>
  )
}

function ScatterTooltip(p: {
  cashier: BudtenderCashierRow
  xDef: AxisDef
  yDef: AxisDef
  xValue: number
  yValue: number
  dotPx: { x: number; y: number }
  wrapW: number
  wrapH: number
}) {
  const viewportW =
    typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : p.wrapW
  const W = Math.min(280, Math.max(180, viewportW - 16))
  const right = p.dotPx.x + 14 + W <= p.wrapW
  let left = right ? p.dotPx.x + 14 : p.dotPx.x - 14 - W
  left = Math.max(4, Math.min(p.wrapW - W - 4, left))
  const top = Math.max(4, Math.min(p.wrapH - 40, p.dotPx.y + 14))
  const style: React.CSSProperties = {
    position: 'absolute',
    left,
    top,
    width: W,
    maxWidth: 'calc(100vw - 16px)',
    pointerEvents: 'none',
  }
  const c = p.cashier
  return (
    <div className="catalog-analytics-tooltip" style={style} role="tooltip">
      <div className="catalog-analytics-tooltip-title">
        {c.cashierName || `Cashier ${c.cashierId}`}
      </div>
      <div className="catalog-analytics-tooltip-sub subtle-copy">
        id {c.cashierId} • {fmtInt(c.transactions)} txns • {fmtMoney(c.sales)} sales
      </div>
      <table className="catalog-analytics-tooltip-table">
        <tbody>
          <tr>
            <th>{p.xDef.short}</th>
            <td>{p.xDef.format(p.xValue)}</td>
          </tr>
          <tr>
            <th>{p.yDef.short}</th>
            <td>{p.yDef.format(p.yValue)}</td>
          </tr>
          <tr><th>AOV</th><td>{fmtMoneyOrDash(c.avgOrderValue)}</td></tr>
          <tr><th>Disc %</th><td>{fmtPctOrDash(c.discountRate)}</td></tr>
          <tr><th>1st-time</th><td>{fmtPctOrDash(c.firstTimeCustomerRate)}</td></tr>
          <tr>
            <th>Same lift</th>
            <td>
              {c.sameCustomerLiftDollars != null
                ? `${fmtMoney(c.sameCustomerLiftDollars)} (n=${c.sameCustomerLiftSample})`
                : '—'}
            </td>
          </tr>
          <tr>
            <th>Txn/hr</th>
            <td>{fmtNumOrDash(c.transactionsPerDrawerHour, 1)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// ============================ MISSING DATA cards ===========================

function MissingDataSection({
  cards,
  compact,
}: {
  cards: ReadonlyArray<BudtenderMissingDataCard>
  compact?: boolean
}) {
  if (cards.length === 0) return null
  return (
    <details className="metrics-pending-section" open={!compact}>
      <summary>
        <span className="metrics-section-title">Missing data</span>{' '}
        <span className="subtle-copy">
          ({cards.length} metric{cards.length === 1 ? '' : 's'} blocked on new ingest)
        </span>
      </summary>
      <div className="metrics-grid">
        {cards.map((c) => (
          <article key={c.id} className="metric-chart-card metric-chart-card--pending">
            <header className="metric-chart-header">
              <div className="metric-chart-titlewrap">
                <h3 className="metric-chart-title">{c.title}</h3>
                <span className="metric-chart-pending-badge">MISSING DATA</span>
              </div>
            </header>
            <div className="metric-chart-pending-body">
              <p className="subtle-copy">{c.whyMissing}</p>
              <p className="subtle-copy">
                <strong>Needs:</strong> {c.neededSource}
              </p>
              <p className="subtle-copy">
                <strong>Unlocks:</strong> {c.unlockedMetrics.join(' • ')}
              </p>
              {c.blockedByUrl ? (
                <p className="subtle-copy">
                  Tracked in{' '}
                  <a href={c.blockedByUrl} target="_blank" rel="noreferrer noopener">
                    {c.blockedByUrl.replace(/^https?:\/\//, '')}
                  </a>
                </p>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </details>
  )
}

// =============================== Helpers ===================================

function fmtInt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}
function fmtMoney(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1000) return `${n < 0 ? '-' : ''}$${(abs / 1000).toFixed(1)}k`
  return `${n < 0 ? '-' : ''}$${abs.toFixed(2)}`
}
function fmtMoneyOrDash(n: number | null): string {
  return n == null ? '—' : fmtMoney(n)
}
function fmtPctOrDash(n: number | null): string {
  return n == null ? '—' : `${(n * 100).toFixed(1)}%`
}
function fmtNumOrDash(n: number | null, digits: number): string {
  return n == null
    ? '—'
    : n.toLocaleString(undefined, { maximumFractionDigits: digits })
}
function shortDay(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
function toLocalDtInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function interpRedGreen(t: number): string {
  // 0 = bright red, 0.5 = neutral gray, 1 = bright green
  const c = Math.max(0, Math.min(1, t))
  if (c < 0.5) {
    const k = c / 0.5
    const r = Math.round(196 + k * (160 - 196))
    const g = Math.round(74 + k * (160 - 74))
    const b = Math.round(74 + k * (160 - 74))
    return `rgb(${r}, ${g}, ${b})`
  }
  const k = (c - 0.5) / 0.5
  const r = Math.round(160 + k * (60 - 160))
  const g = Math.round(160 + k * (138 - 160))
  const b = Math.round(160 + k * (74 - 160))
  return `rgb(${r}, ${g}, ${b})`
}

export { buildCashierMatcher }
