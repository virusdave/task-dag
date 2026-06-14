import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  TargetTrackingResponseSchema,
  type TargetTrackingAgg,
  type TargetTrackingConfig,
  type TargetTrackingPeriod,
  type TargetTrackingResponse,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'

import { defaultSiteSelection, toggleSiteSelection } from './metricsSiteSelection.js'

const KNOWN_SITES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'bronx', label: 'Bronx' },
  { id: 'midtown', label: 'Midtown' },
]

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const EMPTY_CONFIG: TargetTrackingConfig = {
  version: 1,
  fixedCosts: [],
  laborRateDollarsPerHour: 0,
  weeklyStaffedHours: 0,
}

export interface TargetTrackingTabProps {
  readonly isAdmin: boolean
}

/**
 * Target tracking — break-even progress per period. Operator configures
 * fixed monthly costs + a blended labour rate × weekly staffing schedule;
 * the page prorates that to each period's break-even gross-margin target
 * and charts actual margin $ earned against it, with a pace projection
 * for the in-progress period.
 */
export function TargetTrackingTab({ isAdmin }: TargetTrackingTabProps): JSX.Element {
  const [agg, setAgg] = useState<TargetTrackingAgg>('week')
  const [selectedSites, setSelectedSites] = useState<ReadonlySet<string>>(() => defaultSiteSelection())
  const [data, setData] = useState<TargetTrackingResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const sitesParam = useMemo(() => Array.from(selectedSites).sort().join(','), [selectedSites])

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams()
    params.set('agg', agg)
    if (sitesParam) params.set('sites', sitesParam)
    setLoading(true)
    setError(null)
    loadJson(`/api/target-tracking?${params.toString()}`, TargetTrackingResponseSchema, {
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
  }, [agg, sitesParam, reloadKey])

  const onSaved = useCallback(() => {
    setEditing(false)
    setReloadKey((k) => k + 1)
  }, [])

  const config = data?.config ?? null
  const current = data?.periods.find((p) => p.isCurrent) ?? null

  // Targets/expenses are per-site, so editing requires exactly one
  // selected site. "All sites" (or a multi-site selection) shows the
  // aggregate but can't be edited as a unit.
  const perSite = data?.perSite ?? []
  const editSiteKey = selectedSites.size === 1 ? Array.from(selectedSites)[0]! : null
  const editSite = editSiteKey ? perSite.find((s) => s.siteKey === editSiteKey) ?? null : null
  const canEdit = isAdmin && editSite !== null
  // Sites in the current selection with no saved config — break-even
  // then covers only configured sites while actuals cover all of them.
  const unconfiguredSites = perSite.filter((s) => s.config === null)
  const hasPartialTargets = config !== null && unconfiguredSites.length > 0

  return (
    <div className="target-tracking">
      <div className="target-tracking-toolbar">
        <div className="metrics-site-chips">
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
        <div className="target-tracking-agg">
          <button
            type="button"
            className={`ghost-button${agg === 'week' ? ' is-active' : ''}`}
            onClick={() => setAgg('week')}
          >
            weekly
          </button>
          <button
            type="button"
            className={`ghost-button${agg === 'month' ? ' is-active' : ''}`}
            onClick={() => setAgg('month')}
          >
            monthly
          </button>
        </div>
        {isAdmin ? (
          <button
            type="button"
            className="ghost-button"
            disabled={!canEdit}
            title={canEdit ? undefined : 'Select a single site (Bronx or Midtown) to edit its targets.'}
            onClick={() => setEditing(true)}
          >
            {editSite
              ? `${editSite.config ? '⚙ Edit' : '⚙ Configure'} ${editSite.siteLabel} targets`
              : '⚙ Select one site to edit targets'}
          </button>
        ) : null}
      </div>

      {error ? <p className="metric-chart-error">⚠ {error}</p> : null}
      {loading && !data ? <p className="subtle-copy">Loading…</p> : null}

      {data && !config ? (
        <div className="target-tracking-empty">
          <p>
            No targets configured for {editSite ? editSite.siteLabel : 'the selected site(s)'} yet.{' '}
            {isAdmin
              ? editSite
                ? 'Click “Configure targets” to enter this site’s fixed costs (rent, electricity…), blended labour rate, and weekly staffed hours.'
                : 'Select a single site (Bronx or Midtown), then click “Configure targets”.'
              : 'Ask an admin to configure the per-site cost targets.'}
          </p>
        </div>
      ) : null}

      {hasPartialTargets ? (
        <p className="metric-chart-error" role="status">
          ⚠ No targets saved for {unconfiguredSites.map((s) => s.siteLabel).join(', ')}. Break-even
          covers configured sites only, while actual margin includes every selected site — so this
          comparison may understate the margin needed.
        </p>
      ) : null}

      {data && config ? (
        <>
          {current ? <CurrentPeriodGauge period={current} agg={agg} /> : null}
          <PeriodBarChart periods={data.periods} agg={agg} />
          <CostBreakdown config={config} updatedBy={data.updatedBy} updatedAt={data.updatedAt} />
        </>
      ) : null}

      {editing && editSite ? (
        <TargetConfigModal
          siteKey={editSite.siteKey}
          siteLabel={editSite.siteLabel}
          initial={editSite.config ?? EMPTY_CONFIG}
          onCancel={() => setEditing(false)}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  )
}

function CurrentPeriodGauge({
  period,
  agg,
}: {
  period: TargetTrackingPeriod
  agg: TargetTrackingAgg
}): JSX.Element {
  const target = period.breakEvenDollars
  const actual = period.actualMarginDollars
  const pctToBreakEven = target > 0 ? (actual / target) * 100 : actual > 0 ? 100 : 0
  const projected = period.projectedMarginDollars
  const projPct = target > 0 && projected !== null ? (projected / target) * 100 : null
  const surplus = actual - target
  const projSurplus = projected !== null ? projected - target : null
  const barPct = Math.max(0, Math.min(100, pctToBreakEven))
  const onTrack = projected !== null && projected >= target
  return (
    <section className="target-gauge">
      <header className="target-gauge-head">
        <h3>
          Current {agg === 'week' ? 'week' : 'month'} · {period.label}
        </h3>
        <span className="subtle-copy">
          {Math.round(period.fractionElapsed * 100)}% elapsed
        </span>
      </header>
      <div
        className="target-gauge-bar"
        role="progressbar"
        aria-valuenow={Math.round(pctToBreakEven)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`target-gauge-fill${surplus >= 0 ? ' is-met' : ''}`}
          style={{ width: `${barPct}%` }}
        />
        <div className="target-gauge-marker" style={{ left: '100%' }} title="Break-even" />
      </div>
      <div className="target-gauge-stats">
        <Stat label="Margin so far" value={USD.format(actual)} />
        <Stat label="Break-even target" value={USD.format(target)} />
        <Stat
          label={surplus >= 0 ? 'Surplus' : 'Remaining to break-even'}
          value={USD.format(Math.abs(surplus))}
          tone={surplus >= 0 ? 'good' : 'warn'}
        />
        {projected !== null ? (
          <Stat
            label="Projected (pace)"
            value={`${USD.format(projected)}${projPct !== null ? ` · ${Math.round(projPct)}%` : ''}`}
            tone={onTrack ? 'good' : 'warn'}
          />
        ) : null}
      </div>
      <p className="subtle-copy target-gauge-note">
        {projected === null
          ? 'Too early in the period to project a pace.'
          : onTrack
            ? `On pace to clear break-even by ${USD.format(projSurplus ?? 0)}.`
            : `On pace to fall ${USD.format(Math.abs(projSurplus ?? 0))} short of break-even.`}
      </p>
    </section>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'good' | 'warn'
}): JSX.Element {
  return (
    <div className={`target-stat${tone ? ` target-stat--${tone}` : ''}`}>
      <span className="target-stat-value">{value}</span>
      <span className="target-stat-label">{label}</span>
    </div>
  )
}

function PeriodBarChart({
  periods,
  agg,
}: {
  periods: ReadonlyArray<TargetTrackingPeriod>
  agg: TargetTrackingAgg
}): JSX.Element {
  const width = 720
  const height = 240
  const marginLeft = 52
  const marginRight = 12
  const marginTop = 16
  const marginBottom = 40
  const plotW = width - marginLeft - marginRight
  const plotH = height - marginTop - marginBottom

  const maxVal = Math.max(
    1,
    ...periods.map((p) => Math.max(p.actualMarginDollars, p.breakEvenDollars, p.projectedMarginDollars ?? 0)),
  )
  const yScale = (v: number): number => marginTop + plotH - (v / maxVal) * plotH
  const bandW = plotW / Math.max(1, periods.length)
  const barW = Math.min(48, bandW * 0.6)

  return (
    <section className="target-barchart">
      <h3>
        Margin vs break-even · last {periods.length} {agg === 'week' ? 'weeks' : 'months'}
      </h3>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="Margin vs break-even by period">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = marginTop + plotH - f * plotH
          return (
            <g key={f}>
              <line x1={marginLeft} x2={width - marginRight} y1={y} y2={y} stroke="#e5e5e5" />
              <text x={marginLeft - 6} y={y + 3} textAnchor="end" fontSize="10" fill="#555">
                {USD.format(maxVal * f)}
              </text>
            </g>
          )
        })}
        {periods.map((p, i) => {
          const cx = marginLeft + bandW * i + bandW / 2
          const x = cx - barW / 2
          const met = p.actualMarginDollars >= p.breakEvenDollars
          const barTop = yScale(p.actualMarginDollars)
          const beY = yScale(p.breakEvenDollars)
          return (
            <g key={p.start}>
              {/* actual margin bar */}
              <rect
                x={x}
                y={barTop}
                width={barW}
                height={Math.max(0, marginTop + plotH - barTop)}
                fill={met ? '#2ca02c' : '#d62728'}
                fillOpacity={p.isCurrent ? 0.9 : 0.65}
              >
                <title>
                  {p.label}: margin {USD.format(p.actualMarginDollars)} / break-even{' '}
                  {USD.format(p.breakEvenDollars)}
                  {p.projectedMarginDollars !== null
                    ? ` · projected ${USD.format(p.projectedMarginDollars)}`
                    : ''}
                </title>
              </rect>
              {/* projected (current period) ghost cap */}
              {p.isCurrent && p.projectedMarginDollars !== null ? (
                <rect
                  x={x}
                  y={yScale(p.projectedMarginDollars)}
                  width={barW}
                  height={Math.max(0, barTop - yScale(p.projectedMarginDollars))}
                  fill={p.projectedMarginDollars >= p.breakEvenDollars ? '#2ca02c' : '#d62728'}
                  fillOpacity={0.22}
                />
              ) : null}
              {/* break-even marker */}
              <line
                x1={x - 3}
                x2={x + barW + 3}
                y1={beY}
                y2={beY}
                stroke="#333"
                strokeWidth="2"
                strokeDasharray="4 2"
              />
              <text x={cx} y={height - 24} textAnchor="middle" fontSize="9" fill="#555">
                {p.label}
              </text>
            </g>
          )
        })}
      </svg>
      <p className="subtle-copy">
        Bars = actual margin $ (green ≥ break-even, red below). Dashed line = the
        prorated break-even target. The faded cap on the current period is the
        pace projection.
      </p>
    </section>
  )
}

