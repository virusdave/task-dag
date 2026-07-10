import { useEffect, useMemo, useState } from 'react'

import {
  GadsLandingPagesResponseSchema,
  type GadsLandingPagesKpis,
  type GadsLandingPagesResponse,
  type GadsVariantRow,
} from '../../../shared/contracts/index.js'
import { gadsScopeLabel, type GadsScope } from '../../../shared/domain/gadsSites.js'
import { loadJson } from '../../app/fetchJson.js'

import { MetricRangeControls, type MetricRangePresetOption } from './MetricRangeControls.js'

// ---------------------------------------------------------------------------
// GAds → Landing pages dashboard tab (V1).
//
// One per-site surface (scope = bronx | midtown | all), all fed by a
// SINGLE /api/gads/<site-scope>/landing-pages fetch (see
// gadsLandingPagesQueries.ts).
// V1 is observed performance only — funnel + variant table computed
// from the lp_events assignment cohort. Revenue / ROAS are unavailable
// until conversions carry order attribution, so the UI says that
// directly instead of rendering fake zeroes.
//
// Screen order (per issue #18 UI spec):
//   1. Freshness + attribution status strip
//   2. Profitability KPI strip (6 KPIs)
//   3. Next-action card (top issues, each linking to its variant row)
//   4. Funnel waterfall (biggest drop-off called out inline)
//   5. Variant table (dense desktop / horizontal-scroll mobile,
//      low-sample rows hidden behind a toggle)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

const RANGE_PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
]

const DEFAULT_WINDOW_DAYS = 30

function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtPct(v: number | null): string {
  if (v === null) return 'Unavailable'
  return `${(v * 100).toFixed(1)}%`
}

function fmtMoney(v: number | null): string {
  if (v === null) return 'Unavailable'
  return `$${fmtInt(Math.round(v))}`
}

function fmtRatio(v: number | null): string {
  if (v === null) return 'Unavailable'
  return v.toFixed(2)
}

function attributionStatusLabel(status: GadsLandingPagesResponse['attributionStatus']): string {
  switch (status) {
    case 'allocated':
      return 'allocated'
    case 'click-exact':
      return 'click exact'
    case 'incomplete':
      return 'incomplete'
    case 'not-wired':
      return 'unavailable'
  }
}

function costStripLabel(status: GadsLandingPagesResponse['attributionStatus']): string {
  switch (status) {
    case 'allocated':
      return 'Cost allocated'
    case 'click-exact':
      return 'Cost click exact'
    case 'incomplete':
      return 'Cost attribution incomplete'
    case 'not-wired':
      return 'Cost attribution unavailable'
  }
}

function moneyBadge(value: number | null, status: GadsLandingPagesResponse['attributionStatus']): string {
  return value === null ? 'unavailable' : attributionStatusLabel(status)
}

function fmtAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const mins = Math.round(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  return `${Math.round(hrs / 24)} d ago`
}

function scopeApiSegment(scope: GadsScope): `gads-${GadsScope}` {
  return `gads-${scope}`
}

function lastNDaysWindow(days: number, nowMs: number = Date.now()): { fromMs: number; toMs: number } {
  return { fromMs: nowMs - days * DAY_MS, toMs: nowMs }
}

function rangeMatchesDays(range: { fromMs: number; toMs: number }, days: number): boolean {
  const target = lastNDaysWindow(days)
  return Math.abs(range.toMs - target.toMs) < DAY_MS && Math.abs(range.fromMs - target.fromMs) < DAY_MS
}

function isRightCensored(range: { fromMs: number; toMs: number }): boolean {
  return range.toMs > Date.now() - 90 * DAY_MS
}

/** Stable key + readable label for a variant row. */
function variantKey(v: GadsVariantRow): string {
  return [v.site, v.family ?? '∅', v.experimentId ?? '∅', v.policyRuleId ?? '∅', v.branchId ?? '∅'].join('|')
}
/** A DOM id stable across sorts / range changes, so the next-action
 *  card can anchor-jump to the matching variant table row. */
