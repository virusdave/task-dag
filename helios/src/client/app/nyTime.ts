// ---------------------------------------------------------------------------
// NY-time display helpers.
//
// Canon (AGENTS.md "Always use NY timezone …"): every aggregate bucket and
// every UI display in helios is reasoned about in America/New_York wall
// time. Server-side, day / week / month buckets are computed at NY
// midnight and stored as `timestamptz` so they round-trip as UTC
// instants (see `helios/src/server/metrics/timeBuckets.ts`). The hour
// grain is intentionally bucketed in UTC top-of-hour for DST-fall-back
// disambiguation, but for *display* every hour is shown as its NY
// wall-clock equivalent so the operator always sees the same time the
// register prints on a receipt.
//
// The client must never use `getUTCHours()` / `getHours()` / a
// timezone-less `toLocaleString()` to render a metrics timestamp. Both
// would silently produce wrong-by-4-or-5-hours readouts depending on
// the browser's local timezone or whether DST is in effect. Use the
// helpers in this file instead — they all pin to `America/New_York`
// via `Intl.DateTimeFormat`, which means the ICU rules shipped with
// the browser handle EST↔EDT transitions correctly.
// ---------------------------------------------------------------------------

export const NY_TZ = 'America/New_York'

const MONTH_NAMES_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/**
 * Decompose an absolute instant into NY wall-clock parts. The hour is
 * h23 (0..23) so callers can pad / compare numerically without
 * worrying about AM/PM. The weekday is 0..6 where Sun=0, matching the
 * JS getUTCDay convention.
 */
