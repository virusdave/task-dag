import { describe, expect, it } from 'vitest'

import { LLMExtractedConstraintsSchema } from '../../shared/contracts/index.js'
import { __test__ } from './extractConstraints.js'

describe('parseJsonObject', () => {
  it('repairs raw newlines inside JSON strings before parsing', () => {
    const parsed = __test__.parseJsonObject('{"employees":[],"shiftRequirements":[],"scheduleWeek":{"startDate":"2026-05-03","endDate":"2026-05-09"},"notes":["Line one\nLine two"]}')

    expect(parsed).toEqual({
      employees: [],
      notes: ['Line one\nLine two'],
      scheduleWeek: {
        endDate: '2026-05-09',
        startDate: '2026-05-03',
      },
      shiftRequirements: [],
    })
  })

  it('derives hard qualifications from constrained role segments during normalization', () => {
    const normalized = __test__.normalizeExtractedConstraints({
      employees: [
        {
          availability: [{ dayOfWeek: 'monday', endTime: '14:00', startTime: '09:45' }],
          hourlyRate: 20,
          maxHoursPerWeek: 32,
          name: 'Alice',
          preferredDays: [],
          preferredHoursPerWeek: null,
          preferredShiftTags: [],
          qualifications: [],
        },
        {
          availability: [{ dayOfWeek: 'monday', endTime: '14:00', startTime: '09:45' }],
          hourlyRate: 20,
          maxHoursPerWeek: 32,
          name: 'Zaira',
          preferredDays: [],
          preferredHoursPerWeek: null,
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
      shiftRequirements: [
        {
          allowedEmployeeNames: ['Alice'],
          continuityGroup: 'am-opening-qb',
          dayOfWeek: 'monday',
          disallowedEmployeeNames: ['Zaira'],
          endTime: '10:15',
          label: 'QB needed to open',
          requiredHeadcount: 1,
          requiredQualifications: [],
          roleLabel: 'QB',
          startTime: '09:45',
          tags: ['opening'],
        },
      ],
      unknownEntities: [],
      weekDefinition: {
        endsOn: 'saturday',
        startsOn: 'sunday',
      },
    })

    expect(normalized.employees.find((employee) => employee.id === 'alice')?.qualifications).toEqual(['qb'])
    expect(normalized.employees.find((employee) => employee.id === 'zaira')?.qualifications).toEqual([])
    expect(normalized.shiftRequirements[0]?.requiredQualifications).toEqual(['qb'])
    expect(normalized.shiftRequirements[0]?.continuityGroup).toBe('am-opening-qb')
  })

  it('derives implicit continuity groups for passive qualified overlays that touch a main shift', () => {
    const normalized = __test__.normalizeExtractedConstraints({
      employees: [
        {
          availability: [{ dayOfWeek: 'monday', endTime: '14:00', startTime: '09:45' }],
          hourlyRate: 20,
          maxHoursPerWeek: 32,
          name: 'Alice',
          preferredDays: [],
          preferredHoursPerWeek: null,
          preferredShiftTags: [],
          qualifications: ['QB'],
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
          allowedEmployeeNames: [],
          continuityGroup: null,
          dayOfWeek: 'monday',
          disallowedEmployeeNames: [],
          endTime: '10:15',
          label: 'QB passive opener',
          requiredHeadcount: 1,
          requiredQualifications: ['QB'],
          roleLabel: 'QB',
          startTime: '09:45',
          tags: ['passive'],
        },
        {
          allowedEmployeeNames: [],
          continuityGroup: null,
          dayOfWeek: 'monday',
          disallowedEmployeeNames: [],
          endTime: '14:00',
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

    expect(normalized.shiftRequirements[0]?.requiredQualifications).toEqual(['qb'])
    expect(normalized.shiftRequirements[0]?.continuityGroup).not.toBeNull()
    expect(normalized.shiftRequirements[0]?.continuityGroup).toBe(normalized.shiftRequirements[1]?.continuityGroup)
  })

  it('derives required qualifications from shift labels that match known employee qualifications', () => {
    const normalized = __test__.normalizeExtractedConstraints({
      employees: [
        {
          availability: [{ dayOfWeek: 'monday', endTime: '23:59', startTime: '00:00' }],
          hourlyRate: 20,
          maxHoursPerWeek: 32,
          name: 'Laurie',
          preferredDays: [],
          preferredHoursPerWeek: null,
          preferredShiftTags: [],
          qualifications: ['delivery', 'staff'],
        },
        {
          availability: [{ dayOfWeek: 'monday', endTime: '23:59', startTime: '00:00' }],
          hourlyRate: 20,
          maxHoursPerWeek: 32,
          name: 'Stephanie',
          preferredDays: [],
          preferredHoursPerWeek: null,
          preferredShiftTags: [],
          qualifications: ['inventory'],
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
          allowedEmployeeNames: [],
          continuityGroup: null,
          dayOfWeek: 'monday',
          disallowedEmployeeNames: [],
          endTime: '23:00',
          label: 'Delivery',
          requiredHeadcount: 1,
          requiredQualifications: [],
          roleLabel: null,
          startTime: '13:00',
          tags: [],
        },
        {
          allowedEmployeeNames: [],
          continuityGroup: null,
          dayOfWeek: 'monday',
          disallowedEmployeeNames: [],
          endTime: '17:00',
          label: 'AM shift inventory',
          requiredHeadcount: 1,
          requiredQualifications: [],
          roleLabel: null,
          startTime: '10:00',
          tags: [],
        },
      ],
      unknownEntities: [],
      weekDefinition: {
        endsOn: 'saturday',
        startsOn: 'sunday',
      },
    })

    expect(normalized.shiftRequirements[0]?.requiredQualifications).toEqual(['delivery'])
    expect(normalized.shiftRequirements[1]?.requiredQualifications).toEqual(['inventory'])
  })

  it('supplements missing shift requirements and roster qualifications from explicit source text before validation', () => {
    const sourceText = [
      'Store requirements; all hours are between 8am and 2am.',
      '',
      'Sunday through Thursday there are:',
      'AM shift staff 10-5',
      'AM shift inventory 10-5',
      'PM shift staff 5-12',
      'PM shift inventory 5-12',
      'Delivery 1-11',
      'QB [passive] 9:45-10:15, 4:45-5:30, 11:45-12:15',
      '',
      'Friday through Saturday there are:',
      'AM shift staff 10-5:30',
      'AM shift inventory 10-5:30',
      'PM shift staff 5:30-1',
      'PM shift inventory 5:30-1',
      'Delivery 1-11',
      'QB [passive] 9:45-10:15, 5:15-5:45, 12:45-1:15',
      '',
      'Employees:',
      'The following are Delivery and staff:',
      'Laurie, Devone, and Aaron.',
      '',
      'Aaron is also inventory.',
      '',
      'All remaining employees are both staff and inventory. They are: Kristal, Zaira.',
      '',
      'The availability for the staff is:',
      'Laurie: Every day all times',
    ].join('\n')

    const coerced = __test__.coerceSchedulingExtractionObject(
      {
        employees: [
          {
            availability: [{ dayOfWeek: 'Wed', endTime: '23:59', startTime: '00:00' }],
            hourlyRate: 20,
            maxHoursPerWeek: null,
            name: 'Laurie',
            preferredDays: [],
            preferredHoursPerWeek: null,
            preferredShiftTags: [],
            qualifications: [],
          },
          {
            availability: [{ dayOfWeek: 'Sun', endTime: '23:59', startTime: '00:00' }],
            hourlyRate: 20,
            maxHoursPerWeek: null,
            name: 'Aaron',
            preferredDays: ['Fri'],
            preferredHoursPerWeek: null,
            preferredShiftTags: [],
            qualifications: [],
          },
          {
            availability: [{ dayOfWeek: 'Thu', endTime: '23:59', startTime: '00:00' }],
            hourlyRate: 20,
            maxHoursPerWeek: null,
            name: 'Kristal',
            preferredDays: [],
            preferredHoursPerWeek: null,
            preferredShiftTags: [],
            qualifications: [],
          },
        ],
        notes: [],
        shiftRequirements: [],
      },
      {
        scheduleWeek: {
          endDate: '2026-05-09',
          startDate: '2026-05-03',
        },
        sourceText,
      },
    )

    const parsed = LLMExtractedConstraintsSchema.parse(coerced)
    const normalized = __test__.normalizeExtractedConstraints(parsed)

    expect(parsed.scheduleWeek).toEqual({
      endDate: '2026-05-09',
      startDate: '2026-05-03',
    })
    expect(parsed.employees.find((employee) => employee.name === 'Laurie')?.qualifications).toEqual(['delivery', 'staff'])
    expect(parsed.employees.find((employee) => employee.name === 'Aaron')?.qualifications).toEqual(['delivery', 'inventory', 'staff'])
    expect(parsed.employees.find((employee) => employee.name === 'Kristal')?.qualifications).toEqual(['inventory', 'staff'])
    expect(parsed.employees.find((employee) => employee.name === 'Laurie')?.availability[0]?.dayOfWeek).toBe('wednesday')
    expect(parsed.shiftRequirements).toHaveLength(56)
    expect(parsed.shiftRequirements.find((shift) => shift.dayOfWeek === 'sunday' && shift.label === 'Delivery')).toMatchObject({
      endTime: '23:00',
      startTime: '13:00',
      tags: [],
    })
    expect(parsed.shiftRequirements.find((shift) => shift.dayOfWeek === 'sunday' && shift.label === 'QB' && shift.startTime === '23:45')).toMatchObject({
      endTime: '00:15',
      tags: ['passive'],
    })
    expect(normalized.shiftRequirements.find((shift) => shift.dayOfWeek === 'sunday' && shift.label === 'Delivery')?.requiredQualifications).toEqual(['delivery'])
    expect(normalized.shiftRequirements.find((shift) => shift.dayOfWeek === 'sunday' && shift.label === 'AM shift inventory')?.requiredQualifications).toEqual(['inventory'])
    expect(normalized.shiftRequirements.find((shift) => shift.dayOfWeek === 'sunday' && shift.label === 'PM shift staff')?.requiredQualifications).toEqual(['staff'])
  })

  it('recovers recurring shifts from Sunday-through-Saturday headers and nearby AM/PM tag notes', () => {
    const sourceText = [
      'Store requirements; all hours are between 8am and 2am.',
      '',
      'Sunday through Saturday, 7 days per week:',
      'AM shift staff 10-5',
      'AM shift inventory 10-5',
      'QB [passive] 10-5',
      'The above shifts are all tagged "AM" shifts.',
      '',
      'PM shift staff 5-12',
      'PM shift inventory 5-12',
      'QB [passive] 5-12',
      'These shifts are all tagged "PM" shifts.',
      '',
      'Delivery 1-11',
      '',
      'Employees:',
      'Laurie is delivery and staff.',
      '',
      'The availability for the staff is:',
      'Laurie: Every day all times',
    ].join('\n')

    const coerced = __test__.coerceSchedulingExtractionObject(
      {
        employees: [
          {
            availability: [{ dayOfWeek: 'Sun', endTime: '23:59', startTime: '00:00' }],
            hourlyRate: 20,
            maxHoursPerWeek: null,
            name: 'Laurie',
            preferredDays: [],
            preferredHoursPerWeek: null,
            preferredShiftTags: [],
            qualifications: [],
          },
        ],
        notes: [],
        shiftRequirements: [],
      },
      {
        scheduleWeek: {
          endDate: '2026-05-16',
          startDate: '2026-05-03',
        },
        sourceText,
      },
    )

    const parsed = LLMExtractedConstraintsSchema.parse(coerced)

    expect(parsed.shiftRequirements).toHaveLength(49)
    expect(parsed.shiftRequirements.find((shift) => shift.dayOfWeek === 'sunday' && shift.label === 'AM shift staff')).toMatchObject({
      endTime: '17:00',
      startTime: '10:00',
      tags: ['AM'],
    })
    expect(parsed.shiftRequirements.find((shift) => shift.dayOfWeek === 'sunday' && shift.label === 'QB' && shift.startTime === '10:00')).toMatchObject({
      endTime: '17:00',
      tags: ['passive', 'AM'],
    })
    expect(parsed.shiftRequirements.find((shift) => shift.dayOfWeek === 'sunday' && shift.label === 'PM shift inventory')).toMatchObject({
      endTime: '00:00',
      startTime: '17:00',
      tags: ['PM'],
    })
    expect(parsed.shiftRequirements.find((shift) => shift.dayOfWeek === 'sunday' && shift.label === 'Delivery')).toMatchObject({
      endTime: '23:00',
      startTime: '13:00',
      tags: [],
    })
  })

  it('normalizes common human time strings before extraction schema validation', () => {
    const coerced = __test__.coerceSchedulingExtractionObject(
      {
        employees: [
          {
            availability: [{ dayOfWeek: 'Wed', endTime: '5pm', startTime: '9am' }],
            hourlyRate: 20,
            maxHoursPerWeek: null,
            name: 'Stephanie',
            preferredDays: ['Thu'],
            preferredHoursPerWeek: null,
            preferredShiftTags: [],
            qualifications: ['QB'],
          },
        ],
        shiftRequirements: [
          {
            allowedEmployeeNames: [],
            continuityGroup: null,
            dayOfWeek: 'Fri',
            disallowedEmployeeNames: [],
            endTime: '1pm',
            label: 'Delivery',
            requiredHeadcount: 1,
            requiredQualifications: [],
            roleLabel: null,
            startTime: 'noon',
            tags: [],
          },
        ],
      },
      {
        scheduleWeek: {
          endDate: '2026-05-09',
          startDate: '2026-05-03',
        },
        sourceText: 'Employees:\nStephanie is QB.\n\nThe availability for the staff is:\nStephanie: Wed & Thu until 5pm',
      },
    )

    const parsed = LLMExtractedConstraintsSchema.parse(coerced)

    expect(parsed.employees[0]?.availability[0]).toEqual({
      dayOfWeek: 'wednesday',
      endTime: '17:00',
      startTime: '09:00',
    })
    expect(parsed.employees[0]?.preferredDays).toEqual(['thursday'])
    expect(parsed.shiftRequirements[0]).toMatchObject({
      dayOfWeek: 'friday',
      endTime: '13:00',
      startTime: '12:00',
    })
  })

  it('normalizes common availability phrases before extraction schema validation', () => {
    const coerced = __test__.coerceSchedulingExtractionObject(
      {
        employees: [
          {
            availability: [
              { dayOfWeek: 'Mon', endTime: 'all times', startTime: 'all times' },
              { dayOfWeek: 'Tue', endTime: 'close', startTime: '5pm' },
              { dayOfWeek: 'Wed', endTime: 'any time', startTime: 'open' },
            ],
            hourlyRate: 20,
            maxHoursPerWeek: null,
            name: 'Kristal',
            preferredDays: [],
            preferredHoursPerWeek: null,
            preferredShiftTags: [],
            qualifications: ['staff'],
          },
        ],
        shiftRequirements: [],
      },
      {
        scheduleWeek: {
          endDate: '2026-06-06',
          startDate: '2026-05-03',
        },
        sourceText: 'The availability for the staff is:\nKristal: Every day 5pm to close',
      },
    )

    const parsed = LLMExtractedConstraintsSchema.parse(coerced)

    expect(parsed.employees[0]?.availability).toEqual([
      { dayOfWeek: 'monday', endTime: '23:59', startTime: '00:00' },
      { dayOfWeek: 'tuesday', endTime: '23:59', startTime: '17:00' },
      { dayOfWeek: 'wednesday', endTime: '23:59', startTime: '00:00' },
    ])
  })

  it('coerces 24:00 availability bounds into schema-valid same-day times', () => {
    const coerced = __test__.coerceSchedulingExtractionObject(
      {
        employees: [
          {
            availability: [
              { dayOfWeek: 'Sun', endTime: '24:00', startTime: '00:00' },
              { dayOfWeek: 'Mon', endTime: '24', startTime: '24:00' },
            ],
            hourlyRate: 20,
            maxHoursPerWeek: null,
            name: 'David',
            preferredDays: [],
            preferredHoursPerWeek: 0,
            preferredShiftTags: [],
            qualifications: ['QB', 'delivery', 'inventory', 'staff'],
          },
        ],
        shiftRequirements: [],
      },
      {
        scheduleWeek: {
          endDate: '2026-05-30',
          startDate: '2026-05-03',
        },
        sourceText: 'The availability for the staff is:\nDavid: Every day all times',
      },
    )

    const parsed = LLMExtractedConstraintsSchema.parse(coerced)

    expect(parsed.employees[0]?.availability).toEqual([
      { dayOfWeek: 'sunday', endTime: '23:59', startTime: '00:00' },
      { dayOfWeek: 'monday', endTime: '23:59', startTime: '00:00' },
    ])
  })

  it('keeps repair prompts in alternating user and assistant order after the system message', () => {
    const messages = __test__.buildRepairMessages({
      invalidJson: '{"employees":[]}',
      originalMessages: [
        { content: 'original system prompt', role: 'system' },
        { content: 'original user prompt', role: 'user' },
      ],
      parseError: 'shiftRequirements: Invalid input: expected array, received undefined',
    })

    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
  })
})
