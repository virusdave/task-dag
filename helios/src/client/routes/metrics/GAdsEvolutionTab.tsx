import { useEffect, useMemo, useState } from 'react'

import {
  GadsEvolutionResponseSchema,
  type GadsActionOutcomeRow,
  type GadsActionType,
  type GadsEvolutionResponse,
  type GadsHotspot,
  type GadsOutcome,
} from '../../../shared/contracts/index.js'
import { gadsScopeLabel, type GadsScope } from '../../../shared/domain/gadsSites.js'
import { loadJson } from '../../app/fetchJson.js'
import { nyMonthDaySlash, nyShortDateTime } from '../../app/nyTime.js'

// ---------------------------------------------------------------------------
// GAds → Evolution dashboard tab (V1, phase P4).
//
// The priority introspection screen for HOW HELIOS REACTED: the L2
// hill-climbing loop's own proposed actions and the outcomes we later
// observed over `gads_ad_attempts`. This is OBSERVED policy-state movement,
// NOT causal ad lift, and the UI badges it as such throughout. Fed by a
// single grant-gated GET /api/gads/evolution fetch (server-derived site
// predicate; no client-supplied widening). Parent epic
// virusdave/top-level#24, Helios child FreshlyBakedNYC/automation#51.
//
// Render order (parent EPIC_PLAN §6, panels 1-4 — the L3 feedback-adoption
// and LP-evolver reaction panels 5-6 are phase P6 and arrive separately):
//   1. Freshness / stale-loop status strip + honest empty state
//   2. Learning heartbeat (hero): outcome-weighted action yield + sparkline
//   3. Loop-health KPI strip
//   4. Action / outcome matrix (with operator flags)
//   5. Hotspots — where Helios keeps failing
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

const RANGE_PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
]

const DEFAULT_WINDOW_DAYS = 90

/** Share of proposals that are `pause` above which the loop looks like it
 *  is over-triaging rather than fixing (parent EPIC_PLAN §6 panel 3). */
const PAUSE_OVER_TRIAGE_SHARE = 0.25
/** Share of observed outcomes that are `superseded` above which runs are
 *  stepping on prior attempts before they were observed. */
const HIGH_SUPERSEDED_SHARE = 0.25

const ACTION_TYPE_LABELS: Record<GadsActionType, string> = {
  repair: 'Repair',
  replace: 'Replace',
  pause: 'Pause',
  monitor: 'Monitor',
  trial_control: 'Trial control',
  trial_variant: 'Trial variant',
}

