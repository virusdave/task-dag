import { describe, expect, it } from 'vitest'

import {
  DEFAULT_UNSPECIFIED_WEEKLY_MAX_MINUTES,
  DEFAULT_UNSPECIFIED_WEEKLY_PREFERRED_MINUTES,
  LLMExtractedConstraintsSchema,
  applySchedulingWeeklyHoursPolicy,
  countSchedulingWeeks,
} from './scheduling.js'

describe('applySchedulingWeeklyHoursPolicy', () => {
  it('defaults both preferred and max weekly minutes when max hours are unspecified', () => {
    const normalizedInput = applySchedulingWeeklyHoursPolicy({
      employees: [
        {
          availability: [{ dayOfWeek: 'monday', endTime: '17:00', startTime: '09:00' }],
          hourlyRate: 22,
          id: 'alex',
          maxMinutesPerWeek: null,
          name: 'Alex',
          preferredDays: [],
          preferredMinutesPerWeek: null,
          preferredShiftTags: [],
          qualifications: [],
        },
        {
          availability: [{ dayOfWeek: 'monday', endTime: '17:00', startTime: '09:00' }],
          hourlyRate: 20,
          id: 'bri',
          maxMinutesPerWeek: 900,
          name: 'Bri',
          preferredDays: [],
          preferredMinutesPerWeek: null,
          preferredShiftTags: [],
          qualifications: [],
        },
      ],
      issues: [],
      notes: [],
      scheduleWeek: {
        endDate: '2026-05-09',
        startDate: '2026-05-03',
      },
      shiftRequirements: [],
      unknownEntities: [],
      weekDefinition: {
        endsOn: 'saturday',
        startsOn: 'sunday',
      },
    })

    expect(normalizedInput.employees[0].maxMinutesPerWeek).toBe(DEFAULT_UNSPECIFIED_WEEKLY_MAX_MINUTES)
    expect(normalizedInput.employees[0].preferredMinutesPerWeek).toBe(DEFAULT_UNSPECIFIED_WEEKLY_PREFERRED_MINUTES)
    expect(normalizedInput.employees[1].maxMinutesPerWeek).toBe(900)
    expect(normalizedInput.employees[1].preferredMinutesPerWeek).toBeNull()
  })

  it('preserves explicit zero preferred hours while defaulting only the missing max', () => {
    const normalizedInput = applySchedulingWeeklyHoursPolicy({
      employees: [
        {
          availability: [{ dayOfWeek: 'monday', endTime: '17:00', startTime: '09:00' }],
          hourlyRate: 19,
          id: 'emergency-fill',
          maxMinutesPerWeek: null,
          name: 'Emergency Fill',
          preferredDays: [],
          preferredMinutesPerWeek: 0,
          preferredShiftTags: [],
          qualifications: [],
        },
      ],
      issues: [],
      notes: [],
      scheduleWeek: {
        endDate: '2026-05-09',
        startDate: '2026-05-03',
      },
      shiftRequirements: [],
      unknownEntities: [],
      weekDefinition: {
        endsOn: 'saturday',
        startsOn: 'sunday',
      },
    })

    expect(normalizedInput.employees[0].maxMinutesPerWeek).toBe(DEFAULT_UNSPECIFIED_WEEKLY_MAX_MINUTES)
    expect(normalizedInput.employees[0].preferredMinutesPerWeek).toBe(0)
  })

  it('counts multi-week Sunday-through-Saturday scheduling windows correctly', () => {
    expect(countSchedulingWeeks({
      endDate: '2026-05-30',
      startDate: '2026-05-03',
    })).toBe(4)
  })

  it('accepts singleton qualification fields on extracted scheduling constraints', () => {
    const parsed = LLMExtractedConstraintsSchema.parse({
      employees: {
        availability: { dayOfWeek: 'monday', endTime: '17:00', startTime: '09:00' },
        hourlyRate: 20,
        maxHoursPerWeek: 32,
        name: 'Alice',
        qualifications: 'QB',
      },
      scheduleWeek: {
        endDate: '2026-05-09',
        startDate: '2026-05-03',
      },
      shiftRequirements: {
        continuityGroup: 'am-opening-qb',
        dayOfWeek: 'monday',
        endTime: '14:00',
        label: 'AM shift',
        requiredHeadcount: 1,
        requiredQualifications: 'QB',
        startTime: '10:15',
      },
    })

    expect(parsed.employees[0]?.qualifications).toEqual(['QB'])
    expect(parsed.shiftRequirements[0]?.requiredQualifications).toEqual(['QB'])
    expect(parsed.shiftRequirements[0]?.continuityGroup).toBe('am-opening-qb')
  })
})
