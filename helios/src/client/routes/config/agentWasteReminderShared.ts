// Pure, unit-testable escalation logic for the agent-waste review REMINDER
// (issue #57, ask #3: an escalating, dismissable notice reminding an admin to
// review the backlog). Kept separate from the React component so the
// pressure/tier/snooze/show logic can be tested without a DOM (this repo's
// client tests are logic-only; there is no jsdom/testing-library harness).
//
// The reminder is deliberately NOT modal-nagging: it is a single dismissable
// banner. Two things make it "escalating without becoming a nag":
//
//   1. The MORE backlogged / staler / more wasteful the queue, the SHORTER
//      the snooze between reminders (higher tier == shorter snooze).
//   2. After a dismiss it re-surfaces early ONLY when the backlog actually
//      GROWS (a new observation arrives) -- not merely because the clock
//      advanced. That is the real meaning of "re-escalate on re-engagement
//      until handled": dismissing snapshots the queue, and genuinely new work
//      breaks through the snooze immediately, while an unchanged queue stays
//      quiet for the full (tier-scaled) snooze window.
//
// NOTE (v1 tuning): backlog write-back is deferred, so nothing DRAINS the
// queue from the UI yet -- the transport is not even wired (the server 503s).
// The thresholds below are tuned so a single item aging in place tops out at
// `high` (never `critical`), and `critical` requires a genuinely large count
// or a lot of measured wasted tokens, so the banner cannot converge on a
// permanent hourly red alert from the clock alone.

import type { AgentWasteObservation } from '../../../shared/contracts/index.js'

/**
 * Ordered pressure tiers, least → most urgent. `none` means "nothing to
 * review, show nothing". Every other tier shows the reminder; the tier only
 * changes HOW LOUD it is and HOW OFTEN it re-surfaces.
 */
export const REMINDER_TIERS = ['none', 'low', 'medium', 'high', 'critical'] as const
export type ReminderTier = (typeof REMINDER_TIERS)[number]

/** Rank of a tier (index into REMINDER_TIERS); higher == more urgent. */
export function tierRank(tier: ReminderTier): number {
  return REMINDER_TIERS.indexOf(tier)
}

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

/**
 * Signals that raise the pressure, evaluated independently; the resulting
 * tier is the MOST urgent any single signal reaches (a queue can be urgent
 * because it is large, OR stale, OR expensive, not only all three at once).
 *
 * Thresholds are intentionally conservative so the reminder stays a nudge,
 * not a nag: a single fresh item is `low` (rare, gentle), and it only climbs
 * to `high`/`critical` when the backlog is genuinely large, has sat for over
 * a week, or represents a lot of measured wasted tokens.
 *
 * `critical` deliberately has NO age trigger: a single item merely aging in
 * place must not escalate to the loudest, most-frequent tier on its own (see
 * the v1-tuning note at the top). Only a large COUNT or a lot of measured
 * wasted TOKENS reaches `critical`.
 */
interface TierThreshold {
  readonly tier: Exclude<ReminderTier, 'none'>
  readonly minCount: number
  /** Infinity disables the age trigger for this tier. */
  readonly minOldestAgeMs: number
  /** Infinity disables the wasted-tokens trigger for this tier. */
  readonly minWastedTokens: number
}

const TIER_THRESHOLDS: readonly TierThreshold[] = [
  { tier: 'critical', minCount: 40, minOldestAgeMs: Infinity, minWastedTokens: 500_000 },
  { tier: 'high', minCount: 15, minOldestAgeMs: 7 * MS_PER_DAY, minWastedTokens: 200_000 },
  { tier: 'medium', minCount: 5, minOldestAgeMs: 3 * MS_PER_DAY, minWastedTokens: 50_000 },
  { tier: 'low', minCount: 1, minOldestAgeMs: 0, minWastedTokens: 0 },
]

/**
 * How long to stay quiet after a dismiss, per tier. SHORTER == more frequent
 * == more escalated. Only the non-`none` tiers appear; `none` never shows so
 * it never snoozes. `critical` is floored at 4h (not 1h) so even the loudest
 * tier is a periodic nudge, not an hourly nag.
 */
const SNOOZE_MS: Record<Exclude<ReminderTier, 'none'>, number> = {
  low: 7 * MS_PER_DAY,
  medium: 2 * MS_PER_DAY,
  high: 8 * MS_PER_HOUR,
  critical: 4 * MS_PER_HOUR,
}

