import { useEffect, useMemo, useState } from 'react'

import {
  TimeOfDayResponseSchema,
  type TimeOfDayCell,
  type TimeOfDayFulfillmentSlice,
  type TimeOfDayResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { nyAddDays, nyFloorToBusinessDay, nyIsoDate } from '../../app/nyTime.js'

import { defaultSiteSelection, toggleSiteSelection } from './metricsSiteSelection.js'
import {
  cellValue,
  laborSurplus,
  metricIsMoney,
  OPEN_HOURS,
  WEEKDAY_LABELS,
  WEEKDAY_ROWS,
  type LaborConfig,
  type TimeOfDayBasis,
  type TimeOfDayCellMetric,
} from './timeOfDayCells.js'
import { hourLabel, WeekdayHourHeatmap } from './WeekdayHourHeatmap.js'

// ---------------------------------------------------------------------------
// Time-of-day analytics tab (ADMIN-ONLY).
//
// A weekday × hour heatmap of order economics, built to answer staffing /
// hours-of-operation / delivery-economics questions ("do Mondays 11am–2pm
// at Bronx justify a second person?"). The primary cell metric is AVERAGE
// per business-day-occurrence (e.g. the average Monday-11am over the
// window), not a raw total, because staffing is a per-occurrence decision.
//
// Labor break-even mode lets the operator enter a MANUAL fully-loaded
// marginal staff-hour cost (Helios scheduling/payroll data is explicitly
// NOT trusted yet) and recolours the grid by margin-minus-labor surplus.
//
// All math lives in pure helpers (timeOfDayCells.ts, unit-tested); the
// heatmap control (WeekdayHourHeatmap) is reusable for future surfaces.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

const KNOWN_SITES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'bronx', label: 'Bronx' },
  { id: 'midtown', label: 'Midtown' },
]

const RANGE_PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '6mo', days: 180 },
  { label: '1y', days: 365 },
]

const BASIS_OPTIONS: ReadonlyArray<{ id: TimeOfDayBasis; label: string }> = [
  { id: 'margin', label: 'Margin $' },
  { id: 'grossSales', label: 'Gross sales' },
  { id: 'netSales', label: 'Net sales' },
  { id: 'grossReceipts', label: 'Gross receipts' },
  { id: 'netReceipts', label: 'Net receipts' },
]

const METRIC_OPTIONS: ReadonlyArray<{ id: TimeOfDayCellMetric; label: string }> = [
  { id: 'avg_per_occurrence', label: 'Avg per occurrence' },
  { id: 'total', label: 'Total over window' },
  { id: 'orders_per_hour', label: 'Orders / occurrence' },
  { id: 'avg_basket', label: 'Avg basket $' },
]

const SLICE_OPTIONS: ReadonlyArray<{ id: TimeOfDayFulfillmentSlice; label: string }> = [
  { id: 'all', label: 'All orders' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'pickup', label: 'Pickup' },
  { id: 'pickup_prepaid', label: 'Pickup (prepaid)' },
  { id: 'kiosk', label: 'Kiosk' },
  { id: 'in_store', label: 'In-store' },
]

const USD0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})
const USD2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
})

const basisLabel = (b: TimeOfDayBasis): string =>
  BASIS_OPTIONS.find((o) => o.id === b)?.label ?? b
const metricLabel = (m: TimeOfDayCellMetric): string =>
  METRIC_OPTIONS.find((o) => o.id === m)?.label ?? m

function fmtSigned(v: number): string {
  const s = USD0.format(Math.abs(v))
  return v < 0 ? `−${s}` : `+${s}`
}
function fmt1(v: number): string {
  return (Math.round(v * 10) / 10).toString()
}

const cellKey = (weekday: number, hour: number): string => `${weekday}:${hour}`

// Server rejects windows longer than this (see routes/timeOfDay.ts).
const MAX_WINDOW_DAYS = 366

