/**
 * <RangeNudgeRow/> — shared "slide the time window" primitive.
 *
 * Rendered inline inside the `<details className="…-range-custom">`
 * panel on every page that exposes a time-range picker with preset
 * chips + a custom panel (CatalogAnalyticsTab, CustomerValueTab,
 * BudtenderPerformanceTab, MetricsLayoutPage). Eight buttons:
 *
 *     ← 1d   ← 7d   ← 30d   ← 90d
 *     1d →   7d →   30d →   90d →
 *
 * Semantics, per operator decision (issue #38, 2026-06-02):
 *
 * - **Slide, don't extend.** Clicking shifts BOTH `fromMs` and `toMs`
 *   by the same delta; the window width is preserved across nudges.
 * - **No future windows.** A forward-nudge that would push `toMs`
 *   past `Date.now()` is disabled (real `<button disabled>`) with a
 *   `title=…` explaining why. We never silently push `toMs` past now.
 *
 * The primitive is deliberately dumb: it takes the current effective
 * `range` and a `setRange` callback. Callers that maintain a "preset
 * vs custom" toggle (CustomerValueTab, BudtenderPerformanceTab) are
 * responsible for flipping that flag in their setter so the chips
 * deactivate after a nudge.
 */
import type { ReactElement } from 'react'

const DAY_MS = 24 * 60 * 60 * 1000

export interface NudgeRange {
  readonly fromMs: number
  readonly toMs: number
}

export interface RangeNudgeRowProps {
  readonly range: NudgeRange
  readonly setRange: (next: NudgeRange) => void
  /**
   * Override the "now" clock. Tests pass a fixed value; production
   * callers leave it undefined so we use `Date.now()` at click time.
   */
  readonly nowMs?: () => number
}

const NUDGE_DAYS: ReadonlyArray<number> = [1, 7, 30, 90]

/**
 * Pure shift function — exported for unit tests.
 *
 * Returns the new window after sliding `range` by `deltaDays` days
 * (negative = earlier, positive = later). The width is exactly
 * preserved: `to - from` is constant across any number of shifts,
 * regardless of `nowMs`.
 */
export function shiftRange(range: NudgeRange, deltaDays: number): NudgeRange {
  const delta = deltaDays * DAY_MS
  return { fromMs: range.fromMs + delta, toMs: range.toMs + delta }
}

/**
 * Would a forward-nudge of `days` push `to` past `now`? Used to
 * decide whether the `Nd →` button is disabled. Backward nudges
 * (`days < 0`) are always allowed.
 */
export function wouldExtendIntoFuture(
  range: NudgeRange,
  days: number,
  nowMs: number,
): boolean {
  if (days <= 0) return false
  return range.toMs + days * DAY_MS > nowMs
}

export function RangeNudgeRow({ range, setRange, nowMs }: RangeNudgeRowProps): ReactElement {
  const getNow = nowMs ?? Date.now
  // Snapshot "now" once per render so the buttons in a single row all
  // agree on what "would push past now" means. Click handlers call
  // getNow() again so a long-open panel still gets a fresh clamp.
  const now = getNow()
  return (
    <div className="metrics-range-nudges" role="group" aria-label="Slide time window">
      {NUDGE_DAYS.map((d) => (
        <button
          key={`back-${d}`}
          type="button"
          className="metrics-site-chip metrics-range-nudge"
          onClick={() => setRange(shiftRange(range, -d))}
          title={`Slide window ${d} day${d === 1 ? '' : 's'} earlier`}
          aria-label={`Slide window ${d} day${d === 1 ? '' : 's'} earlier`}
        >
          {`← ${d}d`}
        </button>
      ))}
      {NUDGE_DAYS.map((d) => {
        const disabled = wouldExtendIntoFuture(range, d, now)
        const title = disabled
          ? `Cannot slide ${d} day${d === 1 ? '' : 's'} forward — would extend window into the future`
          : `Slide window ${d} day${d === 1 ? '' : 's'} later`
        return (
          <button
            key={`fwd-${d}`}
            type="button"
            className="metrics-site-chip metrics-range-nudge"
            disabled={disabled}
            onClick={() => {
              // Re-check against a fresh clock at click time so a
              // panel left open across midnight still clamps correctly.
              if (wouldExtendIntoFuture(range, d, getNow())) return
              setRange(shiftRange(range, d))
            }}
            title={title}
            aria-label={title}
            aria-disabled={disabled || undefined}
          >
            {`${d}d →`}
          </button>
        )
      })}
    </div>
  )
}
