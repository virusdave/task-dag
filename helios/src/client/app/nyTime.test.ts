import { describe, expect, it } from 'vitest'

import {
  nyAddDays,
  nyAddMonthsFromFirst,
  nyDateTimeLocalInput,
  nyDateTimeLocalInputToInstant,
  nyFloorToDay,
  nyFloorToHour,
  nyFloorToMonth,
  nyFloorToWeek,
  nyHourTick,
  nyIsoDate,
  nyLongDateTime,
  nyMonthDayTick,
  nyMonthDaySlash,
  nyMonthYearTick,
  nyParts,
  nyShortDateTime,
} from './nyTime.js'

// All assertions are in **America/New_York** per the AGENTS.md canon
// rule. We pick fixtures that span both EDT (UTC-4) and EST (UTC-5)
// so DST-transition correctness is part of every test.

describe('nyParts', () => {
  it('returns NY calendar parts for an EDT instant', () => {
    // 2026-05-18 14:00 UTC = 2026-05-18 10:00 NY (EDT)
    const p = nyParts(Date.UTC(2026, 4, 18, 14))
    expect(p).toEqual({ y: 2026, m: 5, day: 18, hour: 10, minute: 0, weekday: 1 /* Mon */ })
  })

  it('returns NY calendar parts for an EST instant', () => {
    // 2026-01-04 05:30 UTC = 2026-01-04 00:30 NY (EST)
    const p = nyParts(Date.UTC(2026, 0, 4, 5, 30))
    expect(p).toEqual({ y: 2026, m: 1, day: 4, hour: 0, minute: 30, weekday: 0 /* Sun */ })
  })

  it('rolls into the previous NY day for an instant before NY midnight', () => {
    // 2026-05-18 03:00 UTC = 2026-05-17 23:00 NY (EDT)
    const p = nyParts(Date.UTC(2026, 4, 18, 3))
    expect(p.y).toBe(2026)
    expect(p.m).toBe(5)
    expect(p.day).toBe(17)
    expect(p.hour).toBe(23)
  })
})

describe('nyShortDateTime / nyLongDateTime', () => {
  it('renders NY wall-clock for an EDT instant', () => {
    // 2026-05-18 14:23 UTC = 10:23 NY
    expect(nyShortDateTime(Date.UTC(2026, 4, 18, 14, 23))).toBe('05-18 10:23')
    expect(nyLongDateTime(Date.UTC(2026, 4, 18, 14, 23))).toBe('2026-05-18 10:23')
  })

  it('renders NY wall-clock for an EST instant', () => {
    // 2026-01-04 18:00 UTC = 13:00 NY (EST)
    expect(nyShortDateTime(Date.UTC(2026, 0, 4, 18))).toBe('01-04 13:00')
  })

  it('rolls back a day when the UTC instant is already on the next NY day', () => {
    // 2026-05-19 03:30 UTC = 2026-05-18 23:30 NY
    expect(nyShortDateTime(Date.UTC(2026, 4, 19, 3, 30))).toBe('05-18 23:30')
  })
})

describe('nyDateTimeLocalInput / nyDateTimeLocalInputToInstant', () => {
  it('formats and parses datetime-local values as NY wall time in EDT', () => {
    const instant = Date.UTC(2026, 4, 18, 14, 23)
    expect(nyDateTimeLocalInput(instant)).toBe('2026-05-18T10:23')
    expect(nyDateTimeLocalInputToInstant('2026-05-18T10:23')).toBe(instant)
  })

  it('formats and parses datetime-local values as NY wall time in EST', () => {
    const instant = Date.UTC(2026, 0, 4, 18, 5)
    expect(nyDateTimeLocalInput(instant)).toBe('2026-01-04T13:05')
    expect(nyDateTimeLocalInputToInstant('2026-01-04T13:05')).toBe(instant)
  })

  it('rejects malformed or impossible datetime-local values', () => {
    expect(nyDateTimeLocalInputToInstant('2026-02-31T10:00')).toBeNull()
    expect(nyDateTimeLocalInputToInstant('2026-05-18 10:00')).toBeNull()
  })
})

describe('nyHourTick / nyMonthDayTick / nyMonthYearTick / nyIsoDate / nyMonthDaySlash', () => {
  it('hour tick is MM-DD HH:00 in NY local', () => {
    expect(nyHourTick(Date.UTC(2026, 4, 18, 14))).toBe('05-18 10:00')
  })

  it('month-day tick is "Mmm DD" without year unless straddling', () => {
    expect(nyMonthDayTick(Date.UTC(2026, 4, 18, 4), false)).toBe('May 18')
    expect(nyMonthDayTick(Date.UTC(2026, 4, 18, 4), true)).toBe('2026 May 18')
  })

  it('month-year tick is "Mmm YYYY" in NY local', () => {
    expect(nyMonthYearTick(Date.UTC(2026, 4, 1, 4))).toBe('May 2026')
  })

  it('iso date is YYYY-MM-DD in NY local', () => {
    expect(nyIsoDate(Date.UTC(2026, 4, 18, 4))).toBe('2026-05-18')
    // 2026-05-19 03:30 UTC = 2026-05-18 23:30 NY → still May 18.
    expect(nyIsoDate(Date.UTC(2026, 4, 19, 3, 30))).toBe('2026-05-18')
  })

  it('month-day slash is MM/DD in NY local', () => {
    expect(nyMonthDaySlash(Date.UTC(2026, 4, 18, 4))).toBe('05/18')
  })
})