const OUTCOME_LABELS: Record<GadsOutcome, string> = {
  success: 'Success',
  partial: 'Partial',
  no_change: 'No change',
  worse: 'Worse',
  superseded: 'Superseded',
  ad_disappeared: 'Ad gone',
  unobserved: 'Open',
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtPct(v: number | null): string {
  if (v === null) return 'n/a'
  return `${(v * 100).toFixed(1)}%`
}

/** Signed two-decimal score in [-1, 1]; null when there is no sample. */
function fmtScore(v: number | null): string {
  if (v === null) return 'n/a'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
}

function fmtDelta(v: number | null): string {
  if (v === null) return ''
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
}

function fmtHours(v: number | null): string {
  if (v === null) return 'n/a'
  if (v < 48) return `${v.toFixed(0)} hr`
  return `${(v / 24).toFixed(1)} d`
}

function fmtAgo(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const mins = Math.round(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  return `${Math.round(hrs / 24)} d ago`
}

/** NY-local "MM/DD" label for a `YYYY-MM-DD` week-start date (already
 *  NY-floored server-side); parsed at NY-noon so the date never slips a
 *  day across the EST/EDT boundary, then formatted pinned to NY. */
function fmtWeekStart(weekStart: string): string {
  const ms = Date.parse(`${weekStart}T12:00:00-05:00`)
  if (!Number.isFinite(ms)) return weekStart
  return nyMonthDaySlash(ms)
}

export function GAdsEvolutionTab({ scope }: { scope: GadsScope }): JSX.Element {
  const [windowDays, setWindowDays] = useState<number>(DEFAULT_WINDOW_DAYS)
  const [data, setData] = useState<GadsEvolutionResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const { fromMs, toMs } = useMemo(() => {
    const to = Date.now()
    return { fromMs: to - windowDays * DAY_MS, toMs: to }
  }, [windowDays])

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams()
    params.set('site', scope)
    params.set('from', new Date(fromMs).toISOString())
    params.set('to', new Date(toMs).toISOString())
    setLoading(true)
    setError(null)
    loadJson(`/api/gads/evolution?${params.toString()}`, GadsEvolutionResponseSchema)
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
  }, [scope, fromMs, toMs])

  const hasAttempts = data !== null && data.heartbeat.proposed > 0

  return (
    <section className="gads-lp-tab">
      <header className="gads-lp-header">
        <h2 className="gads-lp-title">GAds · Evolution · {gadsScopeLabel(scope)}</h2>
        <div className="metrics-controls gads-lp-controls">
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
      </header>

      {/* 1. Freshness / stale-loop status strip */}
      {data && (
        <div className="gads-lp-status">
          <span className="gads-lp-badge">Updated {fmtAgo(data.generatedAt)}</span>
          <span className="gads-lp-badge">Observed policy-state movement, not causal ad lift</span>
          {scope === 'all' && (
            <span className="gads-lp-badge">
              May include unknown-scope attempts; unknown hotspot rows are badged
            </span>
          )}
          {data.freshness.lastAttemptAt && data.freshness.isStale && (
            <span className="gads-lp-badge is-warn">
              Loop looks stopped: newest attempt {fmtAgo(data.freshness.lastAttemptAt)}
            </span>
          )}
          {data.freshness.lastAttemptAt && !data.freshness.isStale && (
            <span className="gads-lp-badge">
              Newest attempt {fmtAgo(data.freshness.lastAttemptAt)}
            </span>
          )}
        </div>
      )}

      {loading && <p className="subtle-copy">Loading…</p>}
      {error && (
        <p className="gads-lp-error">Could not load GAds evolution analytics: {error}</p>
      )}

      {data && !loading && !hasAttempts && (
        <p className="subtle-copy">
          No evolver attempts recorded for {gadsScopeLabel(scope)} in this window. The L2
          hill-climbing loop has not proposed any actions here yet, or the attempt feed has
          stopped writing. Try a longer range.
        </p>
      )}

      {data && !loading && hasAttempts && (
        <>
          <HeartbeatHero data={data} />
          <LoopHealthStrip data={data} />
          <ActionOutcomeMatrix data={data} />
          <Hotspots data={data} scope={scope} />
          <p className="subtle-copy">
            L3 feedback-adoption and landing-page reaction panels arrive with phase P6.
          </p>
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// 2. Learning heartbeat (hero)
// ---------------------------------------------------------------------------

function HeartbeatHero({ data }: { data: GadsEvolutionResponse }): JSX.Element {
  const hb = data.heartbeat
  const deltaText = fmtDelta(hb.delta)
  const deltaClass =
    hb.delta === null
      ? 'gads-ev-hero-delta'
      : hb.delta > 0
        ? 'gads-ev-hero-delta is-up'
        : hb.delta < 0
          ? 'gads-ev-hero-delta is-down'
          : 'gads-ev-hero-delta'

  return (
    <div className="gads-ev-hero">
      <div className="gads-ev-hero-main">
        <div className="gads-lp-section-title">Learning heartbeat</div>
        <div className="gads-ev-hero-score">{fmtScore(hb.score)}</div>
        <div className="subtle-copy">
          Outcome-weighted action yield over {fmtInt(hb.gradeableObserved)} graded attempts
          {deltaText && (
            <>
              {' · '}
              <span className={deltaClass}>{deltaText}</span> vs prior {windowLabel(data)}
            </>
          )}
        </div>
        <div className="gads-lp-status gads-ev-hero-badges">
          <span className="gads-lp-badge">
            Coverage {fmtPct(hb.coverage)} ({fmtInt(hb.terminalObserved)}/{fmtInt(hb.proposed)} observed)
          </span>
          {hb.lowSample && (
            <span className="gads-lp-badge is-warn">
              Low sample (&lt; {hb.lowSampleThreshold} graded); score is noisy
            </span>
          )}
        </div>
      </div>
      <Sparkline weekly={hb.weekly} />
    </div>
  )
}

function windowLabel(data: GadsEvolutionResponse): string {
  const ms = Date.parse(data.range.to) - Date.parse(data.range.from)
  if (!Number.isFinite(ms) || ms <= 0) return 'window'
  return `${Math.round(ms / DAY_MS)}d`
}

function Sparkline({
  weekly,
}: {
  weekly: GadsEvolutionResponse['heartbeat']['weekly']
}): JSX.Element {
  const withScore = weekly.filter((w) => w.score !== null)
  if (withScore.length === 0) {
    return (
      <div className="gads-ev-spark-wrap">
        <div className="gads-ev-spark gads-ev-spark-empty">
          <span className="subtle-copy">No weekly trend yet</span>
        </div>
      </div>
    )
  }

  // Latest week with a graded score, surfaced as a visible readout AND
  // used to lead the screen-reader summary.
  const latest = [...weekly].reverse().find((w) => w.score !== null)

  // Full textual fallback for screen-reader / touch users: per-week
  // label, score, and graded count. The bars themselves are decorative
  // (aria-hidden); this text is the accessible source of truth.
  const summary =
    `Weekly learning-heartbeat trend, oldest to newest. ` +
    weekly
      .map((w) =>
        w.score === null
          ? `${fmtWeekStart(w.weekStart)}: no graded attempts`
          : `${fmtWeekStart(w.weekStart)}: ${fmtScore(w.score)}, ${fmtInt(w.gradeableObserved)} graded`,
      )
      .join('. ')

  return (
    <div className="gads-ev-spark-wrap">
      <div className="gads-ev-spark" role="img" aria-label={summary}>
        {weekly.map((w) => {
          const s = w.score
          // Honest fixed [-1, 1] scaling: a |score| of 1 fills the full
          // half-height; a small movement reads small. Floor a nonzero
          // score at 6% so it stays visible.
          const heightPct =
            s === null || s === 0 ? 0 : Math.max(6, Math.min(100, Math.round(Math.abs(s) * 100)))
          const cls =
            s !== null && s < 0 ? 'gads-ev-spark-bar is-neg' : 'gads-ev-spark-bar is-pos'
          return (
            <span key={w.weekStart} className="gads-ev-spark-col" aria-hidden="true">
              <span className="gads-ev-spark-top">
                {s !== null && s > 0 && <span className={cls} style={{ height: `${heightPct}%` }} />}
              </span>
              <span className="gads-ev-spark-axis" />
              <span className="gads-ev-spark-bottom">
                {s !== null && s < 0 && <span className={cls} style={{ height: `${heightPct}%` }} />}
              </span>
            </span>
          )
        })}
      </div>
      {latest && latest.score !== null && (
        <div className="subtle-copy gads-ev-spark-caption">
          Latest week {fmtWeekStart(latest.weekStart)}: {fmtScore(latest.score)} (
          {fmtInt(latest.gradeableObserved)} graded)
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 3. Loop-health KPI strip
// ---------------------------------------------------------------------------

function LoopHealthStrip({ data }: { data: GadsEvolutionResponse }): JSX.Element {
  const lh = data.loopHealth
  // Action-mix split (parent EPIC_PLAN §6: "proposed, split by type") so the
  // pause/repair/replace balance is visible at the top without scrolling
  // into the wide matrix on mobile. Nonzero types only, in the contract's
  // stable order.
  const mixHint =
    lh.proposedByActionType
      .filter((a) => a.count > 0)
      .map((a) => `${ACTION_TYPE_LABELS[a.actionType]} ${fmtInt(a.count)}`)
      .join(' · ') || undefined
  return (
    <div>
      <h3 className="gads-lp-section-title">Loop health</h3>
      <div className="gads-lp-kpi-strip">
        <Kpi label="Actions proposed" value={fmtInt(lh.proposed)} hint={mixHint} />
        <Kpi
          label="Observed / open"
          value={`${fmtInt(lh.observed)} / ${fmtInt(lh.open)}`}
          hint={lh.staleOpen > 0 ? `${fmtInt(lh.staleOpen)} stale-open` : undefined}
          warn={lh.staleOpen > 0}
        />
        <Kpi
          label="Net improvement rate"
          value={fmtPct(lh.netImprovementRate)}
          pending={lh.netImprovementRate === null}
        />
        <Kpi
          label="Waste share"
          value={fmtPct(lh.wasteShare)}
          pending={lh.wasteShare === null}
          hint="no-change + worse + superseded"
        />
        <Kpi
          label="Median latency"
          value={fmtHours(lh.medianLatencyHours)}
          pending={lh.medianLatencyHours === null}
          hint="proposal → outcome"
        />
        <Kpi
          label="Stuck ads"
          value={fmtInt(lh.stuckAds)}
          hint={`≥ ${lh.stuckThreshold} failed repair/replace`}
          warn={lh.stuckAds > 0}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 4. Action / outcome matrix
// ---------------------------------------------------------------------------

function ActionOutcomeMatrix({ data }: { data: GadsEvolutionResponse }): JSX.Element {
  const rows = data.actionOutcomeMatrix
  const flags = useMemo(() => deriveOperatorFlags(rows, data.loopHealth.staleOpen), [rows, data])

  return (
    <div>
      <h3 className="gads-lp-section-title">Action / outcome matrix</h3>
      {flags.length > 0 && (
        <div className="gads-lp-status gads-ev-flags">
          {flags.map((f) => (
            <span key={f} className="gads-lp-badge is-warn">
              {f}
            </span>
          ))}
        </div>
      )}
      <div className="gads-lp-table-scroll">
        <table className="gads-lp-table">
          <thead>
            <tr>
              <th>Action</th>
              <th className="num">Proposed</th>
              <th className="num">Observed</th>
              <th className="num">Success</th>
              <th className="num">Partial</th>
              <th className="num">No change</th>
              <th className="num">Worse</th>
              <th className="num">Superseded</th>
              <th className="num" title="Ad disappeared before observation">Ad gone</th>
              <th className="num">Open</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.actionType}>
                <td>{ACTION_TYPE_LABELS[r.actionType]}</td>
                <td className="num">{fmtInt(r.proposed)}</td>
                <td className="num">{fmtInt(r.observed)}</td>
                <td className="num">{fmtInt(r.success)}</td>
                <td className="num">{fmtInt(r.partial)}</td>
                <td className="num">{fmtInt(r.noChange)}</td>
                <td className="num">{fmtInt(r.worse)}</td>
                <td className="num">{fmtInt(r.superseded)}</td>
                <td className="num">{fmtInt(r.adDisappeared)}</td>
                <td className="num">{fmtInt(r.open)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Operator steering flags from the matrix totals (parent EPIC_PLAN §6
 *  panel 3): pause-share over-triaging, high superseded, high stale-open. */
function deriveOperatorFlags(
  rows: ReadonlyArray<GadsActionOutcomeRow>,
  staleOpen: number,
): string[] {
  const flags: string[] = []
  const totalProposed = rows.reduce((a, r) => a + r.proposed, 0)
  const totalObserved = rows.reduce((a, r) => a + r.observed, 0)
  const totalSuperseded = rows.reduce((a, r) => a + r.superseded, 0)
  const pauseProposed = rows.find((r) => r.actionType === 'pause')?.proposed ?? 0

  if (totalProposed > 0 && pauseProposed / totalProposed > PAUSE_OVER_TRIAGE_SHARE) {
    flags.push(
      `Pause share ${fmtPct(pauseProposed / totalProposed)}; the loop may be over-triaging rather than fixing`,
    )
  }
  if (totalObserved > 0 && totalSuperseded / totalObserved > HIGH_SUPERSEDED_SHARE) {
    flags.push(
      `High superseded ${fmtPct(totalSuperseded / totalObserved)}; runs are stepping on prior attempts before observation`,
    )
  }
  if (staleOpen > 0) {
    flags.push(`${fmtInt(staleOpen)} stale-open attempts; the ingest/observation loop may be unhealthy`)
  }
  return flags
}

// ---------------------------------------------------------------------------
// 5. Hotspots — where Helios keeps failing
// ---------------------------------------------------------------------------

function Hotspots({
  data,
  scope,
}: {
  data: GadsEvolutionResponse
  scope: GadsScope
}): JSX.Element {
  const hotspots = data.hotspots
  return (
    <div>
      <h3 className="gads-lp-section-title">
        Hotspots: where Helios keeps failing
        {data.hotspotsTruncated && (
          <span className="subtle-copy"> · top {fmtInt(data.hotspotLimit)} shown</span>
        )}
      </h3>
      {hotspots.length === 0 ? (
        <p className="subtle-copy">
          No ads with repeated failed repair/replace attempts in this window. Nothing is stuck.
        </p>
      ) : (
        <div className="gads-lp-table-scroll">
          <table className="gads-lp-table">
            <thead>
              <tr>
                <th>Ad</th>
                {scope === 'all' && <th>Site</th>}
                <th className="num">Attempts</th>
                <th className="num" title="repair/replace attempts that graded no_change/worse/partial">Failed repairs</th>
                <th className="num">Success</th>
                <th className="num">Open</th>
                <th>Last outcome</th>
                <th>Last attempt</th>
              </tr>
            </thead>
            <tbody>
              {hotspots.map((h) => (
                <tr key={h.adId}>
                  <td>{hotspotLabel(h)}</td>
                  {scope === 'all' && (
                    <td>
                      {h.site ?? <span className="gads-lp-pill">unknown</span>}
                    </td>
                  )}
                  <td className="num">{fmtInt(h.attempts)}</td>
                  <td className="num">{fmtInt(h.failedRepairs)}</td>
                  <td className="num">{fmtInt(h.success)}</td>
                  <td className="num">{fmtInt(h.open)}</td>
                  <td>{h.lastOutcome ? OUTCOME_LABELS[h.lastOutcome] : 'Open'}</td>
                  <td>{nyShortDateTime(Date.parse(h.lastAttemptAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function hotspotLabel(h: GadsHotspot): string {
  const parts: string[] = []
  if (h.campaignName) parts.push(h.campaignName)
  if (h.adGroupName) parts.push(h.adGroupName)
  parts.push(`ad ${h.adId}`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// Shared KPI cell
// ---------------------------------------------------------------------------

function Kpi({
  label,
  value,
  pending,
  warn,
  hint,
}: {
  label: string
  value: string
  pending?: boolean
  warn?: boolean
  hint?: string
}): JSX.Element {
  const cls = pending ? 'gads-lp-kpi is-pending' : warn ? 'gads-lp-kpi is-warn' : 'gads-lp-kpi'
  return (
    <div className={cls}>
      <div className="gads-lp-kpi-value">{value}</div>
      <div className="gads-lp-kpi-label">
        {label}
        {pending && <span className="gads-lp-pill is-pending">pending</span>}
      </div>
      {hint && <div className="subtle-copy gads-ev-kpi-hint">{hint}</div>}
    </div>
  )
}