// Convert a YYYY-MM-DD pair into the [from, to) instant window aligned to
// NY business-day boundaries (08:00 ET): from = 08:00 ET on the From date,
// to = 08:00 ET the day AFTER the To date, so the To date is inclusive and
// occurrence counting lines up with whole business days. 17:00Z is safely
// mid-afternoon ET on the given date (well inside the open business day)
// regardless of EST/EDT, so flooring it lands on the right business date.
function nyBusinessWindow(fromIso: string, toIso: string): { from: Date; to: Date } {
  const noon = (iso: string) => new Date(`${iso}T17:00:00Z`).getTime()
  const from = nyFloorToBusinessDay(noon(fromIso))
  const to = nyAddDays(nyFloorToBusinessDay(noon(toIso)), 1)
  return { from: new Date(from), to: new Date(to) }
}

interface RankedBlock {
  readonly weekday: number
  readonly hour: number
  readonly value: number
  readonly cell: TimeOfDayCell
}

export function TimeOfDayTab(): JSX.Element {
  const [selectedSites, setSelectedSites] = useState<ReadonlySet<string>>(() =>
    defaultSiteSelection(),
  )
  const [rangeDays, setRangeDays] = useState<number>(90)
  // Custom date range (overrides the preset when active). Server accepts
  // any from/to window up to MAX_WINDOW_DAYS (366); the query cost scales
  // with the window, so we cap the picker at a year client-side too.
  const [customActive, setCustomActive] = useState(false)
  const [customFrom, setCustomFrom] = useState<string>(() => nyIsoDate(Date.now() - 90 * DAY_MS))
  const [customTo, setCustomTo] = useState<string>(() => nyIsoDate(Date.now()))
  const [fulfillment, setFulfillment] = useState<TimeOfDayFulfillmentSlice>('all')

  const todayIso = nyIsoDate(Date.now())
  // Keep the From picker inside the server's max window (with a day of
  // slack for the inclusive To + DST wobble).
  const minFromIso = nyIsoDate(Date.now() - (MAX_WINDOW_DAYS - 2) * DAY_MS)
  // Resolve the custom window once (NY business-day aligned); null unless a
  // complete, in-range custom selection is active.
  const customWindow = useMemo(() => {
    if (!customActive || customFrom === '' || customTo === '' || customFrom > customTo) return null
    const w = nyBusinessWindow(customFrom, customTo)
    if (w.to.getTime() - w.from.getTime() > MAX_WINDOW_DAYS * DAY_MS) return null
    return w
  }, [customActive, customFrom, customTo])

  // Client-only view controls (no refetch).
  const [basis, setBasis] = useState<TimeOfDayBasis>('margin')
  const [metric, setMetric] = useState<TimeOfDayCellMetric>('avg_per_occurrence')
  const [laborEnabled, setLaborEnabled] = useState(false)
  const [loadedCost, setLoadedCost] = useState(56)
  const [headcount, setHeadcount] = useState(1)

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [data, setData] = useState<TimeOfDayResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sitesParam = useMemo(
    () => Array.from(selectedSites).sort().join(','),
    [selectedSites],
  )

  useEffect(() => {
    const controller = new AbortController()
    let from: Date
    let to: Date
    if (customWindow) {
      from = customWindow.from
      to = customWindow.to
    } else {
      to = new Date()
      from = new Date(to.getTime() - rangeDays * DAY_MS)
    }
    const params = new URLSearchParams()
    params.set('from', from.toISOString())
    params.set('to', to.toISOString())
    params.set('fulfillment', fulfillment)
    if (sitesParam) params.set('sites', sitesParam)
    setLoading(true)
    setError(null)
    loadJson(`/api/time-of-day-analytics?${params.toString()}`, TimeOfDayResponseSchema, {
      signal: controller.signal,
    })
      .then((r) => setData(r))
      .catch((e: unknown) => {
        if ((e as { name?: string })?.name === 'AbortError') return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [sitesParam, rangeDays, fulfillment, customWindow])

  const labor: LaborConfig = useMemo(
    () => ({ enabled: laborEnabled, loadedCostPerStaffHour: loadedCost, headcount }),
    [laborEnabled, loadedCost, headcount],
  )

  const cells = data?.cells ?? []
  const occ = data?.occurrencesByWeekday ?? [0, 0, 0, 0, 0, 0, 0]

  const byKey = useMemo(() => {
    const m = new Map<string, TimeOfDayCell>()
    for (const c of cells) m.set(cellKey(c.weekday, c.hour), c)
    return m
  }, [cells])

  // Currently-displayed value for an open (weekday, hour) — labor surplus
  // when in labor mode, else the chosen basis/metric. Mirrors the heatmap.
  const displayValueOf = useMemo(() => {
    return (c: TimeOfDayCell | undefined, weekday: number): number | null => {
      if (!c) return null
      const o = occ[weekday] ?? 0
      return labor.enabled ? laborSurplus(c, o, labor) : cellValue(c, o, basis, metric)
    }
  }, [occ, labor, basis, metric])

  // Best / worst blocks (used for the decision shortlist).
  const ranked = useMemo<RankedBlock[]>(() => {
    const out: RankedBlock[] = []
    for (const weekday of WEEKDAY_ROWS) {
      for (const hour of OPEN_HOURS) {
        const c = byKey.get(cellKey(weekday, hour))
        const v = displayValueOf(c, weekday)
        if (c && v !== null) out.push({ weekday, hour, value: v, cell: c })
      }
    }
    out.sort((a, b) => b.value - a.value)
    return out
  }, [byKey, displayValueOf])

  const isMoney = labor.enabled || metricIsMoney(metric)
  const fmtValue = (v: number | null): string => {
    if (v === null) return '—'
    if (labor.enabled) return fmtSigned(v)
    if (!isMoney) return fmt1(v)
    return USD0.format(v)
  }

  // Plain-language description of what every cell currently shows.
  const displayedDesc = labor.enabled
    ? `Margin − labor (${headcount}× ${USD0.format(loadedCost)}/hr) per occurrence`
    : `${basisLabel(basis)} · ${metricLabel(metric)}`

  const blockName = (b: RankedBlock): string => `${WEEKDAY_LABELS[b.weekday]} ${hourLabel(b.hour)}`

  const selectedCell = selectedKey ? byKey.get(selectedKey) ?? null : null
  const selectedOcc = selectedCell ? occ[selectedCell.weekday] ?? 0 : 0

  const showShortlist = ranked.length > 0
  const top = ranked.slice(0, 5)
  const bottom = ranked.length > 5 ? ranked.slice(-5).reverse() : []

  return (
    <div className="time-of-day-tab">
      <p className="time-of-day-intro">
        Typical order economics by weekday &amp; hour, for staffing &amp; hours decisions.
        Each cell is the <strong>{displayedDesc}</strong> for that weekday/hour over the
        selected range. Turn on <em>labor break-even</em> to subtract a manual
        marginal staff-hour cost and see which blocks clear it.
        <span className="subtle-copy">
          {' '}
          Closed 3:00–7:59am (opens 8am); weekday columns use the 8am business-day rollover.
          Helios scheduling/payroll data is not yet trusted — labor cost is manual.
        </span>
      </p>

      {/* ---- Controls ---- */}
      <div className="metrics-controls time-of-day-controls">
        <div className="metrics-control-group metrics-site-chips">
          <button
            type="button"
            className={`metrics-site-chip${selectedSites.size === 0 ? ' is-active' : ''}`}
            onClick={() => setSelectedSites(new Set())}
          >
            All sites
          </button>
          {KNOWN_SITES.map((s) => (
            <button
              type="button"
              key={s.id}
              className={`metrics-site-chip${selectedSites.has(s.id) ? ' is-active' : ''}`}
              onClick={() =>
                setSelectedSites((prev) => toggleSiteSelection(prev, s.id, KNOWN_SITES.length))
              }
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="metrics-control-group">
          {RANGE_PRESETS.map((r) => (
            <button
              type="button"
              key={r.days}
              className={`ghost-button${!customActive && rangeDays === r.days ? ' is-active' : ''}`}
              onClick={() => {
                setCustomActive(false)
                setRangeDays(r.days)
              }}
            >
              {r.label}
            </button>
          ))}
          <button
            type="button"
            className={`ghost-button${customActive ? ' is-active' : ''}`}
            onClick={() => setCustomActive(true)}
          >
            Custom
          </button>
        </div>

        {customActive ? (
          <div className="metrics-control-group">
            <label>
              From
              <input
                type="date"
                value={customFrom}
                min={minFromIso}
                max={customTo || todayIso}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
            </label>
            <label>
              To
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={todayIso}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </label>
            {customActive && !customWindow ? (
              <span className="subtle-copy">
                Pick a valid range (≤ {MAX_WINDOW_DAYS} days); showing last preset until then.
              </span>
            ) : null}
          </div>
        ) : null}

        <label>
          Slice
          <select
            value={fulfillment}
            onChange={(e) => setFulfillment(e.target.value as TimeOfDayFulfillmentSlice)}
          >
            {SLICE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label title={laborEnabled ? 'Labor mode always uses margin' : undefined}>
          Basis
          <select
            value={basis}
            onChange={(e) => setBasis(e.target.value as TimeOfDayBasis)}
            disabled={laborEnabled}
          >
            {BASIS_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label title={laborEnabled ? 'Labor mode shows margin-minus-labor surplus' : undefined}>
          Cell metric
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as TimeOfDayCellMetric)}
            disabled={laborEnabled}
          >
            {METRIC_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <input
            type="checkbox"
            checked={laborEnabled}
            onChange={(e) => setLaborEnabled(e.target.checked)}
          />
          Labor break-even
        </label>
        {laborEnabled ? (
          <>
            <label>
              $/hr
              <input
                type="number"
                min={0}
                step={1}
                value={loadedCost}
                onChange={(e) => setLoadedCost(Math.max(0, Number(e.target.value) || 0))}
                style={{ width: 72 }}
              />
            </label>
            <label>
              staff
              <input
                type="number"
                min={1}
                step={1}
                value={headcount}
                onChange={(e) => setHeadcount(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                style={{ width: 56 }}
              />
            </label>
          </>
        ) : null}
      </div>

      {error ? <div className="time-of-day-error">Failed to load: {error}</div> : null}

      {loading && !data ? (
        <p className="subtle-copy">Loading time-of-day analytics…</p>
      ) : null}

      {/* ---- Decision shortlist ---- */}
      {showShortlist ? (
        <div className="time-of-day-shortlist">
          <ShortlistCard
            title={labor.enabled ? 'Best blocks (surplus)' : 'Top blocks'}
            sub={displayedDesc}
            blocks={top}
            fmtValue={fmtValue}
            occ={occ}
            blockName={blockName}
            onPick={(b) => setSelectedKey(cellKey(b.weekday, b.hour))}
          />
          {bottom.length > 0 ? (
            <ShortlistCard
              title={labor.enabled ? 'Worst blocks (deficit)' : 'Quietest open blocks'}
              sub={displayedDesc}
              blocks={bottom}
              fmtValue={fmtValue}
              occ={occ}
              blockName={blockName}
              onPick={(b) => setSelectedKey(cellKey(b.weekday, b.hour))}
            />
          ) : null}
        </div>
      ) : null}

      {/* ---- Heatmap ---- */}
      <div className="time-of-day-grid-card" style={{ opacity: loading ? 0.6 : 1 }}>
        <WeekdayHourHeatmap
          cells={cells}
          occurrencesByWeekday={occ}
          basis={basis}
          metric={metric}
          labor={labor}
          selectedKey={selectedKey}
          onSelect={(_c, k) => setSelectedKey(k)}
        />
        <p className="subtle-copy time-of-day-legend">
          Rows = open local hours (8am→2am); columns = business weekday (Mon→Sun).{' '}
          {labor.enabled
            ? 'Green = surplus, white = break-even, red = deficit.'
            : 'Lighter → darker = lower → higher value.'}{' '}
          <span style={{ opacity: 0.8 }}>
            “n12” = orders behind the cell; dotted/dim cells are thin samples (&lt;5 orders) —
            don&apos;t over-read them.
          </span>
        </p>
      </div>

      {/* ---- Selected-cell detail ---- */}
      {selectedCell ? (
        <div className="time-of-day-detail">
          <h4>
            {WEEKDAY_LABELS[selectedCell.weekday]} {hourLabel(selectedCell.hour)} ·{' '}
            <span className="subtle-copy">
              {selectedOcc} occurrence{selectedOcc === 1 ? '' : 's'} in window
            </span>
          </h4>
          <div className="time-of-day-detail-stats">
            <DetailStat
              label={displayedDesc}
              value={fmtValue(displayValueOf(selectedCell, selectedCell.weekday))}
              emphasis
            />
            <DetailStat label="Orders (total)" value={selectedCell.orders.toString()} />
            <DetailStat
              label="Orders / occurrence"
              value={selectedOcc > 0 ? fmt1(selectedCell.orders / selectedOcc) : '—'}
            />
            <DetailStat
              label="Margin / occurrence"
              value={selectedOcc > 0 ? USD2.format(selectedCell.margin / selectedOcc) : '—'}
            />
            <DetailStat
              label="Avg basket (margin)"
              value={selectedCell.orders > 0 ? USD2.format(selectedCell.margin / selectedCell.orders) : '—'}
            />
          </div>
        </div>
      ) : (
        <p className="subtle-copy">
          Tap a cell (or a shortlist row) for its order count, per-occurrence margin, and
          labor surplus.
        </p>
      )}
    </div>
  )
}

function ShortlistCard({
  title,
  sub,
  blocks,
  fmtValue,
  occ,
  blockName,
  onPick,
}: {
  title: string
  sub: string
  blocks: readonly RankedBlock[]
  fmtValue: (v: number | null) => string
  occ: readonly number[]
  blockName: (b: RankedBlock) => string
  onPick: (b: RankedBlock) => void
}): JSX.Element {
  return (
    <div className="time-of-day-shortlist-card">
      <div className="time-of-day-shortlist-head">
        <span className="time-of-day-shortlist-title">{title}</span>
        <span className="subtle-copy">{sub}</span>
      </div>
      <ul className="time-of-day-shortlist-list">
        {blocks.map((b) => {
          const o = occ[b.weekday] ?? 0
          return (
            <li key={`${b.weekday}:${b.hour}`}>
              <button type="button" onClick={() => onPick(b)}>
                <span className="time-of-day-shortlist-when">{blockName(b)}</span>
                <span className="time-of-day-shortlist-val">{fmtValue(b.value)}</span>
                <span className="subtle-copy time-of-day-shortlist-meta">
                  {o > 0 ? `${Math.round((b.cell.orders / o) * 10) / 10}/occ` : '—'} · n{b.cell.orders}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function DetailStat({
  label,
  value,
  emphasis,
}: {
  label: string
  value: string
  emphasis?: boolean
}): JSX.Element {
  return (
    <div className={`time-of-day-detail-stat${emphasis ? ' is-emphasis' : ''}`}>
      <div className="time-of-day-detail-stat-label">{label}</div>
      <div className="time-of-day-detail-stat-value">{value}</div>
    </div>
  )
}