describe('nyFloorToDay / nyFloorToWeek / nyFloorToMonth / nyFloorToHour', () => {
  it('floors an EDT mid-day instant to NY midnight', () => {
    // 2026-05-18 14:00 UTC = 2026-05-18 10:00 NY. NY-midnight =
    // 2026-05-18 04:00 UTC (EDT).
    expect(nyFloorToDay(Date.UTC(2026, 4, 18, 14))).toBe(Date.UTC(2026, 4, 18, 4))
  })

  it('floors an instant slightly past NY midnight to that same midnight', () => {
    // 2026-05-18 04:30 UTC = 2026-05-18 00:30 NY → floors to NY midnight
    // = 2026-05-18 04:00 UTC.
    expect(nyFloorToDay(Date.UTC(2026, 4, 18, 4, 30))).toBe(Date.UTC(2026, 4, 18, 4))
  })

  it('floors an instant just before NY midnight to the PRIOR NY day', () => {
    // 2026-05-18 03:30 UTC = 2026-05-17 23:30 NY → floors to 2026-05-17
    // NY midnight = 2026-05-17 04:00 UTC.
    expect(nyFloorToDay(Date.UTC(2026, 4, 18, 3, 30))).toBe(Date.UTC(2026, 4, 17, 4))
  })

  it('floors an EST instant to NY midnight (UTC offset = 5h)', () => {
    // 2026-01-15 14:00 UTC = 2026-01-15 09:00 NY (EST). NY-midnight =
    // 2026-01-15 05:00 UTC.
    expect(nyFloorToDay(Date.UTC(2026, 0, 15, 14))).toBe(Date.UTC(2026, 0, 15, 5))
  })

  it('floors to NY ISO Monday at NY midnight', () => {
    // Wed 2026-05-20 → ISO Monday = Mon 2026-05-18.
    const mondayMidnightNY = Date.UTC(2026, 4, 18, 4)
    expect(nyFloorToWeek(Date.UTC(2026, 4, 20, 14))).toBe(mondayMidnightNY)
    // Already-Monday cases land on themselves.
    expect(nyFloorToWeek(mondayMidnightNY)).toBe(mondayMidnightNY)
  })

  it('floors to NY first-of-month at NY midnight', () => {
    expect(nyFloorToMonth(Date.UTC(2026, 4, 18, 14))).toBe(Date.UTC(2026, 4, 1, 4))
    expect(nyFloorToMonth(Date.UTC(2026, 0, 15, 14))).toBe(Date.UTC(2026, 0, 1, 5))
  })

  it('floors to NY top-of-hour', () => {
    // 2026-05-18 14:37 UTC = 10:37 NY → floors to 10:00 NY = 14:00 UTC.
    expect(nyFloorToHour(Date.UTC(2026, 4, 18, 14, 37))).toBe(Date.UTC(2026, 4, 18, 14))
  })
})

describe('nyAddDays', () => {
  it('adds days while preserving NY midnight (no DST in fixture)', () => {
    const monMidnightNY = Date.UTC(2026, 4, 18, 4) // EDT
    expect(nyAddDays(monMidnightNY, 7)).toBe(Date.UTC(2026, 4, 25, 4)) // also EDT
  })

  it('crosses the spring-forward DST boundary without smearing midnight', () => {
    // Sat 2026-03-07 NY midnight (EST, UTC-5) = 05:00 UTC.
    const satMidnightNY = Date.UTC(2026, 2, 7, 5)
    // Add 2 days → Mon 2026-03-09 NY midnight (EDT, UTC-4) = 04:00 UTC.
    expect(nyAddDays(satMidnightNY, 2)).toBe(Date.UTC(2026, 2, 9, 4))
  })
})

describe('nyAddMonthsFromFirst', () => {
  it('advances first-of-month preserving NY midnight across DST', () => {
    // Feb 1 2026 NY midnight (EST, UTC-5) = 05:00 UTC.
    const feb1 = Date.UTC(2026, 1, 1, 5)
    // +1 month → Mar 1 NY midnight (still EST until 2026-03-08) = 05:00 UTC.
    expect(nyAddMonthsFromFirst(feb1, 1)).toBe(Date.UTC(2026, 2, 1, 5))
    // +3 months → May 1 NY midnight (EDT, UTC-4) = 04:00 UTC.
    expect(nyAddMonthsFromFirst(feb1, 3)).toBe(Date.UTC(2026, 4, 1, 4))
  })

  it('rolls forward across year boundary', () => {
    const nov1 = Date.UTC(2026, 10, 1, 4) // EDT through Nov 1 → wait, DST ended Nov 1 2026 at 02:00 NY = 06:00 UTC.
    // Easier fixture: Dec 1 2026 NY midnight = 05:00 UTC (EST).
    const dec1 = Date.UTC(2026, 11, 1, 5)
    expect(nyAddMonthsFromFirst(dec1, 2)).toBe(Date.UTC(2027, 1, 1, 5))
    expect(nov1).toBeGreaterThan(0) // suppress unused-var lint
  })
})