function CostBreakdown({
  config,
  updatedBy,
  updatedAt,
}: {
  config: TargetTrackingConfig
  updatedBy: string | null
  updatedAt: string | null
}): JSX.Element {
  const monthlyFixed = config.fixedCosts.reduce((a, c) => a + c.monthlyDollars, 0)
  const monthlyLabor = config.laborRateDollarsPerHour * config.weeklyStaffedHours * (52 / 12)
  return (
    <details className="target-cost-breakdown">
      <summary className="subtle-copy">Cost assumptions</summary>
      <div className="target-cost-body">
        <table>
          <tbody>
            {config.fixedCosts.map((c, i) => (
              <tr key={`${c.label}:${i}`}>
                <td>{c.label}</td>
                <td>{USD.format(c.monthlyDollars)}/mo</td>
              </tr>
            ))}
            <tr>
              <td>Fixed costs subtotal</td>
              <td>{USD.format(monthlyFixed)}/mo</td>
            </tr>
            <tr>
              <td>
                Labour ({USD.format(config.laborRateDollarsPerHour)}/hr ×{' '}
                {config.weeklyStaffedHours} hr/wk)
              </td>
              <td>≈ {USD.format(monthlyLabor)}/mo</td>
            </tr>
            <tr className="target-cost-total">
              <td>Total monthly burn</td>
              <td>{USD.format(monthlyFixed + monthlyLabor)}/mo</td>
            </tr>
          </tbody>
        </table>
        {updatedBy ? (
          <p className="subtle-copy">
            Last updated by {updatedBy}
            {updatedAt ? ` on ${new Date(updatedAt).toLocaleDateString()}` : ''}.
          </p>
        ) : null}
      </div>
    </details>
  )
}