function variantDomId(key: string): string {
  return `gads-lp-variant-${encodeURIComponent(key).replace(/%/g, '')}`
}

/**
 * Shortfall of a variant's rate below the cohort baseline, weighted by
 * its traffic. Comparing to the cohort (not to a perfect 1.0) keeps
 * normal-but-low absolute rates from flooding the action list with
 * noise. Returns 0 when the row is at or above baseline.
 */
function shortfallScore(
  rate: number | null,
  baseline: number | null,
  assignments: number,
): number {
  if (rate === null || baseline === null || rate >= baseline) return 0
  return (baseline - rate) * assignments
}
function variantLabel(v: GadsVariantRow): string {
  const parts: string[] = []
  if (v.experimentId) parts.push(`exp ${v.experimentId}`)
  if (v.branchId) parts.push(`branch ${v.branchId}`)
  else if (v.policyRuleId) parts.push(`rule ${v.policyRuleId}`)
  if (v.family) parts.push(v.family)
  return parts.length > 0 ? parts.join(' · ') : '(default)'
}

interface NextAction {
  readonly key: string
  readonly title: string
  readonly detail: string
  readonly actionLabel: string
}

/**
 * Top issues to act on, observed (not causal). V1 has no cost, so we
 * surface high-traffic variants whose redirect rate (the metric the LP
 * most directly controls) or conversion rate falls BELOW the cohort
 * baseline, weighted by traffic. Comparing to the cohort (not to a
 * perfect 1.0) keeps the list honest. Low-sample rows are excluded so
 * we never send the operator chasing noise.
 */
