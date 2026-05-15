import { z } from 'zod'

function arrayInput(value: unknown): unknown {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

function singletonFriendlyArray<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.preprocess(arrayInput, z.array(itemSchema))
}

export const SchedulingRunStatusSchema = z.enum(['queued', 'extracting', 'needs_review', 'generating', 'ready', 'failed'])
export type SchedulingRunStatus = z.infer<typeof SchedulingRunStatusSchema>

export const SchedulingWeekdaySchema = z.enum([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
])
export type SchedulingWeekday = z.infer<typeof SchedulingWeekdaySchema>

export const DEFAULT_SCHEDULING_CANDIDATE_COUNT = 5
export const MAX_SCHEDULING_CANDIDATE_COUNT = 12
export const MAX_SCHEDULING_WINDOW_WEEKS = 12

export const SchedulingWeekWindowSchema = z.object({
  endDate: z.iso.date(),
  startDate: z.iso.date(),
}).superRefine((value, context) => {
  const startDate = new Date(`${value.startDate}T00:00:00Z`)
  const endDate = new Date(`${value.endDate}T00:00:00Z`)
  const differenceInDays = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000))
  const weekCount = differenceInDays >= 0 ? Math.floor((differenceInDays + 1) / 7) : 0

  if (startDate.getUTCDay() !== 0) {
    context.addIssue({
      code: 'custom',
      message: 'Scheduling week must start on Sunday.',
      path: ['startDate'],
    })
  }

  if (endDate.getUTCDay() !== 6) {
    context.addIssue({
      code: 'custom',
      message: 'Scheduling window must end on Saturday.',
      path: ['endDate'],
    })
  }

  if (differenceInDays < 6 || (differenceInDays + 1) % 7 !== 0) {
    context.addIssue({
      code: 'custom',
      message: 'Scheduling window must cover one or more full Sunday-through-Saturday weeks.',
      path: ['endDate'],
    })
  }

  if (weekCount > MAX_SCHEDULING_WINDOW_WEEKS) {
    context.addIssue({
      code: 'custom',
      message: `Scheduling window cannot exceed ${MAX_SCHEDULING_WINDOW_WEEKS} weeks.`,
      path: ['endDate'],
    })
  }
})
export type SchedulingWeekWindow = z.infer<typeof SchedulingWeekWindowSchema>

export const SchedulingWeekDefinitionSchema = z.object({
  endsOn: z.literal('saturday'),
  startsOn: z.literal('sunday'),
})
export type SchedulingWeekDefinition = z.infer<typeof SchedulingWeekDefinitionSchema>

export const DEFAULT_SCHEDULING_WEEK_DEFINITION: SchedulingWeekDefinition = {
  endsOn: 'saturday',
  startsOn: 'sunday',
}

export const DEFAULT_UNSPECIFIED_WEEKLY_PREFERRED_HOURS = 32
export const DEFAULT_UNSPECIFIED_WEEKLY_MAX_HOURS = 35
export const DEFAULT_UNSPECIFIED_WEEKLY_PREFERRED_MINUTES = DEFAULT_UNSPECIFIED_WEEKLY_PREFERRED_HOURS * 60
export const DEFAULT_UNSPECIFIED_WEEKLY_MAX_MINUTES = DEFAULT_UNSPECIFIED_WEEKLY_MAX_HOURS * 60

export const SchedulingCandidateCountSchema = z.number().int().min(1).max(MAX_SCHEDULING_CANDIDATE_COUNT)
export type SchedulingCandidateCount = z.infer<typeof SchedulingCandidateCountSchema>

export const SchedulingTimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export type SchedulingTimeOfDay = z.infer<typeof SchedulingTimeOfDaySchema>

export const SchedulingValidationIssueSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  severity: z.enum(['warning', 'error']),
})
export type SchedulingValidationIssue = z.infer<typeof SchedulingValidationIssueSchema>

export const SchedulingAvailabilityWindowSchema = z.object({
  dayOfWeek: SchedulingWeekdaySchema,
  endTime: SchedulingTimeOfDaySchema,
  startTime: SchedulingTimeOfDaySchema,
})
export type SchedulingAvailabilityWindow = z.infer<typeof SchedulingAvailabilityWindowSchema>

