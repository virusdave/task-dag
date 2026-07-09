import { useEffect, useMemo, useState } from 'react'

import {
  GadsEnrichmentResponseSchema,
  GadsEvolutionResponseSchema,
  type GadsActionOutcomeRow,
  type GadsActionType,
  type GadsEnrichmentResponse,
  type GadsEvolutionResponse,
  type GadsHotspot,
  type GadsL3Section,
  type GadsLpSection,
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
// and LP-evolver reaction panels 5-6 are appended from the P6 enrichment
// endpoint):
//   1. Freshness / stale-loop status strip + honest empty state
//   2. Learning heartbeat (hero): outcome-weighted action yield + sparkline
//   3. Loop-health KPI strip
//   4. Action / outcome matrix (with operator flags)
//   5. Hotspots — where Helios keeps failing
//   6. L3 feedback-adoption + landing-page reaction enrichment
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

function fmtDateTime(iso: string | null): string {
  if (!iso) return 'n/a'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return 'n/a'
  return nyShortDateTime(ms)
}

function fmtHash(hash: string | null): string {
  return hash ? `${hash.slice(0, 12)}…` : 'n/a'
}

function labelFromSlug(v: string): string {
  return v.replace(/_/g, ' ')
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
  const [enrichment, setEnrichment] = useState<GadsEnrichmentResponse | null>(null)
  const [enrichmentLoading, setEnrichmentLoading] = useState<boolean>(true)
  const [enrichmentError, setEnrichmentError] = useState<string | null>(null)

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

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams()
    params.set('site', scope)
    setEnrichmentLoading(true)
    setEnrichmentError(null)
    loadJson(`/api/gads/enrichment?${params.toString()}`, GadsEnrichmentResponseSchema)
      .then((r) => {
        if (!cancelled) setEnrichment(r)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setEnrichment(null)
          setEnrichmentError(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setEnrichmentLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [scope])

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
        </>
      )}

      <EnrichmentPanels
        data={enrichment}
        loading={enrichmentLoading}
        error={enrichmentError}
        scope={scope}
      />
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
// 6. L3 feedback-adoption + LP-evolver reaction enrichment
// ---------------------------------------------------------------------------

function EnrichmentPanels({
  data,
  loading,
  error,
  scope,
}: {
  data: GadsEnrichmentResponse | null
  loading: boolean
  error: string | null
  scope: GadsScope
}): JSX.Element {
  return (
    <div className="gads-ev-enrichment">
      <h3 className="gads-lp-section-title">L3 + landing-page reaction</h3>
      {loading && <p className="subtle-copy">Loading enrichment…</p>}
      {error && <p className="gads-lp-error">Could not load GAds enrichment: {error}</p>}
      {data && !loading && (
        <div className="gads-ev-enrichment-grid">
          <L3FeedbackPanel l3={data.l3} scope={scope} generatedAt={data.generatedAt} />
          <LpReactionPanel lp={data.lp} scope={scope} />
        </div>
      )}
    </div>
  )
}

function L3FeedbackPanel({
  l3,
  scope,
  generatedAt,
}: {
  l3: GadsL3Section
  scope: GadsScope
  generatedAt: string
}): JSX.Element {
  const latest = l3.latest
  return (
    <section className="gads-ev-panel">
      <div className="gads-ev-panel-head">
        <div>
          <h4>L3 feedback-adoption</h4>
          <p className="subtle-copy">Global prompt/rule meta-analysis; not site ad lift.</p>
        </div>
        <span className="gads-lp-badge">Updated {fmtAgo(generatedAt)}</span>
      </div>
      <div className="gads-lp-status">
        <span className="gads-lp-badge">
          {l3.available ? `${fmtInt(l3.evaluationsIndexed)} L3 evaluations indexed` : 'No L3 evaluations found'}
        </span>
        {l3.evaluationParseErrors > 0 && (
          <span className="gads-lp-badge is-warn">
            {fmtInt(l3.evaluationParseErrors)} parse errors skipped
          </span>
        )}
        {l3.visibility === 'redacted' && (
          <span className="gads-lp-badge is-warn">
            Free text redacted on {gadsScopeLabel(scope)} view
          </span>
        )}
      </div>
      <div className="gads-lp-kpi-strip gads-ev-mini-kpis">
        <Kpi
          label="Latest L3 run"
          value={latest ? fmtDateTime(latest.generatedAt) : 'n/a'}
          pending={!latest}
          hint={latest?.evaluationId}
        />
        <Kpi
          label="Prompt / rule updates"
          value={latest ? `${fmtInt(latest.promptUpdateCount)} / ${fmtInt(latest.ruleUpdateCount)}` : 'n/a'}
          pending={!latest}
        />
        <Kpi
          label="Addenda sha"
          value={fmtHash(l3.addenda.sha256)}
          pending={!l3.addenda.exists}
          hint={l3.addenda.generatedByEvaluationId ?? undefined}
        />
        <Kpi
          label="Later L2 consumed"
          value={consumptionLabel(l3.consumption.status)}
          pending={l3.consumption.status === 'unknown'}
          hint={l3.consumption.newestL2RunAt ? `newest ${fmtDateTime(l3.consumption.newestL2RunAt)}` : undefined}
        />
      </div>
      <div className="gads-ev-facts">
        <span>Addenda generated {fmtDateTime(l3.addenda.generatedAt)}</span>
        <span>Modified {fmtDateTime(l3.addenda.modifiedAt)}</span>
        <span>L2 refs {l3.addenda.l2RunsReferencedCount ?? 'n/a'}</span>
        {latest && latest.requiresHumanApproval && <span>Human approval required</span>}
      </div>
      {l3.visibility === 'full' && latest && latest.topProposals.length > 0 && (
        <div className="gads-ev-proposals">
          <div className="gads-lp-section-title">
            Top L3 proposals
            {latest.topProposalsTruncated && <span className="subtle-copy"> · truncated</span>}
          </div>
          {latest.topProposals.map((p, i) => (
            <div key={`${p.updateType}-${p.component}-${i}`} className="gads-ev-proposal">
              <strong>{labelFromSlug(p.updateType)} · {p.component}</strong>
              <span className="subtle-copy">Confidence {fmtPct(p.confidence)}</span>
              <p>{p.rationale}</p>
              <p className="subtle-copy">{p.expectedImpact}</p>
            </div>
          ))}
        </div>
      )}
      {l3.visibility === 'full' && l3.addenda.topBullets.length > 0 && (
        <ul className="gads-ev-bullets">
          {l3.addenda.topBullets.map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}
    </section>
  )
}

function LpReactionPanel({ lp, scope }: { lp: GadsLpSection; scope: GadsScope }): JSX.Element {
  return (
    <section className="gads-ev-panel">
      <div className="gads-ev-panel-head">
        <div>
          <h4>Landing-page evolver reaction</h4>
          <p className="subtle-copy">Scoped landingpage_ad_outcomes summary for {gadsScopeLabel(scope)}.</p>
        </div>
        {lp.singleIngest && <span className="gads-lp-badge is-warn">single historical ingest</span>}
      </div>
      <div className="gads-lp-kpi-strip gads-ev-mini-kpis">
        <Kpi label="Outcome rows" value={fmtInt(lp.totalRows)} pending={!lp.available} />
        <Kpi label="Observed / pending" value={`${fmtInt(lp.observedRows)} / ${fmtInt(lp.pendingRows)}`} />
        <Kpi label="Avg confidence" value={fmtPct(lp.avgConfidence)} pending={lp.avgConfidence === null} />
        <Kpi
          label="Last outcome"
          value={fmtDateTime(lp.lastOutcomeObservedAt)}
          pending={lp.lastOutcomeObservedAt === null}
        />
      </div>
      <div className="gads-ev-facts">
        <span>First row {fmtDateTime(lp.firstCreatedAt)}</span>
        <span>Last row {fmtDateTime(lp.lastCreatedAt)}</span>
        {scope === 'all' && <span>Includes unknown-scope rows if present</span>}
      </div>
      {!lp.available ? (
        <p className="subtle-copy">No landing-page ad-outcome rows exist for this scope yet.</p>
      ) : (
        <>
          <div className="gads-lp-table-scroll">
            <table className="gads-lp-table">
              <thead>
                <tr>
                  <th>Signal → action → outcome</th>
                  <th className="num">Rows</th>
                  <th className="num">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {lp.byGroup.map((g) => (
                  <tr key={`${g.signalType}|${g.plannedAction}|${g.outcomeStatus}`}>
                    <td>
                      {labelFromSlug(g.signalType)} → {labelFromSlug(g.plannedAction)} → {labelFromSlug(g.outcomeStatus)}
                    </td>
                    <td className="num">{fmtInt(g.count)}</td>
                    <td className="num">{fmtPct(g.avgConfidence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {lp.byGroupTruncated && <p className="subtle-copy">Signal/action groups truncated.</p>}
          <details className="gads-ev-details">
            <summary>Top landing pages</summary>
            <div className="gads-lp-table-scroll">
              <table className="gads-lp-table">
                <thead>
                  <tr>
                    <th>Landing page key</th>
                    <th className="num">Rows</th>
                    <th className="num">Observed</th>
                    <th className="num">Pending</th>
                  </tr>
                </thead>
                <tbody>
                  {lp.topLandingPages.map((p) => (
                    <tr key={p.landingPageKey}>
                      <td>{p.landingPageKey}</td>
                      <td className="num">{fmtInt(p.count)}</td>
                      <td className="num">{fmtInt(p.observed)}</td>
                      <td className="num">{fmtInt(p.pending)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lp.topLandingPagesTruncated && <p className="subtle-copy">Landing pages truncated.</p>}
          </details>
        </>
      )}
    </section>
  )
}

function consumptionLabel(status: GadsL3Section['consumption']['status']): string {
  switch (status) {
    case 'likely_consumed':
      return 'likely'
    case 'not_yet_consumed':
      return 'not yet'
    case 'unknown':
      return 'unknown'
  }
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
