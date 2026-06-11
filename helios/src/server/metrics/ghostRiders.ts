import type {
  MetricAggregation,
  MetricGhostPeriod,
  MetricGhostResponse,
} from '../../shared/contracts/index.js'
import type { MetricRow } from './types.js'
import { advanceBucketStart, floorToBucketStart, previousBucketStart, walkBuckets } from './timeBuckets.js'

// ---------------------------------------------------------------------------
// Ghost Riders — reshape an additive time-series metric into phase-aligned
// cumulative trajectories ("ghosts") for the current period overlaid on the
// prior N periods.
//
// The whole thing runs server-side off the existing metric.query: we fetch
// the metric at a FINE aggregation (hour for a day period, date for a week
// period) over a window covering the current + prior periods, then build a
// running sum within each period keyed on the bucket's PHASE (position within
// its period). Aligning on position (not wall-clock hour/day) sidesteps DST
// math entirely — a business week always has 7 daily buckets, a business day
// has ~24 hourly buckets, and same-phase points line up across periods.
//
// Only valid for ADDITIVE metrics (sums / counts); the route enforces the
// `supports.ghostRiders` opt-in before calling in here.
// ---------------------------------------------------------------------------

const NY_TZ = 'America/New_York'

/** Fine bucket aggregation the running sum is built from. */
const PERIOD_BUCKET_AGG: Record<MetricGhostPeriod, MetricAggregation> = {
  day: 'hour',
  week: 'date',
}

/** The aggregation whose buckets ARE the periods themselves. */
const PERIOD_AGG: Record<MetricGhostPeriod, MetricAggregation> = {
  day: 'date',
  week: 'week',
}

const PHASE_UNIT: Record<MetricGhostPeriod, 'hour' | 'day'> = {
  day: 'hour',
  week: 'day',
}

/** Nominal phase count (DST days can briefly differ; we clamp up). */
const NOMINAL_PHASE_COUNT: Record<MetricGhostPeriod, number> = {
  day: 24,
  week: 7,
}

export interface GhostPeriodSpec {
  readonly age: number
  readonly start: Date
  readonly end: Date
  /** Ordered fine-bucket starts for this period (the phase positions). */
  readonly bucketStarts: Date[]
}

export interface GhostConfig {
  readonly period: MetricGhostPeriod
  readonly lookback: number
  readonly bucketAgg: MetricAggregation
  /** Effective upper bound (clamped to now) used to pick the current period. */
  readonly anchor: Date
  /** Window to fetch the metric over: [fetchFrom, fetchTo). */
  readonly fetchFrom: Date
  readonly fetchTo: Date
  /** Age 0 (current) → age `lookback` (oldest). */
  readonly periods: GhostPeriodSpec[]
}

/**
 * Resolve the period boundaries + fetch window for a Ghost Riders
 * request. `to` is the requested upper bound (or null ⇒ now); we
 * clamp it to now so a future `to` can't manufacture an empty
 * current period, and floor `anchor - 1ms` to the period start so a
 * `to` landing exactly on a period boundary selects the just-
 * completed period rather than an empty fresh one.
 */
export function resolveGhostConfig(args: {
  period: MetricGhostPeriod
  lookback: number
  to: Date | null
  now?: Date
}): GhostConfig {
  const now = args.now ?? new Date()
  const requestedTo = args.to ?? now
  const anchor = requestedTo.getTime() < now.getTime() ? requestedTo : now
  const periodAgg = PERIOD_AGG[args.period]
  const bucketAgg = PERIOD_BUCKET_AGG[args.period]

  // Period containing the anchor (anchor-1ms so an exact-boundary `to`
  // picks the completed period).
  const currentStart = floorToBucketStart(new Date(anchor.getTime() - 1), periodAgg)

  const periods: GhostPeriodSpec[] = []
  let start = currentStart
  for (let age = 0; age <= args.lookback; age++) {
    const end = advanceBucketStart(start, periodAgg)
    const bucketStarts = walkBuckets(start, end, bucketAgg)
    periods.push({ age, start, end, bucketStarts })
    start = previousBucketStart(start, periodAgg)
  }

  const oldest = periods[periods.length - 1]
  return {
    period: args.period,
    lookback: args.lookback,
    bucketAgg,
    anchor,
    fetchFrom: oldest.start,
    // Current period only has data up to the anchor; ghosts are fully
    // before currentStart ≤ anchor so this window covers them all.
    fetchTo: anchor,
    periods,
  }
}

function ghostSeriesKey(baseSeriesId: string, age: number): string {
  return `${baseSeriesId}__ghost_${age}`
}

function numericOrZero(v: string | number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

const NY_WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TZ,
  weekday: 'short',
})
const NY_MONTHDAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TZ,
  month: 'short',
  day: 'numeric',
})

