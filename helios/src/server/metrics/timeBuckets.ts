import type { MetricAggregation } from '../../shared/contracts/index.js'

/**
 * Pure helpers shared by every metrics query that needs to enumerate
 * bucket-start timestamps for a chart's x-axis. All retail bucketing in
 * Helios is done in **America/New_York** time, because every store is
 * in NYC and every operator reasons about "today" / "this week" /
 * "this month" in local calendar time. A sale that closes at
 * 22:30 ET on Wednesday must land in the Wednesday bucket, not the
 * Thursday bucket (which it would if we bucketed in UTC).
 *
 * NOTE — `hour` is intentionally bucketed in UTC, not NY-local.
 * Reasons:
 *   1. NY's UTC offset is always whole hours (EDT = -4, EST = -5), so
 *      UTC top-of-hour boundaries align with NY top-of-hour boundaries
 *      on every day.
 *   2. Bucketing the local 1:00 AM hour on a fall-back Sunday would be
 *      ambiguous (1:00 AM happens twice; date_trunc collapses both
 *      into one bucket, losing one hour of orders). UTC-hour bucketing
 *      preserves both real hours as distinct keys.
 * Day / week / month grains, by contrast, are unambiguous as NY-local
 * calendar boundaries and are bucketed there.
 */

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const NY_TZ = 'America/New_York'

/**
 * Extract the NY wall-clock components for an absolute instant.
 * Uses `Intl.DateTimeFormat` so we don't need a TZ database
 * dependency (Node ships current rules in ICU).
 */
function nyParts(d: Date): {
  y: number
  m: number
  day: number
  hour: number
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const p: Record<string, string> = {}
  for (const part of parts) p[part.type] = part.value
  return {
    y: Number(p.year),
    m: Number(p.month),
    day: Number(p.day),
    // h23 still emits '24' for some Intl impls at midnight; clamp it.
    hour: Number(p.hour === '24' ? '00' : p.hour),
  }
}

/**
 * Compute the America/New_York offset (in ms east of UTC) for an
 * instant. EDT in summer ≈ -4h (offset = -14_400_000), EST in winter
 * ≈ -5h (offset = -18_000_000).
 */
function offsetMillisAt(instantUtc: Date): number {
  const p = nyParts(instantUtc)
  const asIfUtc = Date.UTC(p.y, p.m - 1, p.day, p.hour, 0, 0)
  // Round the input down to the same minute we're approximating with
  // (we only need NY-hour precision for our day/week/month boundaries,
  // and the only thing that matters is the *offset* difference, not
  // the subsecond residue).
  const instantHour = new Date(
    Math.floor(instantUtc.getTime() / HOUR_MS) * HOUR_MS,
  ).getTime()
  return asIfUtc - instantHour
}

/**
 * Convert a NY wall-clock (y/m/d at midnight unless `hour` given) to
 * the UTC instant that represents it. Iterates to converge across DST
 * transitions where the naive "subtract offset" would be off by one
 * hour.
 *
 * Ambiguous fall-back local times (01:30 on the Sunday it happens
 * twice) resolve to the EARLIER instant (EDT). Non-existent
 * spring-forward times (02:30 on the Sunday it doesn't exist) resolve
 * to the equivalent EDT instant (i.e. 02:30 EST → 03:30 EDT). We
 * never call this for local 01:00 or 02:00 in practice — only midnight
 * (day / week / month) and the day-arithmetic adds whole days, never
 * a 1-hour offset — so neither edge actually matters for our bucket
 * boundaries.
 */
function nyWallTimeToInstant(
  y: number,
  m: number,
  day: number,
  hour = 0,
): Date {
  const wallAsUtc = Date.UTC(y, m - 1, day, hour, 0, 0)
  let guess = wallAsUtc
  // Two iterations always converge for America/New_York (whole-hour
  // offsets); the loop is bounded defensively.
  for (let i = 0; i < 4; i++) {
    const offset = offsetMillisAt(new Date(guess))
    const next = wallAsUtc - offset
    if (next === guess) return new Date(next)
    guess = next
  }
  return new Date(guess)
}

/**
 * Normalize a (y, m, day) triple that may have out-of-range members
 * (e.g. day = 32, day = 0) into a valid Gregorian (y, m, day) by
 * round-tripping through `Date.UTC`. Used so we can add 1 day to a
 * NY date by writing `{y, m, day+1}` without worrying about month/year
 * roll-over.
 */
function normalizedYmd(y: number, m: number, day: number): {
  y: number
  m: number
  day: number
} {
  const d = new Date(Date.UTC(y, m - 1, day))
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  }
}

// ----- public API ----------------------------------------------------

