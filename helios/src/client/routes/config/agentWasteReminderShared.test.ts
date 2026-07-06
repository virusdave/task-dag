import { describe, expect, it } from 'vitest'

import type { AgentWasteObservation } from '../../../shared/contracts/index.js'
import {
  computeBacklogPressure,
  nextDismissState,
  parseDismissState,
  shouldShowReminder,
  tierRank,
  type BacklogPressure,
  type ReminderTier,
} from './agentWasteReminderShared.js'

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR
const NOW = Date.parse('2026-07-06T00:00:00.000Z')

function obs(overrides: Partial<AgentWasteObservation>): AgentWasteObservation {
  return {
    time: '2026-07-06T00:00:00.000Z',
    kind: 'tool_footgun',
    id: 'rg-short-r-rejected',
    ...overrides,
  }
}

/** N fresh observations (all at NOW), no wasted-token signal. */
function freshItems(n: number): AgentWasteObservation[] {
  return Array.from({ length: n }, () => obs({ time: '2026-07-06T00:00:00.000Z' }))
}

/** Build a pressure snapshot directly for shouldShow tests. */
function pressure(overrides: Partial<BacklogPressure>): BacklogPressure {
  return {
    tier: 'low',
    count: 1,
    oldestAgeMs: 0,
    newestMs: NOW,
    totalWastedTokens: 0,
    ...overrides,
  }
}

describe('computeBacklogPressure', () => {
  it('is `none` for an empty backlog', () => {
    const p = computeBacklogPressure([], NOW)
    expect(p.tier).toBe('none')
    expect(p.count).toBe(0)
    expect(p.oldestAgeMs).toBe(0)
    expect(p.newestMs).toBe(0)
    expect(p.totalWastedTokens).toBe(0)
  })

  it('a single fresh item is a gentle `low`', () => {
    expect(computeBacklogPressure(freshItems(1), NOW).tier).toBe('low')
  })

  it('escalates to `medium` on count alone (>=5)', () => {
    expect(computeBacklogPressure(freshItems(5), NOW).tier).toBe('medium')
  })

  it('escalates to `high` on count alone (>=15)', () => {
    expect(computeBacklogPressure(freshItems(15), NOW).tier).toBe('high')
  })

  it('escalates to `critical` on count alone (>=40)', () => {
    expect(computeBacklogPressure(freshItems(40), NOW).tier).toBe('critical')
  })

  it('a single item aging in place tops out at `high`, never `critical`', () => {
    const ancient = [obs({ time: new Date(NOW - 90 * MS_PER_DAY).toISOString() })]
    const p = computeBacklogPressure(ancient, NOW)
    expect(p.tier).toBe('high')
    expect(p.oldestAgeMs).toBeGreaterThanOrEqual(7 * MS_PER_DAY)
  })

  it('escalates on measured wasted tokens even with a single item (>=200k => high)', () => {
    const expensive = [obs({ estimated_wasted_tokens: 250_000 })]
    const p = computeBacklogPressure(expensive, NOW)
    expect(p.tier).toBe('high')
    expect(p.totalWastedTokens).toBe(250_000)
  })

  it('reaches `critical` on measured wasted tokens (>=500k)', () => {
    const p = computeBacklogPressure([obs({ estimated_wasted_tokens: 600_000 })], NOW)
    expect(p.tier).toBe('critical')
  })

  it('takes the MOST urgent signal (stale beats small count)', () => {
    const items = [
      obs({ time: new Date(NOW - 8 * MS_PER_DAY).toISOString() }),
      obs({ time: '2026-07-06T00:00:00.000Z' }),
    ]
    // count 2 is only `low`; a >7d oldest item pulls it up to `high`.
    expect(computeBacklogPressure(items, NOW).tier).toBe('high')
  })

  it('reports oldest and newest timestamps', () => {
    const older = new Date(NOW - 5 * MS_PER_DAY).toISOString()
    const newer = new Date(NOW - 1 * MS_PER_HOUR).toISOString()
    const p = computeBacklogPressure([obs({ time: older }), obs({ time: newer })], NOW)
    expect(p.newestMs).toBe(Date.parse(newer))
    expect(p.oldestAgeMs).toBe(5 * MS_PER_DAY)
  })

  it('ignores unparseable timestamps for age/newest (no NaN, no throw)', () => {
    const items = [obs({ time: 'not-a-date' })]
    const p = computeBacklogPressure(items, NOW)
    expect(p.oldestAgeMs).toBe(0)
    expect(p.newestMs).toBe(0)
    expect(p.tier).toBe('low') // still counts as one pending item
  })

  it('ignores absent/negative token counts', () => {
    const items = [obs({ estimated_wasted_tokens: -5 }), obs({})]
    expect(computeBacklogPressure(items, NOW).totalWastedTokens).toBe(0)
  })
})