export interface BacklogPressure {
  readonly tier: ReminderTier
  readonly count: number
  /** Age of the oldest still-pending observation, in ms (0 when empty). */
  readonly oldestAgeMs: number
  /** Epoch-ms of the NEWEST observation (0 when none parseable). Used to
   * detect that genuinely new work arrived since a dismiss. */
  readonly newestMs: number
  readonly totalWastedTokens: number
}

/**
 * Derive the backlog pressure from the raw observations and the current time.
 * `now` is injected (not read from Date.now()) so the logic is deterministic
 * and unit-testable. Unparseable timestamps are ignored for age/newest (never
 * throw, never inflate age with NaN). Negative/absent token counts are 0.
 */
export function computeBacklogPressure(
  observations: readonly AgentWasteObservation[],
  now: number,
): BacklogPressure {
  const count = observations.length
  let oldest = Infinity
  let newest = 0
  let totalWastedTokens = 0
  for (const obs of observations) {
    const t = Date.parse(obs.time)
    if (!Number.isNaN(t)) {
      if (t < oldest) {
        oldest = t
      }
      if (t > newest) {
        newest = t
      }
    }
    const tokens = obs.estimated_wasted_tokens
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
      totalWastedTokens += tokens
    }
  }
  // If no observation had a parseable timestamp, age is 0 (unknown, not huge).
  const oldestAgeMs = oldest === Infinity ? 0 : Math.max(0, now - oldest)

  let tier: ReminderTier = 'none'
  if (count > 0) {
    for (const threshold of TIER_THRESHOLDS) {
      if (
        count >= threshold.minCount ||
        oldestAgeMs >= threshold.minOldestAgeMs ||
        totalWastedTokens >= threshold.minWastedTokens
      ) {
        // TIER_THRESHOLDS is ordered most→least urgent, so the first match is
        // the most urgent tier this backlog reaches.
        tier = threshold.tier
        break
      }
    }
  }

  return { tier, count, oldestAgeMs, newestMs: newest, totalWastedTokens }
}

/**
 * Persisted dismiss state (localStorage). `snoozedUntil` is an epoch-ms
 * instant before which the reminder stays hidden; `count` / `newestMs`
 * snapshot the queue AT DISMISS so a later, genuinely-larger queue (new work
 * arrived) can break through the snooze early.
 */
export interface ReminderDismissState {
  readonly snoozedUntil: number
  readonly count: number
  readonly newestMs: number
}

/**
 * Parse a persisted dismiss state defensively. Returns null for anything that
 * is not a well-formed state (corrupt/legacy value, wrong shape, NaN) so a bad
 * localStorage blob just means "show normally", never a crash.
 */
export function parseDismissState(raw: string | null): ReminderDismissState | null {
  if (!raw) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const record = parsed as Record<string, unknown>
  const { snoozedUntil, count, newestMs } = record
  if (
    typeof snoozedUntil !== 'number' ||
    !Number.isFinite(snoozedUntil) ||
    typeof count !== 'number' ||
    !Number.isFinite(count) ||
    typeof newestMs !== 'number' ||
    !Number.isFinite(newestMs)
  ) {
    return null
  }
  return { snoozedUntil, count, newestMs }
}

/**
 * Compute the dismiss state to persist when the admin dismisses the reminder
 * at the given pressure and time. The snooze length shrinks as the tier rises
 * (busier queue nags back sooner), and the queue snapshot lets new work
 * re-surface the reminder before the snooze elapses.
 */
export function nextDismissState(pressure: BacklogPressure, now: number): ReminderDismissState {
  const snoozeMs = pressure.tier === 'none' ? SNOOZE_MS.low : SNOOZE_MS[pressure.tier]
  return { snoozedUntil: now + snoozeMs, count: pressure.count, newestMs: pressure.newestMs }
}

/**
 * The single decision the component asks of this module: given the current
 * pressure, the clock, and the persisted dismiss state, should the reminder
 * be visible right now?
 *
 *  - `none` never shows (nothing to review).
 *  - No prior dismiss → show.
 *  - Genuinely NEW work since the dismiss (more items, or a newer newest) →
 *    show immediately, ignoring the snooze (the "re-escalate until handled"
 *    behavior — keyed to real new work, not to the clock advancing).
 *  - Otherwise honor the snooze window: show only once it has elapsed.
 */
export function shouldShowReminder(
  pressure: BacklogPressure,
  now: number,
  dismissState: ReminderDismissState | null,
): boolean {
  if (pressure.tier === 'none') {
    return false
  }
  if (!dismissState) {
    return true
  }
  const hasNewWork =
    pressure.count > dismissState.count || pressure.newestMs > dismissState.newestMs
  if (hasNewWork) {
    return true
  }
  return now >= dismissState.snoozedUntil
}