function deriveNextActions(
  variants: ReadonlyArray<GadsVariantRow>,
  kpis: GadsLandingPagesKpis,
): NextAction[] {
  const eligible = variants.filter((v) => !v.lowSample)
  const scored = eligible
    .map((v) => {
      const redirectScore = shortfallScore(v.redirectRate, kpis.redirectRate, v.assignments)
      const conversionScore = shortfallScore(v.conversionRate, kpis.conversionRate, v.assignments)
      const weak = redirectScore >= conversionScore
      return {
        v,
        score: Math.max(redirectScore, conversionScore),
        metric: weak ? 'redirect' : 'conversion',
        rate: weak ? v.redirectRate : v.conversionRate,
        baseline: weak ? kpis.redirectRate : kpis.conversionRate,
      }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)

  return scored.map((s) => ({
    key: variantKey(s.v),
    title: `Review variant: ${variantLabel(s.v)}`,
    actionLabel: 'Review variant',
    detail:
      s.metric === 'redirect'
        ? `Redirect rate ${fmtPct(s.rate)} vs ${fmtPct(s.baseline)} cohort over ${fmtInt(s.v.assignments)} assignments.`
        : `Conversion rate ${fmtPct(s.rate)} vs ${fmtPct(s.baseline)} cohort over ${fmtInt(s.v.assignments)} assignments.`,
  }))
}

type SortKey = 'priority' | 'assignments' | 'redirectRate' | 'conversionRate'

export function GAdsLandingPagesTab({ scope }: { scope: GadsScope }): JSX.Element {
  const [range, setRange] = useState(() => lastNDaysWindow(DEFAULT_WINDOW_DAYS))
  const [showLowSample, setShowLowSample] = useState<boolean>(false)
  const [sortKey, setSortKey] = useState<SortKey>('priority')

  const [data, setData] = useState<GadsLandingPagesResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const rangePresets = useMemo<ReadonlyArray<MetricRangePresetOption>>(
    () =>
      RANGE_PRESETS.map((p) => ({
        label: p.label,
        active: rangeMatchesDays(range, p.days),
        onSelect: () => setRange(lastNDaysWindow(p.days)),
      })),
    [range],
  )

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams()
    params.set('from', new Date(range.fromMs).toISOString())
    params.set('to', new Date(range.toMs).toISOString())
    setLoading(true)
    setError(null)
    loadJson(
      `/api/gads/${scopeApiSegment(scope)}/landing-pages?${params.toString()}`,
      GadsLandingPagesResponseSchema,
    )
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
  }, [scope, range.fromMs, range.toMs])

  const nextActions = useMemo(
    () => (data ? deriveNextActions(data.variants, data.kpis) : []),
    [data],
  )

  const visibleVariants = useMemo(() => {
    if (!data) return []
    const rows = showLowSample ? data.variants : data.variants.filter((v) => !v.lowSample)
    const sorted = [...rows]
    switch (sortKey) {
      case 'assignments':
        sorted.sort((a, b) => b.assignments - a.assignments)
        break
      case 'redirectRate':
        sorted.sort((a, b) => (a.redirectRate ?? 1) - (b.redirectRate ?? 1))
        break
      case 'conversionRate':
        sorted.sort((a, b) => (a.conversionRate ?? 1) - (b.conversionRate ?? 1))
        break
      case 'priority':
      default:
        // Same baseline-relative shortfall the next-action card uses, so
        // the card and the table top rows agree.
        sorted.sort((a, b) => {
          const sa = Math.max(
            shortfallScore(a.redirectRate, data.kpis.redirectRate, a.assignments),
            shortfallScore(a.conversionRate, data.kpis.conversionRate, a.assignments),
          )
          const sb = Math.max(
            shortfallScore(b.redirectRate, data.kpis.redirectRate, b.assignments),
            shortfallScore(b.conversionRate, data.kpis.conversionRate, b.assignments),
          )
          if (sb !== sa) return sb - sa
          return b.assignments - a.assignments
        })
        break
    }
    return sorted
  }, [data, showLowSample, sortKey])

  const lowSampleCount = useMemo(
    () => (data ? data.variants.filter((v) => v.lowSample).length : 0),
    [data],
  )

  const rightCensored = isRightCensored(range)
  const attributionBadge = data ? attributionStatusLabel(data.attributionStatus) : 'unavailable'

  // The funnel's biggest single drop-off, called out inline.
  const biggestDrop = useMemo(() => {
    if (!data) return null
    let worst: { label: string; rate: number } | null = null
    for (const stage of data.funnel) {
      if (stage.stepRate === null) continue
      const drop = 1 - stage.stepRate
      if (!worst || drop > 1 - worst.rate) worst = { label: stage.label, rate: stage.stepRate }
    }
    return worst
  }, [data])

  return (
    <section className="gads-lp-tab">
      <header className="gads-lp-header">
        <h2 className="gads-lp-title">GAds · Landing pages · {gadsScopeLabel(scope)}</h2>
        <div className="metrics-controls gads-lp-controls">
          <MetricRangeControls presets={rangePresets} range={range} setRange={setRange} />
        </div>
      </header>

      {/* 1. Freshness + attribution status strip */}
      {data && (
        <div className="gads-lp-status">
          <span className={data.freshness.stale ? 'gads-lp-badge is-warn' : 'gads-lp-badge'}>
            {data.freshness.lastCompletedAt
              ? `Rollup ${fmtAgo(data.freshness.lastCompletedAt)}`
              : data.freshness.message}
          </span>
          <span className={data.attributionStatus === 'not-wired' ? 'gads-lp-badge is-pending' : 'gads-lp-badge'}>
            {costStripLabel(data.attributionStatus)}
          </span>
          <span className="gads-lp-badge is-pending">Revenue attribution unavailable</span>
          <span className="gads-lp-badge">GAds-detected traffic only</span>
          {rightCensored && <span className="gads-lp-badge is-warn">Recent cohorts right-censored</span>}
          <span className="gads-lp-badge">Observed performance, not causal lift</span>
          {data.dataQuality.unattributedStageEvents > 0 && (
            <span className="gads-lp-badge is-warn">
              {fmtInt(data.dataQuality.unattributedStageEvents)} unattributed events
            </span>
          )}
          {data.dataQuality.assignmentsMissingId > 0 && (
            <span className="gads-lp-badge is-warn">
              {fmtInt(data.dataQuality.assignmentsMissingId)} assignments missing id
            </span>
          )}
        </div>
      )}

      {loading && <p className="subtle-copy">Loading…</p>}
      {error && <p className="gads-lp-error">Could not load GAds landing-page analytics: {error}</p>}

      {data && !loading && (
        <>
          {/* 2. Profitability KPI strip (impression rate lives in the
              funnel; revenue / ROAS wait for V2 order attribution). */}
          <div className="gads-lp-kpi-strip">
            <Kpi
              label="Ad spend"
              value={fmtMoney(data.kpis.adSpend)}
              badge={moneyBadge(data.kpis.adSpend, data.attributionStatus)}
            />
            <Kpi label="Redirect rate" value={fmtPct(data.kpis.redirectRate)} />
            <Kpi label="Conversion rate" value={fmtPct(data.kpis.conversionRate)} />
            <Kpi
              label="CPA"
              value={fmtMoney(data.kpis.cpa)}
              badge={data.kpis.cpa === null ? 'unavailable' : `${attributionBadge} / observed`}
            />
            <Kpi
              label="Revenue"
              value={fmtMoney(data.kpis.attributedRevenue)}
              badge="deferred"
              hint="Deferred until conversions carry order attribution."
            />
            <Kpi
              label="ROAS"
              value={fmtRatio(data.kpis.roas)}
              badge="deferred"
              hint="Deferred until conversions carry order attribution."
            />
          </div>

          {/* 3. Next-action card (always shown; each action jumps to its
              variant row). */}
          <div className="gads-lp-next-actions">
            <h3 className="gads-lp-section-title">Next actions</h3>
            {nextActions.length > 0 ? (
              <ul className="gads-lp-action-list">
                {nextActions.map((a) => (
                  <li key={a.key} className="gads-lp-action">
                    <span className="gads-lp-action-title">{a.title}</span>
                    <span className="subtle-copy">{a.detail}</span>
                    <a className="gads-lp-action-button" href={`#${variantDomId(a.key)}`}>
                      {a.actionLabel}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="subtle-copy">
                No high-confidence variant issue in this window. Try a longer range before changing
                traffic.
              </p>
            )}
          </div>

          {/* 4. Funnel waterfall */}
          <div className="gads-lp-funnel">
            <h3 className="gads-lp-section-title">
              Funnel
              {biggestDrop && (
                <span className="subtle-copy gads-lp-funnel-note">
                  {' '}
                  Biggest drop-off into {biggestDrop.label} ({fmtPct(biggestDrop.rate)} carried through).
                </span>
              )}
            </h3>
            <div className="gads-lp-funnel-stages">
              {data.funnel.map((stage) => {
                const top = data.funnel[0]?.count ?? 0
                const widthPct = top > 0 ? Math.max(4, Math.round((stage.count / top) * 100)) : 4
                return (
                  <div key={stage.stage} className="gads-lp-funnel-stage">
                    <div className="gads-lp-funnel-label">
                      <span>{stage.label}</span>
                      <span className="gads-lp-funnel-count">{fmtInt(stage.count)}</span>
                    </div>
                    <div className="gads-lp-funnel-bar">
                      <div className="gads-lp-funnel-bar-fill" style={{ width: `${widthPct}%` }} />
                    </div>
                    {stage.stepRate !== null && (
                      <span className="subtle-copy gads-lp-funnel-step">{fmtPct(stage.stepRate)} of previous</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* 5. Variant table */}
          <div className="gads-lp-variants">
            <div className="gads-lp-variants-head">
              <h3 className="gads-lp-section-title">Variants ({fmtInt(visibleVariants.length)})</h3>
              <div className="metrics-control-group">
                <span className="subtle-copy">sort</span>
                <select
                  className="gads-lp-sort"
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                >
                  <option value="priority">Action priority</option>
                  <option value="assignments">Assignments</option>
                  <option value="redirectRate">Redirect rate</option>
                  <option value="conversionRate">Conversion rate</option>
                </select>
                {lowSampleCount > 0 && (
                  <label className="subtle-copy gads-lp-lowsample-toggle">
                    <input
                      type="checkbox"
                      checked={showLowSample}
                      onChange={(e) => setShowLowSample(e.target.checked)}
                    />{' '}
                    show {fmtInt(lowSampleCount)} low-sample (&lt; {data.dataQuality.lowSampleThreshold})
                  </label>
                )}
              </div>
            </div>
            {visibleVariants.length === 0 ? (
              <p className="subtle-copy">No variants with enough assignments in this window.</p>
            ) : (
              <div className="gads-lp-table-scroll">
                <table className="gads-lp-table">
                  <thead>
                    <tr>
                      <th>Variant</th>
                      {scope === 'all' && <th>Site</th>}
                      <th className="num">Assignments</th>
                      <th className="num">Traffic</th>
                      <th className="num" title="Impression rate">Impr.</th>
                      <th className="num" title="Redirect rate">Redirect</th>
                      <th className="num" title="Conversion rate">Conv.</th>
                      <th className="num" title="Average served probability (diagnostic)">Serve p</th>
                      <th className="num">CPA</th>
                      <th>Quality</th>
                      <th className="gads-lp-action-col">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleVariants.map((v) => (
                      <tr
                        id={variantDomId(variantKey(v))}
                        key={variantKey(v)}
                        className={v.lowSample ? 'is-low-sample' : undefined}
                      >
                        <td>
                          {variantLabel(v)}
                          {v.lowSample && <span className="gads-lp-pill">Low sample</span>}
                        </td>
                        {scope === 'all' && <td>{v.site}</td>}
                        <td className="num">{fmtInt(v.assignments)}</td>
                        <td className="num">{fmtPct(v.trafficShare)}</td>
                        <td className="num">{fmtPct(v.impressionRate)}</td>
                        <td className="num">{fmtPct(v.redirectRate)}</td>
                        <td className="num">{fmtPct(v.conversionRate)}</td>
                        <td className="num">{v.avgServedProbability === null ? 'Unavailable' : v.avgServedProbability.toFixed(3)}</td>
                        <td className="num">
                          {fmtMoney(v.cpa)}{' '}
                          <span className={v.cpa === null ? 'gads-lp-pill is-pending' : 'gads-lp-pill'}>
                            {moneyBadge(v.cpa, data.attributionStatus)}
                          </span>
                        </td>
                        <td>
                          {v.lowSample && <span className="gads-lp-pill is-warn">Low sample</span>}
                          {rightCensored && <span className="gads-lp-pill is-warn">Right-censored</span>}
                          {!v.lowSample && !rightCensored && <span className="gads-lp-pill">Observed</span>}
                        </td>
                        <td className="gads-lp-action-col">
                          <a className="gads-lp-action-button" href={`#${variantDomId(variantKey(v))}`}>
                            Review
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function Kpi({
  label,
  value,
  badge,
  hint,
}: {
  label: string
  value: string
  badge?: string
  hint?: string
}): JSX.Element {
  const unavailable = value === 'Unavailable'
  return (
    <div className={unavailable ? 'gads-lp-kpi is-pending' : 'gads-lp-kpi'} title={hint}>
      <div className="gads-lp-kpi-value">{value}</div>
      <div className="gads-lp-kpi-label">
        {label}
        {badge && <span className={unavailable ? 'gads-lp-pill is-pending' : 'gads-lp-pill'}>{badge}</span>}
      </div>
    </div>
  )
}
