import * as React from 'react'
import { useMemo } from 'react'

import type { TimeOfDayCell } from '../../../shared/contracts/index.js'
import {
  cellTextColor,
  cellValue,
  divergingColor,
  groupSummary,
  laborSurplus,
  metricIsMoney,
  OPEN_HOURS,
  percentile,
  sequentialColor,
  WEEKDAY_LABELS,
  WEEKDAY_ROWS,
  type LaborConfig,
  type TimeOfDayBasis,
  type TimeOfDayCellMetric,
} from './timeOfDayCells.js'

const USD0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})
const USD_COMPACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})

function fmtMoney(v: number): string {
  const abs = Math.abs(v)
  const s = abs >= 10_000 ? USD_COMPACT.format(v) : USD0.format(v)
  return v > 0 ? `+${s}` : s
}
function fmtMoneyPlain(v: number): string {
  return Math.abs(v) >= 10_000 ? USD_COMPACT.format(v) : USD0.format(v)
}
function fmtNum(v: number): string {
  return v >= 100 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString()
}

export function hourLabel(h: number): string {
  if (h === 0) return '12a'
  if (h === 12) return '12p'
  return h < 12 ? `${h}a` : `${h - 12}p`
}

const key = (weekday: number, hour: number): string => `${weekday}:${hour}`

// Below this total order count over the whole window, a cell's
// per-occurrence average is too thin to trust for a staffing call; we
// dim it + dot its border so a bright outlier never masquerades as signal.
const LOW_SAMPLE_ORDERS = 5

export interface WeekdayHourHeatmapProps {
  readonly cells: readonly TimeOfDayCell[]
  readonly occurrencesByWeekday: readonly number[]
  readonly basis: TimeOfDayBasis
  readonly metric: TimeOfDayCellMetric
  readonly labor: LaborConfig
  readonly selectedKey: string | null
  readonly onSelect: (cell: TimeOfDayCell | null, k: string | null) => void
}

/**
 * Reusable weekday × hour heatmap. Rows = business weekday (Mon→Sun),
 * columns = open local hours (8am→2am; the 3am–8am closed band is
 * hidden). Each cell shows the chosen metric value, color-coded; in
 * labor mode it shows margin-minus-modeled-labor surplus on a diverging
 * red/green scale. Designed to be dropped into any time-of-day surface.
 */