describe('shouldShowReminder', () => {
  it('never shows for tier none', () => {
    expect(shouldShowReminder(pressure({ tier: 'none' }), NOW, null)).toBe(false)
  })

  it('shows when there is no prior dismiss', () => {
    expect(shouldShowReminder(pressure({ tier: 'low' }), NOW, null)).toBe(true)
  })

  it('stays hidden inside the snooze window with an unchanged queue', () => {
    const p = pressure({ tier: 'low', count: 1, newestMs: NOW })
    const state = nextDismissState(p, NOW)
    expect(shouldShowReminder(p, NOW + MS_PER_DAY, state)).toBe(false)
  })

  it('re-surfaces once the snooze window elapses', () => {
    const p = pressure({ tier: 'high', count: 15, newestMs: NOW })
    const state = nextDismissState(p, NOW)
    // high snoozes 8h; still hidden at 7h, shown at 9h.
    expect(shouldShowReminder(p, NOW + 7 * MS_PER_HOUR, state)).toBe(false)
    expect(shouldShowReminder(p, NOW + 9 * MS_PER_HOUR, state)).toBe(true)
  })

  it('re-surfaces immediately when the count grows (new work)', () => {
    const dismissed = pressure({ tier: 'low', count: 1, newestMs: NOW })
    const state = nextDismissState(dismissed, NOW)
    const grown = pressure({ tier: 'medium', count: 6, newestMs: NOW })
    // Well inside the 7d low snooze, but new items arrived.
    expect(shouldShowReminder(grown, NOW + MS_PER_HOUR, state)).toBe(true)
  })

  it('re-surfaces immediately when a newer observation arrives even at equal count', () => {
    const dismissed = pressure({ tier: 'low', count: 1, newestMs: NOW })
    const state = nextDismissState(dismissed, NOW)
    const refreshed = pressure({ tier: 'low', count: 1, newestMs: NOW + MS_PER_HOUR })
    expect(shouldShowReminder(refreshed, NOW + MS_PER_HOUR, state)).toBe(true)
  })

  it('does NOT re-surface early merely because the clock advanced (no new work)', () => {
    // Same snapshot, later time, still inside snooze: stays quiet. This is the
    // key anti-nag property — pure aging does not break the snooze.
    const p = pressure({ tier: 'high', count: 15, newestMs: NOW })
    const state = nextDismissState(p, NOW)
    expect(shouldShowReminder(p, NOW + 6 * MS_PER_HOUR, state)).toBe(false)
  })
})

describe('nextDismissState snooze durations shrink as tier rises (escalation)', () => {
  it('orders snooze windows low > medium > high > critical', () => {
    const low = nextDismissState(pressure({ tier: 'low' }), NOW).snoozedUntil - NOW
    const medium = nextDismissState(pressure({ tier: 'medium' }), NOW).snoozedUntil - NOW
    const high = nextDismissState(pressure({ tier: 'high' }), NOW).snoozedUntil - NOW
    const critical = nextDismissState(pressure({ tier: 'critical' }), NOW).snoozedUntil - NOW
    expect(low).toBeGreaterThan(medium)
    expect(medium).toBeGreaterThan(high)
    expect(high).toBeGreaterThan(critical)
  })

  it('floors the loudest tier at a periodic nudge (critical snooze >= 4h)', () => {
    const critical = nextDismissState(pressure({ tier: 'critical' }), NOW).snoozedUntil - NOW
    expect(critical).toBeGreaterThanOrEqual(4 * MS_PER_HOUR)
  })

  it('snapshots the queue count/newest at dismiss', () => {
    const state = nextDismissState(pressure({ count: 7, newestMs: NOW }), NOW)
    expect(state.count).toBe(7)
    expect(state.newestMs).toBe(NOW)
  })
})

describe('parseDismissState (defensive)', () => {
  it('round-trips a valid state', () => {
    const state = nextDismissState(pressure({ tier: 'high', count: 15, newestMs: NOW }), NOW)
    expect(parseDismissState(JSON.stringify(state))).toEqual(state)
  })

  it('returns null for empty / malformed / wrong-shape input', () => {
    expect(parseDismissState(null)).toBeNull()
    expect(parseDismissState('')).toBeNull()
    expect(parseDismissState('not json')).toBeNull()
    expect(parseDismissState('[]')).toBeNull()
    expect(parseDismissState('"str"')).toBeNull()
    expect(parseDismissState('{"snoozedUntil":"x","count":1,"newestMs":0}')).toBeNull()
    expect(parseDismissState('{"snoozedUntil":1,"count":"x","newestMs":0}')).toBeNull()
    expect(parseDismissState('{"snoozedUntil":1,"count":1}')).toBeNull()
    // Legacy v1 shape (dismissedTier) is rejected → treated as "show normally".
    expect(parseDismissState('{"snoozedUntil":1,"dismissedTier":"low"}')).toBeNull()
  })
})

describe('tierRank ordering', () => {
  it('ranks tiers least → most urgent', () => {
    const tiers: ReminderTier[] = ['none', 'low', 'medium', 'high', 'critical']
    for (let i = 1; i < tiers.length; i += 1) {
      expect(tierRank(tiers[i]!)).toBeGreaterThan(tierRank(tiers[i - 1]!))
    }
  })
})