/**
 * Pick a default `[from, to)` window for a metric that the caller
 * invoked without explicit `from` / `to`. Window length is chosen so
 * that the chart has "enough but not too many" buckets at the given
 * aggregation:
 *
 *   - hour:        last  7 days  (~168 buckets)
 *   - date:        last 90 days
 *   - week:        last 26 weeks
 *   - month:       last 24 months
 *   - dow, dom, dofortnight, total: last 90 days
 *
 * `to` defaults to "now", `from` is derived. If the caller supplied
 * one bound but not the other, we fill the missing bound from "now"
 * minus the default span (or vice versa).
 */
export function defaultWindow(
  from: Date | null,
  to: Date | null,
  agg: MetricAggregation,
): { from: Date; to: Date } {
  const now = new Date()
  const spanMs = defaultSpanMsForAggregation(agg)
  const resolvedTo = to ?? now
  const resolvedFrom = from ?? new Date(resolvedTo.getTime() - spanMs)
  return { from: resolvedFrom, to: resolvedTo }
}

function defaultSpanMsForAggregation(agg: MetricAggregation): number {
  switch (agg) {
    case 'hour':
      return 7 * DAY_MS
    case 'date':
    case 'dow':
    case 'dom':
    case 'dofortnight':
    case 'total':
      return 90 * DAY_MS
    case 'week':
      return 26 * 7 * DAY_MS
    case 'month':
      return 24 * 30 * DAY_MS
  }
}

/**
 * Enumerate the bucket-start timestamps in `[from, to)` at the given
 * aggregation. The first bucket is `from` rounded DOWN to the nearest
 * bucket boundary; subsequent buckets are produced by `advanceBucketStart`.
 *
 * `total` returns a single bucket at the NY-midnight of `from`. The
 * categorical aggregations (`dow`, `dom`, `dofortnight`) are out of
 * scope for the bucket walker — they slice on a categorical axis the
 * SQL itself does. We treat them like `total` here.
 */
export function walkBuckets(from: Date, to: Date, agg: MetricAggregation): Date[] {
  if (agg === 'total' || agg === 'dow' || agg === 'dom' || agg === 'dofortnight') {
    return [floorTo(from, 'date')]
  }
  const out: Date[] = []
  let cursor = floorTo(from, agg)
  // Bail-out cap so a misconfigured caller cannot DoS the server with
  // a 10-year `hour` walk (~87k buckets) — we still render the first
  // 20k buckets which is way more than any chart can usefully show.
  const HARD_CAP = 20_000
  // Tracking previous instants defends against any pathological case
  // where `advanceBucketStart` fails to make progress.
  let lastCursor = -1
  while (cursor.getTime() < to.getTime() && out.length < HARD_CAP) {
    out.push(cursor)
    const next = advanceBucketStart(cursor, agg)
    if (next.getTime() <= lastCursor) break
    lastCursor = cursor.getTime()
    cursor = next
  }
  return out
}

/**
 * Round an instant DOWN to the nearest bucket boundary at the given
 * grain. See module doc-comment for the UTC-hour vs NY-calendar
 * convention.
 */
function floorTo(d: Date, agg: MetricAggregation): Date {
  if (agg === 'hour') {
    return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS)
  }
  const p = nyParts(d)
  switch (agg) {
    case 'date':
    case 'total':
    case 'dow':
    case 'dom':
    case 'dofortnight':
      return nyWallTimeToInstant(p.y, p.m, p.day)
    case 'week': {
      // ISO week starts Monday. Compute the local DOW via the surrogate
      // (y, m, day)-as-UTC, since the JS Date's DOW math is calendar-
      // pure and doesn't care which timezone we *meant* the y/m/d to be in.
      const surrogate = new Date(Date.UTC(p.y, p.m - 1, p.day))
      const daysSinceMonday = (surrogate.getUTCDay() + 6) % 7
      const monday = normalizedYmd(p.y, p.m, p.day - daysSinceMonday)
      return nyWallTimeToInstant(monday.y, monday.m, monday.day)
    }
    case 'month':
      return nyWallTimeToInstant(p.y, p.m, 1)
  }
}

/**
 * Step forward one bucket from `d`. Calendar grains (date/week/month)
 * use NY wall-clock arithmetic so a fall-back day correctly produces
 * a 25-hour step and a spring-forward day a 23-hour step. Hourly
 * grain is just +1h on the UTC instant.
 */
export function advanceBucketStart(d: Date, agg: MetricAggregation): Date {
  if (agg === 'hour') return new Date(d.getTime() + HOUR_MS)
  const p = nyParts(d)
  switch (agg) {
    case 'date':
    case 'total':
    case 'dow':
    case 'dom':
    case 'dofortnight': {
      const next = normalizedYmd(p.y, p.m, p.day + 1)
      return nyWallTimeToInstant(next.y, next.m, next.day)
    }
    case 'week': {
      const next = normalizedYmd(p.y, p.m, p.day + 7)
      return nyWallTimeToInstant(next.y, next.m, next.day)
    }
    case 'month': {
      const next = normalizedYmd(p.y, p.m + 1, 1)
      return nyWallTimeToInstant(next.y, next.m, next.day)
    }
  }
}