export function WeekdayHourHeatmap({
  cells,
  occurrencesByWeekday,
  basis,
  metric,
  labor,
  selectedKey,
  onSelect,
}: WeekdayHourHeatmapProps): JSX.Element {
  const byKey = useMemo(() => {
    const m = new Map<string, TimeOfDayCell>()
    for (const c of cells) m.set(key(c.weekday, c.hour), c)
    return m
  }, [cells])

  const isMoney = labor.enabled || metricIsMoney(metric)

  // Displayed value for a cell (null = blank).
  const valueOf = (c: TimeOfDayCell | undefined, weekday: number): number | null => {
    if (!c) return null
    const occ = occurrencesByWeekday[weekday] ?? 0
    return labor.enabled
      ? laborSurplus(c, occ, labor)
      : cellValue(c, occ, basis, metric)
  }

  // Color domain across all visible open cells.
  const { max, magnitude } = useMemo(() => {
    const vals: number[] = []
    for (const weekday of WEEKDAY_ROWS) {
      for (const hour of OPEN_HOURS) {
        const v = valueOf(byKey.get(key(weekday, hour)), weekday)
        if (v !== null) vals.push(v)
      }
    }
    return {
      max: percentile(vals.filter((v) => v > 0), 0.95),
      magnitude: percentile(vals.map((v) => Math.abs(v)), 0.95),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byKey, basis, metric, labor, occurrencesByWeekday])

  const colorFor = (v: number | null): { bg: string; fg: string } => {
    if (v === null) return { bg: 'rgb(247, 250, 252)', fg: '#a0aec0' }
    if (labor.enabled) {
      const strength = magnitude > 0 ? Math.abs(v) / magnitude : 0
      return { bg: divergingColor(v, magnitude), fg: cellTextColor(strength) }
    }
    const strength = max > 0 ? v / max : 0
    return { bg: sequentialColor(v, max), fg: cellTextColor(strength) }
  }

  const fmt = (v: number | null): string => {
    if (v === null) return '—'
    if (labor.enabled) return fmtMoney(v)
    if (!isMoney) return fmtNum(v)
    return fmtMoneyPlain(v)
  }

  // Group summary (row or column) over a set of cells — see groupSummary
  // (pure + unit-tested) for the per-occurrence/pooled/labor semantics.
  const summary = (group: TimeOfDayCell[], occ: number, laborHoursPerOccurrence: number) =>
    groupSummary(group, occ, laborHoursPerOccurrence, basis, metric, labor)

  const cellStyleBase: React.CSSProperties = {
    minWidth: 52,
    height: 40,
    padding: '4px 3px',
    textAlign: 'center',
    fontSize: 12,
    lineHeight: 1.1,
    border: '1px solid rgba(255,255,255,0.6)',
    cursor: 'pointer',
    fontVariantNumeric: 'tabular-nums',
  }
  const headStyle: React.CSSProperties = {
    padding: '4px 2px',
    fontSize: 10,
    color: '#718096',
    textAlign: 'center',
    fontWeight: 600,
  }
  const rowLabelStyle: React.CSSProperties = {
    position: 'sticky',
    left: 0,
    background: '#fff',
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: 700,
    textAlign: 'left',
    zIndex: 1,
    borderRight: '2px solid #e2e8f0',
  }

  // Layout: weekdays are COLUMNS (only 7) and hours are ROWS (~19 open).
  // This keeps the grid narrow so it needs little/no horizontal scroll on
  // a phone, while the longer hour axis scrolls vertically with the page.
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ ...rowLabelStyle, ...headStyle, textAlign: 'left' }}>hr</th>
            {WEEKDAY_ROWS.map((weekday) => {
              const occ = occurrencesByWeekday[weekday] ?? 0
              return (
                <th
                  key={weekday}
                  style={headStyle}
                  title={`${occ} ${WEEKDAY_LABELS[weekday]} business-days in range`}
                >
                  {WEEKDAY_LABELS[weekday]}
                  <span style={{ display: 'block', fontSize: 9, color: '#a0aec0', fontWeight: 400 }}>
                    {occ}w
                  </span>
                </th>
              )
            })}
            <th style={{ ...headStyle, borderLeft: '2px solid #e2e8f0' }}>all</th>
          </tr>
        </thead>
        <tbody>
          {OPEN_HOURS.map((h) => {
            const rowCells = WEEKDAY_ROWS.map((w) => byKey.get(key(w, h))).filter(
              (c): c is TimeOfDayCell => !!c,
            )
            // Per-hour summary pools ALL weekdays at this hour: divide the
            // summed basis by the total weekday-occurrences so "avg per
            // occurrence" stays a per-occurrence average (not the SUM of
            // seven weekday averages).
            const totalOcc = WEEKDAY_ROWS.reduce((a, w) => a + (occurrencesByWeekday[w] ?? 0), 0)
            // One pooled hour → charge one modeled staff-hour per occurrence.
            const rowSummary = summary(rowCells, totalOcc, 1)
            return (
              <tr key={h}>
                <th style={rowLabelStyle}>{hourLabel(h)}</th>
                {WEEKDAY_ROWS.map((weekday) => {
                  const c = byKey.get(key(weekday, h))
                  const v = valueOf(c, weekday)
                  const { bg, fg } = colorFor(v)
                  const k = key(weekday, h)
                  const isSel = selectedKey === k
                  const orders = c?.orders ?? 0
                  // Sample-strength cue: a bright cell built on 1–2 orders is
                  // noise, not a staffing signal. Flag thin cells with a
                  // dotted border + dim and always show the order count.
                  const lowSample = v !== null && orders > 0 && orders < LOW_SAMPLE_ORDERS
                  const select = () => onSelect(c ?? null, isSel ? null : k)
                  return (
                    <td
                      key={weekday}
                      role="button"
                      tabIndex={0}
                      aria-label={`${WEEKDAY_LABELS[weekday]} ${hourLabel(h)}, ${fmt(v)}, ${orders} orders`}
                      onClick={select}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          select()
                        }
                      }}
                      title={`${WEEKDAY_LABELS[weekday]} ${hourLabel(h)} · ${c ? `${orders} orders` : 'no orders'}`}
                      style={{
                        ...cellStyleBase,
                        background: bg,
                        color: fg,
                        opacity: lowSample ? 0.6 : undefined,
                        borderStyle: lowSample ? 'dotted' : undefined,
                        borderColor: lowSample ? 'rgba(0,0,0,0.35)' : undefined,
                        outline: isSel ? '2px solid #2b6cb0' : undefined,
                        outlineOffset: isSel ? -2 : undefined,
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{fmt(v)}</div>
                      {orders > 0 ? (
                        <div style={{ fontSize: 9, opacity: 0.7, fontWeight: 400 }}>n{orders}</div>
                      ) : null}
                    </td>
                  )
                })}
                <td
                  style={{
                    ...cellStyleBase,
                    cursor: 'default',
                    borderLeft: '2px solid #e2e8f0',
                    fontWeight: 700,
                    background: '#f7fafc',
                    color: '#1a202c',
                  }}
                >
                  {fmt(rowSummary)}
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr>
            <th style={{ ...rowLabelStyle, ...headStyle, textAlign: 'left' }}>all</th>
            {WEEKDAY_ROWS.map((weekday) => {
              const occ = occurrencesByWeekday[weekday] ?? 0
              const colCells = OPEN_HOURS.map((h) => byKey.get(key(weekday, h))).filter(
                (c): c is TimeOfDayCell => !!c,
              )
              return (
                <td
                  key={weekday}
                  style={{
                    ...cellStyleBase,
                    cursor: 'default',
                    fontWeight: 700,
                    background: '#f7fafc',
                    color: '#1a202c',
                    borderTop: '2px solid #e2e8f0',
                  }}
                >
                  {/* Full open day → charge a staff-hour for EVERY open hour
                      (zero-order hours are omitted from the API but still
                      cost labor), not just the hours that had orders. */}
                  {fmt(summary(colCells, occ, OPEN_HOURS.length))}
                </td>
              )
            })}
            <th style={{ ...headStyle, background: '#edf2f7', borderLeft: '2px solid #e2e8f0', borderTop: '2px solid #e2e8f0' }} />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