/** "8a", "12p", "11p" — the NY wall-clock hour of an instant. */
function hourLabel(d: Date): string {
  const h = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: NY_TZ,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(d),
  )
  const hour = Number.isFinite(h) ? h : 0
  const suffix = hour < 12 ? 'a' : 'p'
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve}${suffix}`
}

function periodLabel(period: MetricGhostPeriod, spec: GhostPeriodSpec): string {
  const noun = period === 'day' ? 'day' : 'week'
  if (spec.age === 0) return period === 'day' ? 'Today' : 'This week'
  if (spec.age === 1) return `1 ${noun} ago`
  return `${spec.age} ${noun}s ago`
}

export interface GhostBuildResult {
  readonly data: Array<Record<string, string | number | null>>
  readonly ghost: MetricGhostResponse
}

/**
 * Reshape raw fine-bucket metric rows into phase-aligned cumulative
 * ghost series. Returns the `data` rows (one per phase index) plus the
 * `ghost` metadata block the renderer needs.
 */
export function buildGhostResponse(args: {
  seriesIds: readonly string[]
  config: GhostConfig
  rawRows: readonly MetricRow[]
}): GhostBuildResult {
  const { seriesIds, config } = args

  // Index raw rows by fine-bucket-start ms for O(1) phase lookup.
  const byBucketMs = new Map<number, MetricRow>()
  for (const row of args.rawRows) {
    const ms = Date.parse(row.t)
    if (!Number.isNaN(ms)) byBucketMs.set(ms, row)
  }

  const phaseCount = Math.max(
    NOMINAL_PHASE_COUNT[config.period],
    ...config.periods.map((p) => p.bucketStarts.length),
  )

  // Current period's bucket starts are the canonical phase timeline
  // (used for row `t` provenance + phase labels). Fall back to the
  // most recent period that has a bucket at a given phase.
  const current = config.periods[0]
  const anchorMs = config.anchor.getTime()
  let currentPhaseIndex = 0
  for (let i = 0; i < current.bucketStarts.length; i++) {
    if (current.bucketStarts[i].getTime() <= anchorMs) currentPhaseIndex = i
  }

  // Build the output rows scaffold.
  const rows: Array<Record<string, string | number | null>> = []
  const phaseLabels: string[] = []
  for (let phase = 0; phase < phaseCount; phase++) {
    // Representative instant for this phase: prefer the current period,
    // else the newest ghost that reaches this phase.
    let rep: Date | null = current.bucketStarts[phase] ?? null
    if (rep === null) {
      for (const p of config.periods) {
        if (p.bucketStarts[phase]) {
          rep = p.bucketStarts[phase]
          break
        }
      }
    }
    const label =
      rep === null
        ? String(phase)
        : config.period === 'day'
          ? hourLabel(rep)
          : NY_WEEKDAY_FMT.format(rep)
    phaseLabels.push(label)
    rows.push({
      t: (rep ?? current.start).toISOString(),
      phaseIndex: phase,
      phaseLabel: label,
    })
  }

  // Cumulative running sum per (period age, base series).
  for (const spec of config.periods) {
    const isCurrent = spec.age === 0
    for (const sid of seriesIds) {
      const key = ghostSeriesKey(sid, spec.age)
      let cumulative = 0
      for (let phase = 0; phase < phaseCount; phase++) {
        const bucketStart = spec.bucketStarts[phase] ?? null
        if (bucketStart === null) {
          // This period has no bucket at this phase (e.g. DST short day).
          // Carry the line as null past its own end.
          rows[phase][key] = null
          continue
        }
        if (isCurrent && bucketStart.getTime() > anchorMs) {
          // Current period hasn't reached this phase yet — stop the line.
          rows[phase][key] = null
          continue
        }
        const raw = byBucketMs.get(bucketStart.getTime())
        cumulative += raw ? numericOrZero(raw[sid]) : 0
        rows[phase][key] = cumulative
      }
    }
  }

  const ghost: MetricGhostResponse = {
    period: config.period,
    bucketAgg: config.bucketAgg,
    lookback: config.lookback,
    anchor: config.anchor.toISOString(),
    phaseUnit: PHASE_UNIT[config.period],
    phaseCount,
    phaseLabels,
    currentPhaseIndex,
    periods: config.periods.map((p) => ({
      age: p.age,
      start: p.start.toISOString(),
      end: p.end.toISOString(),
      label:
        p.age === 0
          ? periodLabel(config.period, p)
          : `${periodLabel(config.period, p)} (${NY_MONTHDAY_FMT.format(p.start)})`,
      isCurrent: p.age === 0,
    })),
    series: config.periods.flatMap((p) =>
      seriesIds.map((sid) => ({
        key: ghostSeriesKey(sid, p.age),
        baseSeriesId: sid,
        periodAge: p.age,
      })),
    ),
  }

  return { data: rows, ghost }
}

/** Default period when the client doesn't specify one. */
export function inferDefaultGhostPeriod(agg: MetricAggregation): MetricGhostPeriod {
  return agg === 'hour' ? 'day' : 'week'
}