export const SchedulingQualificationSchema = z.string().trim().min(1)
export type SchedulingQualification = z.infer<typeof SchedulingQualificationSchema>

export const SchedulingExtractedEmployeeSchema = z.object({
  availability: singletonFriendlyArray(SchedulingAvailabilityWindowSchema),
  hourlyRate: z.number().finite().nonnegative(),
  maxHoursPerWeek: z.number().finite().positive().nullable().default(null),
  name: z.string().trim().min(1),
  preferredDays: singletonFriendlyArray(SchedulingWeekdaySchema).default([]),
  preferredHoursPerWeek: z.number().finite().nonnegative().nullable().default(null),
  preferredShiftTags: singletonFriendlyArray(z.string().trim().min(1)).default([]),
  qualifications: singletonFriendlyArray(SchedulingQualificationSchema).default([]),
})
export type SchedulingExtractedEmployee = z.infer<typeof SchedulingExtractedEmployeeSchema>

export const SchedulingExtractedShiftRequirementSchema = z.object({
  allowedEmployeeNames: singletonFriendlyArray(z.string().trim().min(1)).default([]),
  continuityGroup: z.string().trim().min(1).nullable().default(null),
  dayOfWeek: SchedulingWeekdaySchema,
  disallowedEmployeeNames: singletonFriendlyArray(z.string().trim().min(1)).default([]),
  endTime: SchedulingTimeOfDaySchema,
  label: z.string().trim().min(1),
  requiredHeadcount: z.number().int().positive(),
  requiredQualifications: singletonFriendlyArray(SchedulingQualificationSchema).default([]),
  roleLabel: z.string().trim().min(1).nullable().default(null),
  startTime: SchedulingTimeOfDaySchema,
  tags: singletonFriendlyArray(z.string().trim().min(1)).default([]),
})
export type SchedulingExtractedShiftRequirement = z.infer<typeof SchedulingExtractedShiftRequirementSchema>

export const LLMExtractedConstraintsSchema = z.object({
  employees: singletonFriendlyArray(SchedulingExtractedEmployeeSchema),
  issues: singletonFriendlyArray(SchedulingValidationIssueSchema).default([]),
  notes: singletonFriendlyArray(z.string().trim().min(1)).default([]),
  scheduleWeek: SchedulingWeekWindowSchema,
  shiftRequirements: singletonFriendlyArray(SchedulingExtractedShiftRequirementSchema),
  unknownEntities: singletonFriendlyArray(z.string().trim().min(1)).default([]),
  weekDefinition: SchedulingWeekDefinitionSchema.default(DEFAULT_SCHEDULING_WEEK_DEFINITION),
})
export type LLMExtractedConstraints = z.infer<typeof LLMExtractedConstraintsSchema>

export const SchedulingEmployeeSchema = z.object({
  availability: singletonFriendlyArray(SchedulingAvailabilityWindowSchema),
  hourlyRate: z.number().finite().nonnegative(),
  id: z.string().trim().min(1),
  maxMinutesPerWeek: z.number().int().positive().nullable().default(null),
  name: z.string().trim().min(1),
  preferredDays: singletonFriendlyArray(SchedulingWeekdaySchema).default([]),
  preferredMinutesPerWeek: z.number().int().min(0).nullable().default(null),
  preferredShiftTags: singletonFriendlyArray(z.string().trim().min(1)).default([]),
  qualifications: singletonFriendlyArray(SchedulingQualificationSchema).default([]),
})
export type SchedulingEmployee = z.infer<typeof SchedulingEmployeeSchema>

export const SchedulingShiftRequirementSchema = z.object({
  allowedEmployeeIds: singletonFriendlyArray(z.string().trim().min(1)).default([]),
  continuityGroup: z.string().trim().min(1).nullable().default(null),
  dayOfWeek: SchedulingWeekdaySchema,
  disallowedEmployeeIds: singletonFriendlyArray(z.string().trim().min(1)).default([]),
  endTime: SchedulingTimeOfDaySchema,
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  requiredHeadcount: z.number().int().positive(),
  requiredQualifications: singletonFriendlyArray(SchedulingQualificationSchema).default([]),
  roleLabel: z.string().trim().min(1).nullable(),
  startTime: SchedulingTimeOfDaySchema,
  tags: singletonFriendlyArray(z.string().trim().min(1)).default([]),
})
export type SchedulingShiftRequirement = z.infer<typeof SchedulingShiftRequirementSchema>

