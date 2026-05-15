import { describe, expect, it } from 'vitest'

import { buildScheduleCandidates } from './engine.js'

describe('buildScheduleCandidates', () => {
  it('produces requested candidate schedules with dated assignments and no overlapping daily shifts', () => {
    const candidates = buildScheduleCandidates({
      employees: [
        {
          availability: [{ dayOfWeek: 'monday', endTime: '17:00', startTime: '09:00' }],
          hourlyRate: 20,
          id: 'alex',
          maxMinutesPerWeek: 480,
          name: 'Alex',
          preferredDays: ['monday'],
          preferredMinutesPerWeek: null,
          preferredShiftTags: ['opening'],
          qualifications: [],
        },
        {
          availability: [{ dayOfWeek: 'monday', endTime: '17:00', startTime: '09:00' }],
          hourlyRate: 18,
          id: 'bri',
          maxMinutesPerWeek: 480,
          name: 'Bri',
          preferredDays: [],
          preferredMinutesPerWeek: null,
          preferredShiftTags: ['midday'],
          qualifications: [],
        },
      ],
      issues: [],
      notes: [],
      scheduleWeek: {
        endDate: '2026-05-09',
        startDate: '2026-05-03',
      },
      shiftRequirements: [
        {
          allowedEmployeeIds: [],
          continuityGroup: null,
          dayOfWeek: 'monday',
          disallowedEmployeeIds: [],
          endTime: '13:00',
          id: 'open',
          label: 'Opening shift',
          requiredHeadcount: 1,
          requiredQualifications: [],
          roleLabel: null,
          startTime: '09:00',
          tags: ['opening'],
        },
        {
          allowedEmployeeIds: [],
          continuityGroup: null,
          dayOfWeek: 'monday',
          disallowedEmployeeIds: [],
          endTime: '17:00',
          id: 'close',
          label: 'Closing shift',
          requiredHeadcount: 1,
          requiredQualifications: [],
          roleLabel: null,
          startTime: '13:00',
          tags: ['midday'],
        },
      ],
      unknownEntities: [],
      weekDefinition: {
        endsOn: 'saturday',
        startsOn: 'sunday',
      },
    }, 5)

    expect(candidates.length).toBeGreaterThanOrEqual(2)
    expect(candidates.length).toBeLessThanOrEqual(5)
    for (const candidate of candidates) {
      expect(candidate.metrics.totalLaborCost).toBeGreaterThan(0)
      expect(candidate.assignments).toHaveLength(2)
      expect(candidate.metrics.coverageWarningCount).toBe(0)
      expect(new Set(candidate.assignments.flatMap((assignment) => assignment.employeeIds)).size).toBe(2)
      expect(candidate.assignments.every((assignment) => assignment.date === '2026-05-04')).toBe(true)
      expect(candidate.summary).toContain(`${(candidate.metrics.totalAssignedMinutes / 60).toFixed(1)}h/week (${(candidate.metrics.totalAssignedMinutes / 60).toFixed(1)}h total) scheduled`)
      expect(candidate.summary).toContain(`$${candidate.metrics.totalLaborCost.toFixed(2)}/week ($${candidate.metrics.totalLaborCost.toFixed(2)} total) payroll`)
    }
  })

  it('uses company-policy weekly hour defaults when max hours are unspecified', () => {
    const candidates = buildScheduleCandidates({
      employees: [
        {
          availability: [{ dayOfWeek: 'monday', endTime: '17:00', startTime: '09:00' }],
          hourlyRate: 20,
          id: 'alex',
          maxMinutesPerWeek: null,
          name: 'Alex',
          preferredDays: ['monday'],
          preferredMinutesPerWeek: null,
          preferredShiftTags: ['opening'],
          qualifications: [],
        },
        {
          availability: [{ dayOfWeek: 'monday', endTime: '17:00', startTime: '10:00' }],
          hourlyRate: 18,
          id: 'bri',
          maxMinutesPerWeek: 480,
          name: 'Bri',
          preferredDays: [],
          preferredMinutesPerWeek: 0,
          preferredShiftTags: ['midday'],
          qualifications: [],
        },
      ],
      issues: [],
      notes: [],
      scheduleWeek: {
        endDate: '2026-05-09',
        startDate: '2026-05-03',
      },
      shiftRequirements: [
        {
          allowedEmployeeIds: [],
          continuityGroup: null,
          dayOfWeek: 'monday',
          disallowedEmployeeIds: [],
          endTime: '13:00',
          id: 'open',
          label: 'Opening shift',
          requiredHeadcount: 1,
          requiredQualifications: [],
          roleLabel: null,
          startTime: '09:00',
          tags: ['opening'],
        },
      ],
      unknownEntities: [],
      weekDefinition: {
        endsOn: 'saturday',
        startsOn: 'sunday',
      },
    })

    expect(candidates.length).toBeGreaterThanOrEqual(1)
    for (const candidate of candidates) {
      expect(candidate.assignments[0].employeeIds).toEqual(['alex'])
    }
  })

  it('strongly prefers stable recurring assignments across longer scheduling windows', () => {
    const [stableCandidate] = buildScheduleCandidates({
      employees: [
        {
          availability: [{ dayOfWeek: 'monday', endTime: '18:00', startTime: '09:00' }],
          hourlyRate: 21,
          id: 'alex',
          maxMinutesPerWeek: 480,
          name: 'Alex',
          preferredDays: ['monday'],
          preferredMinutesPerWeek: null,
          preferredShiftTags: ['opening'],
          qualifications: [],
        },
        {
          availability: [{ dayOfWeek: 'monday', endTime: '18:00', startTime: '09:00' }],
          hourlyRate: 22,
          id: 'bri',
          maxMinutesPerWeek: 480,
          name: 'Bri',
          preferredDays: ['monday'],
          preferredMinutesPerWeek: null,
          preferredShiftTags: ['opening'],
          qualifications: [],
        },
      ],
      issues: [],
      notes: [],
      scheduleWeek: {
        endDate: '2026-05-30',
        startDate: '2026-05-03',
      },
      shiftRequirements: [
        {
          allowedEmployeeIds: [],
          continuityGroup: null,
          dayOfWeek: 'monday',
          disallowedEmployeeIds: [],
          endTime: '13:00',
          id: 'open',
          label: 'Opening shift',
          requiredHeadcount: 1,
          requiredQualifications: [],
          roleLabel: null,
          startTime: '09:00',
          tags: ['opening'],
        },
      ],
      unknownEntities: [],
      weekDefinition: {
        endsOn: 'saturday',
        startsOn: 'sunday',
      },
    }, 5)

    expect(stableCandidate.label).toBe('Stable weekly cycle')
    expect(stableCandidate.assignments).toHaveLength(4)
    expect(new Set(stableCandidate.assignments.map((assignment) => assignment.employeeIds[0]))).toHaveLength(1)
    expect(stableCandidate.assignments.map((assignment) => assignment.date)).toEqual([
      '2026-05-04',
      '2026-05-11',
      '2026-05-18',
      '2026-05-25',
    ])
  })

  it('enforces explicit role allowlists and blocklists for shifts like QB', () => {
    const [candidate] = buildScheduleCandidates({
      employees: [
        {
          availability: [{ dayOfWeek: 'monday', endTime: '18:00', startTime: '09:00' }],
          hourlyRate: 14,
          id: 'devone',
          maxMinutesPerWeek: 480,
          name: 'Devone',
          preferredDays: ['monday'],
          preferredMinutesPerWeek: null,
          preferredShiftTags: ['qb'],
          qualifications: [],
        },
        {
          availability: [{ dayOfWeek: 'monday', endTime: '18:00', startTime: '09:00' }],
          hourlyRate: 20,
          id: 'dave',
          maxMinutesPerWeek: 480,
          name: 'Dave',
          preferredDays: ['monday'],
          preferredMinutesPerWeek: null,
          preferredShiftTags: [],
          qualifications: ['qb'],
        },
        {
          availability: [{ dayOfWeek: 'monday', endTime: '18:00', startTime: '09:00' }],
          hourlyRate: 20,
          id: 'nico',
          maxMinutesPerWeek: 480,
          name: 'Nico',
          preferredDays: ['monday'],
          preferredMinutesPerWeek: null,
          preferredShiftTags: [],
          qualifications: ['qb'],
        },
        {
          availability: [{ dayOfWeek: 'monday', endTime: '18:00', startTime: '09:00' }],
          hourlyRate: 20,
          id: 'jackie',
          maxMinutesPerWeek: 480,
          name: 'Jackie',
          preferredDays: ['monday'],
          preferredMinutesPerWeek: null,
          preferredShiftTags: [],
          qualifications: ['qb'],
        },
        {
          availability: [{ dayOfWeek: 'monday', endTime: '18:00', startTime: '09:00' }],
          hourlyRate: 20,
          id: 'stephanie',
          maxMinutesPerWeek: 480,
          name: 'Stephanie',
          preferredDays: ['monday'],
          preferredMinutesPerWeek: null,
          preferredShiftTags: [],
          qualifications: ['qb'],
        },
      ],
      issues: [],
      notes: [],
      scheduleWeek: {
        endDate: '2026-05-09',
        startDate: '2026-05-03',
      },
      shiftRequirements: [
        {
          allowedEmployeeIds: ['dave', 'nico', 'jackie', 'stephanie'],
          continuityGroup: null,
          dayOfWeek: 'monday',
          disallowedEmployeeIds: ['devone'],
          endTime: '13:00',
          id: 'qb-passive',
          label: 'Passive slot',
          requiredHeadcount: 1,
          requiredQualifications: ['qb'],
          roleLabel: 'QB',
          startTime: '09:00',
          tags: ['qb'],
        },
      ],
      unknownEntities: [],
      weekDefinition: {
        endsOn: 'saturday',
        startsOn: 'sunday',
      },
    })

    expect(candidate.assignments).toHaveLength(1)
    expect(candidate.assignments[0]?.employeeIds).toHaveLength(1)
    expect(['dave', 'nico', 'jackie', 'stephanie']).toContain(candidate.assignments[0]?.employeeIds[0])
    expect(candidate.assignments[0]?.employeeIds).not.toContain('devone')
  })

  it('keeps the same qualified opener across adjacent continuity-linked segments', () => {
    const [candidate] = buildScheduleCandidates({
      employees: [
        {
          availability: [{ dayOfWeek: 'monday', endTime: '14:00', startTime: '09:45' }],
          hourlyRate: 24,
          id: 'alice',
          maxMinutesPerWeek: 480,
          name: 'Alice',
          preferredDays: [],
          preferredMinutesPerWeek: null,
          preferredShiftTags: ['opening'],
          qualifications: ['qb'],
        },
        {
          availability: [{ dayOfWeek: 'monday', endTime: '14:00', startTime: '10:15' }],
          hourlyRate: 12,
          id: 'bob',
          maxMinutesPerWeek: 480,
          name: 'Bob',
          preferredDays: ['monday'],
          preferredMinutesPerWeek: null,
          preferredShiftTags: ['am'],
          qualifications: ['qb'],
        },
        {
          availability: [{ dayOfWeek: 'monday', endTime: '14:00', startTime: '09:45' }],
          hourlyRate: 9,
          id: 'zaira',
          maxMinutesPerWeek: 480,
          name: 'Zaira',
          preferredDays: ['monday'],
          preferredMinutesPerWeek: null,
          preferredShiftTags: ['am'],
          qualifications: [],
        },
      ],
      issues: [],
      notes: [],
      scheduleWeek: {
        endDate: '2026-05-09',
        startDate: '2026-05-03',
      },
      shiftRequirements: [
        {
          allowedEmployeeIds: [],
          continuityGroup: 'am-opening-qb',
          dayOfWeek: 'monday',
          disallowedEmployeeIds: [],
          endTime: '10:15',
          id: 'qb-open',
          label: 'QB needed to open',
          requiredHeadcount: 1,
          requiredQualifications: ['qb'],
          roleLabel: 'QB',
          startTime: '09:45',
          tags: ['opening', 'qb'],
        },
        {
          allowedEmployeeIds: [],
          continuityGroup: 'am-opening-qb',
          dayOfWeek: 'monday',
          disallowedEmployeeIds: [],
          endTime: '14:00',
          id: 'am-shift',
          label: 'AM shift',
          requiredHeadcount: 1,
          requiredQualifications: ['qb'],
          roleLabel: 'Front counter',
          startTime: '10:15',
          tags: ['am'],
        },
      ],
      unknownEntities: [],
      weekDefinition: {
        endsOn: 'saturday',
        startsOn: 'sunday',
      },
    })

    expect(candidate.assignments).toHaveLength(2)
    expect(candidate.assignments[0]?.employeeIds).toEqual(['alice'])
    expect(candidate.assignments[1]?.employeeIds).toEqual(['alice'])
    expect(candidate.assignments[1]?.employeeIds).not.toContain('bob')
    expect(candidate.assignments[1]?.employeeIds).not.toContain('zaira')
  })

  it('keeps the same qualified opener across overlapping passive overlays without double-counting the overlap', () => {
    const [candidate] = buildScheduleCandidates({
      employees: [
        {
          availability: [{ dayOfWeek: 'monday', endTime: '14:00', startTime: '09:45' }],
          hourlyRate: 24,
          id: 'alice',
          maxMinutesPerWeek: 480,
          name: 'Alice',
          preferredDays: [],
          preferredMinutesPerWeek: null,
          preferredShiftTags: ['opening'],
          qualifications: ['qb'],
        },
        {
          availability: [{ dayOfWeek: 'monday', endTime: '14:00', startTime: '10:00' }],
          hourlyRate: 12,
          id: 'bob',
          maxMinutesPerWeek: 480,
          name: 'Bob',
          preferredDays: ['monday'],
          preferredMinutesPerWeek: null,
          preferredShiftTags: ['am'],
          qualifications: [],
        },
      ],
      issues: [],
      notes: [],
      scheduleWeek: {
        endDate: '2026-05-09',
        startDate: '2026-05-03',
      },
      shiftRequirements: [
        {
          allowedEmployeeIds: [],
          continuityGroup: 'am-opening-qb',
          dayOfWeek: 'monday',
          disallowedEmployeeIds: [],
          endTime: '10:15',
          id: 'qb-open',
          label: 'QB passive opener',
          requiredHeadcount: 1,
          requiredQualifications: ['qb'],
          roleLabel: 'QB',
          startTime: '09:45',
          tags: ['opening', 'passive', 'qb'],
        },
        {
          allowedEmployeeIds: [],
          continuityGroup: 'am-opening-qb',
          dayOfWeek: 'monday',
          disallowedEmployeeIds: [],
          endTime: '14:00',
          id: 'am-shift',
          label: 'AM shift',
          requiredHeadcount: 1,
          requiredQualifications: [],
          roleLabel: 'Front counter',
          startTime: '10:00',
          tags: ['am'],
        },
      ],
      unknownEntities: [],
      weekDefinition: {
        endsOn: 'saturday',
        startsOn: 'sunday',
      },
    })

    expect(candidate.assignments).toHaveLength(2)
    expect(candidate.assignments[0]?.employeeIds).toEqual(['alice'])
    expect(candidate.assignments[1]?.employeeIds).toEqual(['alice'])
    expect(candidate.metrics.totalAssignedMinutes).toBe(255)
  })

  it('counts overnight shift minutes correctly', () => {
    const [candidate] = buildScheduleCandidates({
      employees: [
        {
          availability: [{ dayOfWeek: 'friday', endTime: '23:59', startTime: '00:00' }],
          hourlyRate: 20,
          id: 'night-owl',
          maxMinutesPerWeek: 600,
          name: 'Night Owl',
          preferredDays: ['friday'],
          preferredMinutesPerWeek: null,
          preferredShiftTags: ['pm'],
          qualifications: [],
        },
      ],
      issues: [],
      notes: [],
      scheduleWeek: {
        endDate: '2026-05-09',
        startDate: '2026-05-03',
      },
      shiftRequirements: [
        {
          allowedEmployeeIds: [],
          continuityGroup: null,
          dayOfWeek: 'friday',
          disallowedEmployeeIds: [],
          endTime: '01:00',
          id: 'pm-shift',
          label: 'PM shift',
          requiredHeadcount: 1,
          requiredQualifications: [],
          roleLabel: null,
          startTime: '17:30',
          tags: ['pm'],
        },
      ],
      unknownEntities: [],
      weekDefinition: {
        endsOn: 'saturday',
        startsOn: 'sunday',
      },
    })

    expect(candidate.assignments[0]?.employeeIds).toEqual(['night-owl'])
    expect(candidate.metrics.totalAssignedMinutes).toBe(450)
    expect(candidate.metrics.totalLaborCost).toBe(150)
  })
})