export function nyParts(ms: number): {
  y: number
  m: number // 1..12 (calendar month, NOT 0-based JS month)
  day: number // 1..31
  hour: number // 0..23
  minute: number // 0..59
  weekday: number // 0..6 (Sun=0..Sat=6)
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const p: Record<string, string> = {}
  for (const part of parts) p[part.type] = part.value
  // Intl 'h23' still emits '24' for midnight on some engines.
  const hourStr = p.hour === '24' ? '00' : p.hour
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }
  return {
    y: Number(p.year),
    m: Number(p.month),
    day: Number(p.day),
    hour: Number(hourStr),
    minute: Number(p.minute),
    weekday: weekdayMap[p.weekday ?? 'Sun'] ?? 0,
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "MM-DD HH:MM" in NY time. Used by hover-readout / range labels. */
export function nyShortDateTime(ms: number): string {
  const p = nyParts(ms)
  return `${pad2(p.m)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`
}

/** "YYYY-MM-DD HH:MM" in NY time. */
export function nyLongDateTime(ms: number): string {
  const p = nyParts(ms)
  return `${p.y}-${pad2(p.m)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`
}

/** "MM-DD HH:00" in NY time. Used by hour-grain X-axis tick labels. */
export function nyHourTick(ms: number): string {
  const p = nyParts(ms)
  return `${pad2(p.m)}-${pad2(p.day)} ${pad2(p.hour)}:00`
}

/** "Mmm DD" (or "YYYY Mmm DD" if straddlesYear). NY-time. */
export function nyMonthDayTick(ms: number, straddlesYear: boolean): string {
  const p = nyParts(ms)
  const md = `${MONTH_NAMES_SHORT[p.m - 1]} ${pad2(p.day)}`
  return straddlesYear ? `${p.y} ${md}` : md
}

/** "Mmm YYYY" in NY time. */
export function nyMonthYearTick(ms: number): string {
  const p = nyParts(ms)
  return `${MONTH_NAMES_SHORT[p.m - 1]} ${p.y}`
}

/** "YYYY-MM-DD" in NY time (ISO date only). */
export function nyIsoDate(ms: number): string {
  const p = nyParts(ms)
  return `${p.y}-${pad2(p.m)}-${pad2(p.day)}`
}

/** "MM/DD" in NY time. Short month/day for compact labels. */
export function nyMonthDaySlash(ms: number): string {
  const p = nyParts(ms)
  return `${pad2(p.m)}/${pad2(p.day)}`
}

/**
 * The UTC instant of NY-local midnight at the start of the calendar
 * day containing `ms`. Used for snapping bucket boundaries during
 * X-axis tick generation. Implementation iterates because of DST:
 *
 *   * Naive `Date.UTC(y, m, d) - offset` is off by ±1 hour on
 *     spring-forward / fall-back days.
 *   * One round-trip through `nyParts` → reconstruct → measure offset
 *     → adjust converges in two iterations for whole-hour offsets.
 */
export function nyFloorToDay(ms: number): number {
  const p = nyParts(ms)
  return nyWallClockToInstant(p.y, p.m, p.day, 0)
}

/** Like nyFloorToDay but snaps to the start of the NY hour. */
export function nyFloorToHour(ms: number): number {
  const p = nyParts(ms)
  return nyWallClockToInstant(p.y, p.m, p.day, p.hour)
}

/** ISO-week (Mon-start) NY-local floor. */
export function nyFloorToWeek(ms: number): number {
  const p = nyParts(ms)
  // ISO Monday-start: Mon=0..Sun=6. JS Sun=0..Sat=6 → shift.
  const dow = (p.weekday + 6) % 7
  // Subtract `dow` days. nyAddDays handles month/year roll-over via
  // Date arithmetic on the UTC representation, then re-anchors to NY
  // wall-clock midnight.
  const midnight = nyWallClockToInstant(p.y, p.m, p.day, 0)
  return nyAddDays(midnight, -dow)
}

/** Add `days` to an instant while preserving NY wall-clock midnight. */
export function nyAddDays(ms: number, days: number): number {
  if (days === 0) return ms
  const p = nyParts(ms)
  return nyWallClockToInstant(p.y, p.m, p.day + days, p.hour)
}

/**
 * Snap `ms` to the NY-local first-of-month at or before `ms`.
 * Returns the UTC instant of NY midnight on the 1st of that month.
 */
export function nyFloorToMonth(ms: number): number {
  const p = nyParts(ms)
  return nyWallClockToInstant(p.y, p.m, 1, 0)
}

/**
 * Add `months` to an instant that represents NY first-of-month
 * midnight. Always re-anchors at the 1st, NY-local.
 */
export function nyAddMonthsFromFirst(ms: number, months: number): number {
  const p = nyParts(ms)
  let y = p.y
  let m = p.m + months
  while (m > 12) {
    m -= 12
    y += 1
  }
  while (m < 1) {
    m += 12
    y -= 1
  }
  return nyWallClockToInstant(y, m, 1, 0)
}

const HOUR_MS = 60 * 60 * 1000

/**
 * Convert a NY wall-clock (y/m/d/hour, minute=0, sec=0) into the UTC
 * instant it represents. Iterates twice to converge across DST
 * (NY offsets are always whole-hour, so two iterations are sufficient
 * — same approach as the server-side `nyWallTimeToInstant`).
 *
 * Ambiguous local times resolve to the EARLIER instant; non-existent
 * spring-forward times resolve to the equivalent EDT instant. Neither
 * edge ever applies for the bucket boundaries we use (day / week /
 * month / hour boundaries, none of which collide with the 01:00–03:00
 * window on a DST Sunday in NY).
 */
function nyWallClockToInstant(y: number, m: number, day: number, hour: number): number {
  // First guess: treat the wall-clock as UTC, then subtract the
  // offset at that guess. Iterate so the offset we use matches the
  // offset at the answer (it can differ across the spring-forward
  // boundary).
  const wallAsUtc = Date.UTC(y, m - 1, day, hour, 0, 0)
  let guess = wallAsUtc
  for (let i = 0; i < 4; i += 1) {
    const offset = nyOffsetMillisAt(guess)
    const next = wallAsUtc - offset
    if (next === guess) return next
    guess = next
  }
  return guess
}

/**
 * Offset (ms east of UTC) for NY at the given instant. Always
 * negative — NY is west of UTC. EDT = -14_400_000, EST = -18_000_000.
 */
function nyOffsetMillisAt(instantUtc: number): number {
  const p = nyParts(instantUtc)
  const asIfUtc = Date.UTC(p.y, p.m - 1, p.day, p.hour, p.minute, 0)
  // Round the input to the same minute we just measured, since
  // `nyParts` truncates to minutes.
  const minuteMs = 60 * 1000
  const instantMinute = Math.floor(instantUtc / minuteMs) * minuteMs
  return asIfUtc - instantMinute
}

export const NY_HOUR_MS = HOUR_MS
