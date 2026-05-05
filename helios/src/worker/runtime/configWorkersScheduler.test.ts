import { describe, expect, it } from 'vitest'

import { WEEKDAY_MASK_ALL, type ConfigWorkerScheduleWindow } from '../../shared/contracts/index.js'

import { isWithinWindow, pickActiveWindow } from './configWorkersScheduler.js'

function buildWindow(overrides: Partial<ConfigWorkerScheduleWindow>): ConfigWorkerScheduleWindow {
  return {
    weekdayMask: WEEKDAY_MASK_ALL,
    windowStartMinute: 0,
    windowEndMinute: 1440,
    intervalMinutes: 5,
    paused: false,
    notes: null,
    ...overrides,
  }
}

describe('isWithinWindow', () => {
  it('matches a same-day window using local-time hours', () => {
    const window = buildWindow({ windowStartMinute: 8 * 60, windowEndMinute: 17 * 60 })
    const inside = new Date(2026, 4, 5, 12, 0, 0) // Tuesday 12:00 local
    const before = new Date(2026, 4, 5, 7, 59, 0)
    const after = new Date(2026, 4, 5, 17, 0, 0)
    expect(isWithinWindow(window, inside)).toBe(true)
    expect(isWithinWindow(window, before)).toBe(false)
    expect(isWithinWindow(window, after)).toBe(false)
  })

  it('matches a wrap-around window across midnight when start day bit is set', () => {
    const mondayBit = 1 << 1
    const window = buildWindow({
      weekdayMask: mondayBit,
      windowStartMinute: 8 * 60, // 08:00 Monday
      windowEndMinute: 2 * 60,   // 02:00 Tuesday
    })
    const mondayMorning = new Date(2026, 4, 4, 9, 0, 0) // Monday 09:00 local
    const tuesdayPredawn = new Date(2026, 4, 5, 1, 30, 0) // Tuesday 01:30 local
    const tuesdayAfter = new Date(2026, 4, 5, 2, 30, 0) // Tuesday 02:30 local
    const sundayLate = new Date(2026, 4, 3, 23, 0, 0) // Sunday 23:00 local
    expect(isWithinWindow(window, mondayMorning)).toBe(true)
    expect(isWithinWindow(window, tuesdayPredawn)).toBe(true)
    expect(isWithinWindow(window, tuesdayAfter)).toBe(false)
    expect(isWithinWindow(window, sundayLate)).toBe(false)
  })

  it('treats a paused window as inactive at the picker level', () => {
    const window = buildWindow({ windowStartMinute: 0, windowEndMinute: 1440, paused: true })
    const now = new Date(2026, 4, 5, 12, 0, 0)
    expect(isWithinWindow(window, now)).toBe(true) // raw helper still matches
    expect(pickActiveWindow([window], now)).toBe(null) // picker filters paused
  })
})

describe('pickActiveWindow', () => {
  it('prefers the smaller-interval window when two overlap', () => {
    const wide = buildWindow({ windowStartMinute: 0, windowEndMinute: 1440, intervalMinutes: 15 })
    const tight = buildWindow({ windowStartMinute: 8 * 60, windowEndMinute: 18 * 60, intervalMinutes: 2 })
    const noon = new Date(2026, 4, 5, 12, 0, 0)
    const picked = pickActiveWindow([wide, tight], noon)
    expect(picked?.intervalMinutes).toBe(2)
  })

  it('returns null when no window is currently active', () => {
    const window = buildWindow({ windowStartMinute: 8 * 60, windowEndMinute: 12 * 60 })
    const evening = new Date(2026, 4, 5, 20, 0, 0)
    expect(pickActiveWindow([window], evening)).toBe(null)
  })
})