function TargetConfigModal({
  siteKey,
  siteLabel,
  initial,
  onCancel,
  onSaved,
}: {
  siteKey: string
  siteLabel: string
  initial: TargetTrackingConfig
  onCancel: () => void
  onSaved: () => void
}): JSX.Element {
  const [fixedCosts, setFixedCosts] = useState(() =>
    initial.fixedCosts.map((c) => ({ label: c.label, monthlyDollars: String(c.monthlyDollars) })),
  )
  const [laborRate, setLaborRate] = useState(String(initial.laborRateDollarsPerHour))
  const [weeklyHours, setWeeklyHours] = useState(String(initial.weeklyStaffedHours))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const addRow = () => setFixedCosts((rows) => [...rows, { label: '', monthlyDollars: '' }])
  const removeRow = (i: number) => setFixedCosts((rows) => rows.filter((_, idx) => idx !== i))
  const updateRow = (i: number, field: 'label' | 'monthlyDollars', value: string) =>
    setFixedCosts((rows) => rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)))

  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      const body: TargetTrackingConfig = {
        version: 1,
        fixedCosts: fixedCosts
          .map((c) => ({ label: c.label.trim(), monthlyDollars: Number(c.monthlyDollars) || 0 }))
          .filter((c) => c.label.length > 0),
        laborRateDollarsPerHour: Number(laborRate) || 0,
        weeklyStaffedHours: Number(weeklyHours) || 0,
      }
      await mutateJson(
        `/api/target-tracking/config?site=${encodeURIComponent(siteKey)}`,
        TargetTrackingResponseSchema,
        {
          method: 'PUT',
          body: JSON.stringify(body),
        },
      )
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const reset = async () => {
    if (!globalThis.confirm(`Reset ${siteLabel} target config to empty? This clears its saved costs.`))
      return
    setBusy(true)
    setErr(null)
    try {
      await fetch(`/api/target-tracking/config?site=${encodeURIComponent(siteKey)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      })
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="wh-modal-overlay" onClick={onCancel} role="presentation">
      <div className="wh-modal target-config-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3>{siteLabel} target tracking config</h3>
        <p className="subtle-copy">
          Costs for {siteLabel}. Fixed costs are monthly; labour is prorated from a
          blended hourly rate × weekly staffed hours. Break-even = the gross
          margin $ needed to cover these.
        </p>

        <h4 className="target-config-section-title">Fixed monthly costs</h4>
        <div className="target-config-fixed">
          {fixedCosts.map((c, i) => (
            <div key={i} className="target-config-fixed-row">
              <input
                type="text"
                placeholder="e.g. Rent"
                value={c.label}
                onChange={(e) => updateRow(i, 'label', e.target.value)}
              />
              <input
                type="number"
                min="0"
                step="any"
                placeholder="$/month"
                value={c.monthlyDollars}
                onChange={(e) => updateRow(i, 'monthlyDollars', e.target.value)}
              />
              <button
                type="button"
                className="ghost-button target-config-remove"
                aria-label="Remove fixed cost"
                onClick={() => removeRow(i)}
              >
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="ghost-button" onClick={addRow}>
            + Add fixed cost
          </button>
        </div>

        <h4 className="target-config-section-title">Labour</h4>
        <div className="target-config-labor">
          <label>
            Blended cost $/hr
            <input
              type="number"
              min="0"
              step="any"
              value={laborRate}
              onChange={(e) => setLaborRate(e.target.value)}
            />
          </label>
          <label>
            Staffed hours / week
            <input
              type="number"
              min="0"
              step="any"
              value={weeklyHours}
              onChange={(e) => setWeeklyHours(e.target.value)}
            />
          </label>
        </div>

        {err ? <p className="metric-chart-error">⚠ {err}</p> : null}

        <div className="wh-modal-actions target-config-actions">
          <button type="button" className="ghost-button" onClick={reset} disabled={busy}>
            Reset all
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary-button" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save targets'}
          </button>
        </div>
      </div>
    </div>
  )
}
