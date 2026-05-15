import { describe, expect, it } from 'vitest'

import {
  buildSchedulingCandidateCsv,
  buildSchedulingCandidatePresentation,
  buildSchedulingCandidateSummaryText,
} from './schedulingResultsPresenter.js'

describe('buildSchedulingCandidatePresentation', () => {
  it('builds recurring swimlanes, multi-month calendars, and weekly-hours summaries across multi-week windows', () => {
    const presentation = buildSchedulingCandidatePresentation({
      candidateId: 12,
      normalizedInput: {
        employees: [
          {
            availability: [
              { dayOfWeek: 'monday', endTime: '18:00', startTime: '09:00' },
              { dayOfWeek: 'tuesday', endTime: '18:00', startTime: '09:00' },
            ],
            hourlyRate: 22,
            id: 'alex',
            maxMinutesPerWeek: 2_100,
            name: 'Alex',
            preferredDays: ['monday'],
            preferredMinutesPerWeek: 1_920,
            preferredShiftTags: ['opening'],
            qualifications: [],
          },
          {
            availability: [
              { dayOfWeek: 'monday', endTime: '18:00', startTime: '09:00' },
              { dayOfWeek: 'tuesday', endTime: '18:00', startTime: '09:00' },
            ],
            hourlyRate: 20,
            id: 'bri',
            maxMinutesPerWeek: 2_100,
            name: 'Bri',
            preferredDays: ['tuesday'],
            preferredMinutesPerWeek: 1_800,
            preferredShiftTags: ['closing'],
            qualifications: [],
          },
        ],
        issues: [],
        notes: [],
        scheduleWeek: {
          endDate: '2026-05-09',
          startDate: '2026-04-26',
        },
        shiftRequirements: [
          {
            allowedEmployeeIds: [],
            continuityGroup: null,
            dayOfWeek: 'monday',
            disallowedEmployeeIds: [],
            endTime: '13:00',
            id: 'open-mon',
            label: 'Opening',
            requiredHeadcount: 1,
            requiredQualifications: [],
            roleLabel: 'Front counter',
            startTime: '09:00',
            tags: ['opening'],
          },
          {
            allowedEmployeeIds: [],
            continuityGroup: null,
            dayOfWeek: 'tuesday',
            disallowedEmployeeIds: [],
            endTime: '13:00',
            id: 'open-tue',
            label: 'Opening',
            requiredHeadcount: 1,
            requiredQualifications: [],
            roleLabel: 'Front counter',
            startTime: '09:00',
            tags: ['opening'],
          },
        ],
        unknownEntities: [],
        weekDefinition: {
          endsOn: 'saturday',
          startsOn: 'sunday',
        },
      },
      runId: 77,
      schedule: {
        assignments: [
          { date: '2026-04-27', employeeIds: ['alex'], shiftRequirementId: 'open-mon' },
          { date: '2026-04-28', employeeIds: ['alex'], shiftRequirementId: 'open-tue' },
          { date: '2026-05-04', employeeIds: ['alex'], shiftRequirementId: 'open-mon' },
          { date: '2026-05-05', employeeIds: ['bri'], shiftRequirementId: 'open-tue' },
        ],
        candidateCode: 'balanced',
        coverageWarnings: [],
        label: 'Balanced coverage',
        metrics: {
          coverageWarningCount: 0,
          fairnessScore: 92,
          overtimeAssignmentCount: 0,
          preferenceScore: 90,
          totalAssignedMinutes: 480,
          totalLaborCost: 176,
        },
        summary: 'Recurring opening shifts with stable assignments.',
      },
    })

    expect(presentation.months).toHaveLength(2)
    expect(presentation.shiftLanes).toHaveLength(1)
    expect(presentation.shiftLanes[0].cells.find((cell) => cell.date === '2026-04-27')?.assignments).toHaveLength(1)
    expect(presentation.shiftLanes[0].cells.find((cell) => cell.date === '2026-04-28')?.assignments).toHaveLength(1)
    expect(presentation.shiftLanes[0].cells.find((cell) => cell.date === '2026-05-04')?.assignments).toHaveLength(1)

    const mondayEmployee = presentation.days.find((day) => day.date === '2026-04-27')?.assignments[0].assignedEmployees[0]
    const followingMondayEmployee = presentation.days.find((day) => day.date === '2026-05-04')?.assignments[0].assignedEmployees[0]
    expect(mondayEmployee?.color).toEqual(followingMondayEmployee?.color)

    const aprilMonthDays = presentation.months[0].weeks.flat()
    expect(aprilMonthDays.find((day) => day.date === '2026-04-27')?.isScheduledWeek).toBe(true)
    expect(aprilMonthDays.find((day) => day.date === '2026-04-27')?.assignedEmployees.map((employee) => employee.id)).toEqual(['alex'])
    expect(presentation.hoursCostSummary).toMatchObject({
      averageLaborCostPerWeek: 172,
      averageScheduledHoursPerWeek: 8,
      totalLaborCost: 344,
      totalScheduledHours: 16,
    })
    expect(presentation.hoursCostSummary.employees[0]).toMatchObject({
      averageHoursPerWeek: 6,
      averageLaborCostPerWeek: 132,
      employee: { id: 'alex' },
      totalLaborCost: 264,
      totalScheduledHours: 12,
    })
    expect(presentation.hoursCostSummary.employees[0]?.weeks).toEqual([
      {
        laborCost: 176,
        scheduledHours: 8,
        weekEndDate: '2026-05-02',
        weekLabel: 'Apr 26 - May 2',
        weekStartDate: '2026-04-26',
      },
      {
        laborCost: 88,
        scheduledHours: 4,
        weekEndDate: '2026-05-09',
        weekLabel: 'May 3 - May 9',
        weekStartDate: '2026-05-03',
      },
    ])
    expect(presentation.hoursSummary.averageScheduledHoursPerWeek).toBe(8)
    expect(presentation.hoursSummary.topEmployees[0]).toMatchObject({ averageHoursPerWeek: 6, employee: { id: 'alex' } })
    expect(presentation.hoursSummary.bottomEmployees[0]).toMatchObject({ averageHoursPerWeek: 2, employee: { id: 'bri' } })
  })

  it('counts overnight shifts as positive scheduled hours in the presenter summary', () => {
    const presentation = buildSchedulingCandidatePresentation({
      candidateId: 13,
      normalizedInput: {
        employees: [
          {
            availability: [
              { dayOfWeek: 'friday', endTime: '23:59', startTime: '00:00' },
            ],
            hourlyRate: 20,
            id: 'night-owl',
            maxMinutesPerWeek: 2_100,
            name: 'Night Owl',
            preferredDays: ['friday'],
            preferredMinutesPerWeek: 1_800,
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
      },
      runId: 78,
      schedule: {
        assignments: [
          { date: '2026-05-08', employeeIds: ['night-owl'], shiftRequirementId: 'pm-shift' },
        ],
        candidateCode: 'overnight',
        coverageWarnings: [],
        label: 'Overnight',
        metrics: {
          coverageWarningCount: 0,
          fairnessScore: 100,
          overtimeAssignmentCount: 0,
          preferenceScore: 100,
          totalAssignedMinutes: 450,
          totalLaborCost: 150,
        },
        summary: 'Single overnight shift.',
      },
    })

    expect(presentation.days.find((day) => day.date === '2026-05-08')?.assignments[0]?.timeLabel).toBe('5:30 PM - 1:00 AM')
    expect(presentation.hoursCostSummary).toMatchObject({
      averageLaborCostPerWeek: 150,
      averageScheduledHoursPerWeek: 7.5,
      totalLaborCost: 150,
      totalScheduledHours: 7.5,
    })
    expect(presentation.hoursSummary.averageScheduledHoursPerWeek).toBe(7.5)
    expect(presentation.hoursSummary.topEmployees[0]).toMatchObject({ averageHoursPerWeek: 7.5, employee: { id: 'night-owl' } })
    expect(presentation.hoursSummary.bottomEmployees[0]).toMatchObject({ averageHoursPerWeek: 7.5, employee: { id: 'night-owl' } })
  })

  it('does not double-count overlapping continuity-linked assignments in hours, labor, or summary text', () => {
    const schedule = {
      assignments: [
        { date: '2026-05-06', employeeIds: ['jackie'], shiftRequirementId: 'inventory-am' },
        { date: '2026-05-06', employeeIds: ['jackie'], shiftRequirementId: 'qb-am' },
        { date: '2026-05-06', employeeIds: ['jackie'], shiftRequirementId: 'inventory-pm' },
        { date: '2026-05-06', employeeIds: ['jackie'], shiftRequirementId: 'qb-pm' },
      ],
      candidateCode: 'overlap-safe',
      coverageWarnings: [],
      label: 'Overlap-safe coverage',
      metrics: {
        coverageWarningCount: 0,
        fairnessScore: 100,
        overtimeAssignmentCount: 0,
        preferenceScore: 100,
        totalAssignedMinutes: 840,
        totalLaborCost: 294,
      },
      summary: 'Old summary placeholder.',
    } satisfies Parameters<typeof buildSchedulingCandidatePresentation>[0]['schedule']

    const presentation = buildSchedulingCandidatePresentation({
      candidateId: 15,
      normalizedInput: {
        employees: [
          {
            availability: [{ dayOfWeek: 'wednesday', endTime: '23:59', startTime: '00:00' }],
            hourlyRate: 21,
            id: 'jackie',
            maxMinutesPerWeek: 2_100,
            name: 'Jackie',
            preferredDays: ['wednesday'],
            preferredMinutesPerWeek: 1_800,
            preferredShiftTags: ['AM', 'PM'],
            qualifications: ['inventory', 'qb'],
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
            continuityGroup: 'am-open',
            dayOfWeek: 'wednesday',
            disallowedEmployeeIds: [],
            endTime: '17:00',
            id: 'inventory-am',
            label: 'AM shift inventory',
            requiredHeadcount: 1,
            requiredQualifications: ['inventory'],
            roleLabel: null,
            startTime: '10:00',
            tags: ['AM'],
          },
          {
            allowedEmployeeIds: [],
            continuityGroup: 'am-open',
            dayOfWeek: 'wednesday',
            disallowedEmployeeIds: [],
            endTime: '17:00',
            id: 'qb-am',
            label: 'QB',
            requiredHeadcount: 1,
            requiredQualifications: ['qb'],
            roleLabel: null,
            startTime: '10:00',
            tags: ['passive', 'AM'],
          },
          {
            allowedEmployeeIds: [],
            continuityGroup: 'pm-close',
            dayOfWeek: 'wednesday',
            disallowedEmployeeIds: [],
            endTime: '00:00',
            id: 'inventory-pm',
            label: 'PM shift inventory',
            requiredHeadcount: 1,
            requiredQualifications: ['inventory'],
            roleLabel: null,
            startTime: '17:00',
            tags: ['PM'],
          },
          {
            allowedEmployeeIds: [],
            continuityGroup: 'pm-close',
            dayOfWeek: 'wednesday',
            disallowedEmployeeIds: [],
            endTime: '00:00',
            id: 'qb-pm',
            label: 'QB',
            requiredHeadcount: 1,
            requiredQualifications: ['qb'],
            roleLabel: null,
            startTime: '17:00',
            tags: ['passive', 'PM'],
          },
        ],
        unknownEntities: [],
        weekDefinition: {
          endsOn: 'saturday',
          startsOn: 'sunday',
        },
      },
      runId: 79,
      schedule,
    })

    expect(presentation.hoursCostSummary).toMatchObject({
      averageLaborCostPerWeek: 294,
      averageScheduledHoursPerWeek: 14,
      totalLaborCost: 294,
      totalScheduledHours: 14,
    })
    expect(presentation.hoursCostSummary.employees[0]).toMatchObject({
      averageHoursPerWeek: 14,
      averageLaborCostPerWeek: 294,
      totalLaborCost: 294,
      totalScheduledHours: 14,
    })
    expect(buildSchedulingCandidateSummaryText({ presentation, schedule })).toContain('14.0h/week (14.0h total) scheduled')
    expect(buildSchedulingCandidateSummaryText({ presentation, schedule })).toContain('$294.00/week ($294.00 total) payroll')
  })

  it('exports review-friendly CSV rows for each scheduled shift occurrence', () => {
    const presentation = buildSchedulingCandidatePresentation({
      candidateId: 14,
      normalizedInput: {
        employees: [
          {
            availability: [{ dayOfWeek: 'monday', endTime: '18:00', startTime: '09:00' }],
            hourlyRate: 22,
            id: 'alex',
            maxMinutesPerWeek: 2_100,
            name: 'Alex',
            preferredDays: [],
            preferredMinutesPerWeek: 1_920,
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
            continuityGroup: null,
            dayOfWeek: 'monday',
            disallowedEmployeeIds: [],
            endTime: '13:00',
            id: 'mon-am',
            label: 'AM shift',
            requiredHeadcount: 2,
            requiredQualifications: [],
            roleLabel: 'Sales floor',
            startTime: '09:00',
            tags: ['am', 'register'],
          },
        ],
        unknownEntities: [],
        weekDefinition: {
          endsOn: 'saturday',
          startsOn: 'sunday',
        },
      },
      runId: 19,
      schedule: {
        assignments: [
          { date: '2026-05-04', employeeIds: ['alex'], shiftRequirementId: 'mon-am' },
        ],
        candidateCode: 'csv',
        coverageWarnings: [],
        label: 'AM coverage',
        metrics: {
          coverageWarningCount: 0,
          fairnessScore: 100,
          overtimeAssignmentCount: 0,
          preferenceScore: 100,
          totalAssignedMinutes: 240,
          totalLaborCost: 88,
        },
        summary: 'Single AM shift for CSV export.',
      },
    })

    const csv = buildSchedulingCandidateCsv({
      candidateId: 61,
      candidateLabel: 'AM coverage',
      candidateSummary: 'Single AM shift for CSV export.',
      presentation,
      runId: 19,
      scheduleWeek: {
        endDate: '2026-05-09',
        startDate: '2026-05-03',
      },
    })

    expect(csv).toContain('runId,candidateId,candidateLabel,candidateSummary,scheduleWindowStart,scheduleWindowEnd,shiftDate,shiftDay,shiftLabel,roleLabel,timeLabel,shiftTags,requiredHeadcount,assignedSeatCount,unfilledSeatCount,assignedEmployeeNames,assignedEmployeeIds')
    expect(csv).toContain('19,61,AM coverage,Single AM shift for CSV export.,2026-05-03,2026-05-09,2026-05-04')
    expect(csv).toContain('AM shift,Sales floor,9:00 AM - 1:00 PM,am; register,2,1,1,Alex,alex')
  })
})