export const NormalizedSolverInputSchema = z.object({
  employees: singletonFriendlyArray(SchedulingEmployeeSchema),
  issues: singletonFriendlyArray(SchedulingValidationIssueSchema).default([]),
  notes: singletonFriendlyArray(z.string().trim().min(1)).default([]),
  scheduleWeek: SchedulingWeekWindowSchema,
  shiftRequirements: singletonFriendlyArray(SchedulingShiftRequirementSchema),
  unknownEntities: singletonFriendlyArray(z.string().trim().min(1)).default([]),
  weekDefinition: SchedulingWeekDefinitionSchema.default(DEFAULT_SCHEDULING_WEEK_DEFINITION),
})
export type NormalizedSolverInput = z.infer<typeof NormalizedSolverInputSchema>

export function applySchedulingWeeklyHoursPolicy(input: NormalizedSolverInput): NormalizedSolverInput {
  return NormalizedSolverInputSchema.parse({
    ...input,
    employees: input.employees.map((employee) => {
      if (employee.maxMinutesPerWeek !== null) {
        return employee
      }

      return {
        ...employee,
        maxMinutesPerWeek: DEFAULT_UNSPECIFIED_WEEKLY_MAX_MINUTES,
        preferredMinutesPerWeek: employee.preferredMinutesPerWeek === null
          ? DEFAULT_UNSPECIFIED_WEEKLY_PREFERRED_MINUTES
          : employee.preferredMinutesPerWeek,
      }
    }),
  })
}

export const SchedulingCoverageWarningSchema = z.object({
  date: z.iso.date().optional(),
  message: z.string().trim().min(1),
  shiftRequirementId: z.string().trim().min(1),
})
export type SchedulingCoverageWarning = z.infer<typeof SchedulingCoverageWarningSchema>

export const ScheduleAssignmentSchema = z.object({
  date: z.iso.date().optional(),
  employeeIds: singletonFriendlyArray(z.string().trim().min(1)),
  shiftRequirementId: z.string().trim().min(1),
})
export type ScheduleAssignment = z.infer<typeof ScheduleAssignmentSchema>

export const ScheduleCandidateMetricsSchema = z.object({
  coverageWarningCount: z.number().int().min(0),
  fairnessScore: z.number().finite().min(0).max(100),
  overtimeAssignmentCount: z.number().int().min(0),
  preferenceScore: z.number().finite().min(0).max(100),
  totalAssignedMinutes: z.number().int().min(0),
  totalLaborCost: z.number().finite().min(0),
})
export type ScheduleCandidateMetrics = z.infer<typeof ScheduleCandidateMetricsSchema>

export const ScheduleCandidateSchema = z.object({
  assignments: singletonFriendlyArray(ScheduleAssignmentSchema),
  candidateCode: z.string().trim().min(1),
  coverageWarnings: singletonFriendlyArray(SchedulingCoverageWarningSchema),
  label: z.string().trim().min(1),
  metrics: ScheduleCandidateMetricsSchema,
  summary: z.string().trim().min(1),
})
export type ScheduleCandidate = z.infer<typeof ScheduleCandidateSchema>

export const SchedulingExtractConstraintsJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  schedulingRunId: z.number().int().positive(),
})
export type SchedulingExtractConstraintsJobPayload = z.infer<typeof SchedulingExtractConstraintsJobPayloadSchema>

export const SchedulingGenerateCandidatesJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  schedulingRunId: z.number().int().positive(),
})
export type SchedulingGenerateCandidatesJobPayload = z.infer<typeof SchedulingGenerateCandidatesJobPayloadSchema>

export function countSchedulingWeeks(scheduleWeek: SchedulingWeekWindow): number {
  const startDate = new Date(`${scheduleWeek.startDate}T00:00:00Z`)
  const endDate = new Date(`${scheduleWeek.endDate}T00:00:00Z`)
  const differenceInDays = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000))
  return Math.floor((differenceInDays + 1) / 7)
}
