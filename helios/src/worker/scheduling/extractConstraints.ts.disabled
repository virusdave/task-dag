import {
  DEFAULT_UNSPECIFIED_WEEKLY_MAX_HOURS,
  DEFAULT_UNSPECIFIED_WEEKLY_PREFERRED_HOURS,
  DEFAULT_SCHEDULING_WEEK_DEFINITION,
  LLMExtractedConstraintsSchema,
  NormalizedSolverInputSchema,
  SchedulingAvailabilityWindowSchema,
  SchedulingWeekWindowSchema,
  applySchedulingWeeklyHoursPolicy,
  type LLMExtractedConstraints,
  type NormalizedSolverInput,
  type SchedulingValidationIssue,
  type SchedulingWeekWindow,
} from '../../shared/contracts/index.js'
import { ZodError, z } from 'zod'
import { getWorkerEnv } from '../config/env.js'
import { RetryableWorkerError } from '../runtime/errors.js'

const SCHEDULING_EXTRACTION_MODEL = 'google.gemma-3-27b-it'
const SCHEDULING_EXTRACTION_PROMPT_VERSION = 'scheduling-constraint-extraction-v4'

type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type SchedulingSourceSections = {
  availabilitySection: string
  employeeSection: string
  planningContextSection: string
  preferencesSection: string
}

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

const SchedulingAvailabilitySupplementSchema = z.object({
  employees: singletonFriendlyArray(z.object({
    availability: singletonFriendlyArray(SchedulingAvailabilityWindowSchema),
    name: z.string().trim().min(1),
  })).default([]),
})

export async function extractSchedulingConstraints(input: {
  scheduleWeek: SchedulingWeekWindow
  sourceText: string
}): Promise<{
  extractedConstraints: LLMExtractedConstraints
  model: string
  normalizedInput: NormalizedSolverInput
  promptVersion: string
  validationIssues: SchedulingValidationIssue[]
}> {
  const scheduleWeek = SchedulingWeekWindowSchema.parse(input.scheduleWeek)
  const sourceSections = buildSchedulingSourceSections(input.sourceText)
  let availabilitySupplementPromise: Promise<Map<string, z.infer<typeof SchedulingAvailabilityWindowSchema>[]>> | null = null
  const extractedConstraints = await requestMantleStructuredObject({
    coerceParsedObject: async (value) => {
      const employeeAvailabilityOverrides = shouldUseParagraphAvailabilitySupplement(value.employees, sourceSections.availabilitySection)
        ? await (availabilitySupplementPromise ??= extractEmployeeAvailabilitySupplements({
            employeeNames: extractEmployeeNamesFromParsedValue(value.employees),
            model: SCHEDULING_EXTRACTION_MODEL,
            scheduleWeek,
            sections: sourceSections,
          }))
        : null

      return coerceSchedulingExtractionObject(value, input, employeeAvailabilityOverrides)
    },
    maxTokens: 5200,
    messages: buildExtractionMessages({ scheduleWeek, sourceText: input.sourceText }),
    model: SCHEDULING_EXTRACTION_MODEL,
    schema: LLMExtractedConstraintsSchema,
    stage: 'Scheduling constraint extraction',
    temperature: 0.1,
  })
  const normalizedInput = normalizeExtractedConstraints(extractedConstraints)

  return {
    extractedConstraints,
    model: SCHEDULING_EXTRACTION_MODEL,
    normalizedInput,
    promptVersion: SCHEDULING_EXTRACTION_PROMPT_VERSION,
    validationIssues: normalizedInput.issues,
  }
}

function buildExtractionMessages(input: { scheduleWeek: SchedulingWeekWindow; sourceText: string }): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You translate employee scheduling instructions into structured JSON only.',
        'Do not solve the schedule.',
        'Do not invent unavailable employees, shifts, policies, or IDs.',
        'The operator-selected scheduling window always starts on Sunday and ends on Saturday, and any per-week preference or hours constraint must be measured separately inside each Sunday-through-Saturday week in that window.',
        'When information is missing or ambiguous, put the raw item into unknownEntities or issues instead of guessing.',
        'Return one compact JSON object. Do not pretty-print, do not include markdown fences, and avoid long string values.',
        'Top-level output must include employees, shiftRequirements, and scheduleWeek. Include notes, unknownEntities, issues, and weekDefinition only when they are needed.',
        'Each employee must include name, hourlyRate, maxHoursPerWeek, and availability. Include preferredHoursPerWeek, preferredDays, preferredShiftTags, and qualifications only when the source gives them.',
        'Each availability entry must include dayOfWeek, startTime, endTime using 24-hour HH:MM format.',
        'Each shift requirement must include label, dayOfWeek, startTime, endTime, and requiredHeadcount. Include roleLabel, tags, allowedEmployeeNames, disallowedEmployeeNames, requiredQualifications, and continuityGroup only when explicitly supported by the source.',
        'Use lowercase weekday names sunday through saturday.',
        'Use roleLabel null when no role is explicitly stated.',
        'Use qualifications and requiredQualifications for hard eligibility attributes such as QB; do not hide enforceable qualifications only inside preferredShiftTags.',
        'When the source says only specific people can cover a role or slot, put those names in allowedEmployeeNames on the relevant shift requirements.',
        'When the source says a named employee cannot cover a role or slot, put that name in disallowedEmployeeNames on the relevant shift requirements.',
        'When the source identifies who is or is not qualified for a role like QB, assign employee qualifications and add matching requiredQualifications on every affected shift segment.',
        'When a short opening or passive qualified requirement must continue into the adjacent segment, give every linked segment the same continuityGroup so the solver can keep the same qualified employee across the handoff.',
        'When weekly max hours are not stated, set maxHoursPerWeek to null and add a warning issue instead of guessing.',
        'Keep labels, notes, issue messages, and unknown-entity strings short. Never quote large source excerpts or include raw multi-line prose inside JSON strings.',
        'Unsupported date-specific exceptions can be summarized in notes or issues instead of being expanded into verbose prose inside string fields.',
        'issues entries must include code, message, severity where severity is warning or error.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        scheduleWeek: input.scheduleWeek,
        sourceText: input.sourceText,
        weekDefinition: DEFAULT_SCHEDULING_WEEK_DEFINITION,
      }, null, 2),
    },
  ]
}

function normalizeExtractedConstraints(extractedConstraints: LLMExtractedConstraints): NormalizedSolverInput {
  const issues: SchedulingValidationIssue[] = [...extractedConstraints.issues]

  if (extractedConstraints.employees.length === 0) {
    issues.push({
      code: 'no-employees-detected',
      message: 'The extraction did not find any employees. Review the source text and enter them manually before generating candidates.',
      severity: 'error',
    })
  }

  if (extractedConstraints.shiftRequirements.length === 0) {
    issues.push({
      code: 'no-shifts-detected',
      message: 'The extraction did not find any shift requirements. Review the source text and enter them manually before generating candidates.',
      severity: 'error',
    })
  }

  if (extractedConstraints.unknownEntities.length > 0) {
    issues.push({
      code: 'unknown-entities-present',
      message: 'Some names or policies could not be normalized automatically and should be reviewed before generating candidates.',
      severity: 'warning',
    })
  }

  const employeeIdCounts = new Map<string, number>()
  const shiftIdCounts = new Map<string, number>()
  const employeeQualificationsByName = buildEmployeeQualificationsByName(extractedConstraints.employees)
  const knownQualifications = buildKnownQualifications(extractedConstraints.employees)
  const derivedContinuityGroups = inferImplicitContinuityGroups(extractedConstraints.shiftRequirements, knownQualifications)

  for (const shiftRequirement of extractedConstraints.shiftRequirements) {
    const requiredQualifications = buildRequiredQualifications(shiftRequirement, knownQualifications)
    if (requiredQualifications.length === 0 || shiftRequirement.allowedEmployeeNames.length === 0) {
      continue
    }

    for (const employeeName of shiftRequirement.allowedEmployeeNames) {
      const normalizedName = normalizeEmployeeConstraintName(employeeName)
      const employeeQualifications = employeeQualificationsByName.get(normalizedName)
      if (!employeeQualifications) {
        continue
      }

      for (const qualification of requiredQualifications) {
        employeeQualifications.add(qualification)
      }
    }
  }

  const normalizedEmployees = extractedConstraints.employees.map((employee) => {
      const baseId = slugify(employee.name)
      const id = buildUniqueId(baseId, employeeIdCounts)

      if (employee.maxHoursPerWeek === null) {
        issues.push({
          code: 'employee-weekly-hours-defaulted',
          message: `${employee.name} did not specify weekly max hours, so Helios defaulted to preference ${DEFAULT_UNSPECIFIED_WEEKLY_PREFERRED_HOURS} and hard max ${DEFAULT_UNSPECIFIED_WEEKLY_MAX_HOURS}. Override those values only with explicit operator approval.`,
          severity: 'warning',
        })
      }

      return {
        availability: employee.availability,
        hourlyRate: employee.hourlyRate,
        id,
        maxMinutesPerWeek: employee.maxHoursPerWeek === null ? null : Math.max(60, Math.round(employee.maxHoursPerWeek * 60)),
        name: employee.name,
        preferredDays: employee.preferredDays,
        preferredMinutesPerWeek: employee.preferredHoursPerWeek === null ? null : Math.max(0, Math.round(employee.preferredHoursPerWeek * 60)),
        preferredShiftTags: employee.preferredShiftTags,
        qualifications: [...(employeeQualificationsByName.get(normalizeEmployeeConstraintName(employee.name)) ?? new Set<string>())].sort(),
      }
    })
  const employeeIdByName = buildEmployeeIdByName(normalizedEmployees, issues)

  const normalizedInput = NormalizedSolverInputSchema.parse({
    employees: normalizedEmployees,
    issues,
    notes: extractedConstraints.notes,
    scheduleWeek: extractedConstraints.scheduleWeek,
    shiftRequirements: extractedConstraints.shiftRequirements.map((shiftRequirement, shiftIndex) => {
      const baseId = slugify(`${shiftRequirement.label}-${shiftRequirement.dayOfWeek}-${shiftRequirement.startTime}`)
      const requiredQualifications = buildRequiredQualifications(shiftRequirement, knownQualifications)

      return {
        allowedEmployeeIds: resolveEmployeeConstraintIds({
          employeeIdByName,
          issues,
          names: shiftRequirement.allowedEmployeeNames,
          requiredQualifications,
          roleLabel: shiftRequirement.roleLabel,
          shiftLabel: shiftRequirement.label,
          type: 'allowed',
        }),
        continuityGroup: normalizeOptionalString(shiftRequirement.continuityGroup) ?? derivedContinuityGroups.get(shiftIndex) ?? null,
        dayOfWeek: shiftRequirement.dayOfWeek,
        disallowedEmployeeIds: resolveEmployeeConstraintIds({
          employeeIdByName,
          issues,
          names: shiftRequirement.disallowedEmployeeNames,
          requiredQualifications,
          roleLabel: shiftRequirement.roleLabel,
          shiftLabel: shiftRequirement.label,
          type: 'disallowed',
        }),
        endTime: shiftRequirement.endTime,
        id: buildUniqueId(baseId, shiftIdCounts),
        label: shiftRequirement.label,
        requiredHeadcount: shiftRequirement.requiredHeadcount,
        requiredQualifications,
        roleLabel: shiftRequirement.roleLabel,
        startTime: shiftRequirement.startTime,
        tags: shiftRequirement.tags,
      }
    }),
    unknownEntities: extractedConstraints.unknownEntities,
    weekDefinition: extractedConstraints.weekDefinition,
  })

  return applySchedulingWeeklyHoursPolicy(normalizedInput)
}

async function requestMantleStructuredObject<T>(input: {
  coerceParsedObject?: (value: Record<string, unknown>) => Promise<unknown> | unknown
  maxTokens: number
  messages: ChatMessage[]
  model: string
  schema: z.ZodType<T>
  stage: string
  temperature: number
}): Promise<T> {
  let attemptMessages = input.messages
  let finalError: Error | null = null

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await requestMantleJson({
      maxTokens: input.maxTokens + attempt * 600,
      messages: attemptMessages,
      model: input.model,
      temperature: attempt === 0 ? input.temperature : 0,
    })

    try {
      const parsedObject = parseJsonObject(response.assistantContent)
      return input.schema.parse(input.coerceParsedObject ? await input.coerceParsedObject(parsedObject) : parsedObject)
    } catch (error) {
      finalError = error instanceof Error ? error : new Error(`${input.stage} returned invalid structured output.`)
      attemptMessages = buildRepairMessages({
        invalidJson: response.assistantContent,
        originalMessages: input.messages,
        parseError: describeStructuredOutputError(finalError),
      })
    }
  }

  throw new Error(`${input.stage} could not be validated after repair attempts: ${describeStructuredOutputError(finalError)}`)
}

function buildRepairMessages(input: {
  invalidJson: string
  originalMessages: ChatMessage[]
  parseError: string
}): ChatMessage[] {
  const originalNonSystemMessages = input.originalMessages.filter((message) => message.role !== 'system')

  return [
    {
      role: 'system',
      content: [
        'You repair or regenerate employee scheduling extraction JSON.',
        'Return compact valid JSON only with no markdown, commentary, or pretty-printing.',
        'If the prior draft appears truncated or malformed, regenerate the full answer from the original request instead of copying broken text forward.',
        'If the prior draft is valid JSON but missing required fields or arrays, regenerate a schema-complete answer from the original request.',
        'Keep optional arrays and fields omitted when empty.',
      ].join(' '),
    },
    ...originalNonSystemMessages,
    { role: 'assistant', content: truncate(input.invalidJson, 12000) },
    {
      role: 'user',
      content: JSON.stringify({
        instruction: 'Repair the invalid scheduling extraction JSON or regenerate it compactly from the original request. Return valid JSON only.',
        parseError: input.parseError,
      }),
    },
  ]
}

function coerceSchedulingExtractionObject(
  value: Record<string, unknown>,
  input: { scheduleWeek: SchedulingWeekWindow; sourceText: string },
  employeeAvailabilityOverrides: Map<string, z.infer<typeof SchedulingAvailabilityWindowSchema>[]> | null = null,
): unknown {
  const sourceDerivedShiftRequirements = buildShiftRequirementsFromSource(input.sourceText)
  const employeeQualificationAssignments = buildEmployeeQualificationAssignments(input.sourceText)

  return {
    ...value,
    employees: coerceSchedulingEmployees(value.employees, employeeQualificationAssignments, employeeAvailabilityOverrides),
    scheduleWeek: input.scheduleWeek,
    shiftRequirements: coerceShiftRequirements(value.shiftRequirements, sourceDerivedShiftRequirements),
    weekDefinition: DEFAULT_SCHEDULING_WEEK_DEFINITION,
  }
}

function buildUniqueId(baseId: string, counts: Map<string, number>): string {
  const nextCount = (counts.get(baseId) ?? 0) + 1
  counts.set(baseId, nextCount)
  return nextCount === 1 ? baseId : `${baseId}-${nextCount}`
}

function coerceSchedulingEmployees(
  value: unknown,
  qualificationAssignments: Map<string, Set<string>>,
  employeeAvailabilityOverrides: Map<string, z.infer<typeof SchedulingAvailabilityWindowSchema>[]> | null,
): unknown {
  if (!Array.isArray(value)) {
    return value
  }

  return value.map((employee) => {
    if (!isRecord(employee)) {
      return employee
    }

    const name = typeof employee.name === 'string' ? employee.name : null
    const normalizedName = name ? normalizeEmployeeConstraintName(name) : null
    const qualificationSet = new Set<string>()

    for (const qualification of arrayOfStrings(employee.qualifications)) {
      const normalizedQualification = normalizeQualification(qualification)
      if (normalizedQualification) {
        qualificationSet.add(normalizedQualification)
      }
    }

    if (normalizedName) {
      for (const qualification of qualificationAssignments.get(normalizedName) ?? []) {
        qualificationSet.add(qualification)
      }
    }

    const availabilityOverride = normalizedName ? employeeAvailabilityOverrides?.get(normalizedName) : null

    return {
      ...employee,
      availability: availabilityOverride ?? coerceAvailabilityWindows(employee.availability),
      preferredDays: coerceWeekdayArray(employee.preferredDays),
      qualifications: [...qualificationSet].sort(),
    }
  })
}

async function extractEmployeeAvailabilitySupplements(input: {
  employeeNames: string[]
  model: string
  scheduleWeek: SchedulingWeekWindow
  sections: SchedulingSourceSections
}): Promise<Map<string, z.infer<typeof SchedulingAvailabilityWindowSchema>[]>> {
  if (input.sections.availabilitySection.length === 0 || input.employeeNames.length === 0) {
    return new Map()
  }

  const parsed = await requestMantleStructuredObject({
    coerceParsedObject: (value) => coerceSchedulingAvailabilitySupplementObject(value),
    maxTokens: 2200,
    messages: buildAvailabilityExtractionMessages(input),
    model: input.model,
    schema: SchedulingAvailabilitySupplementSchema,
    stage: 'Scheduling availability extraction',
    temperature: 0.1,
  })

  const employees = Array.isArray(parsed.employees) ? parsed.employees : []
  return new Map(
    employees
      .filter((employee) => {
        if (typeof employee !== 'object' || !employee || !('availability' in employee)) {
          return false
        }
        const avail = employee.availability
        return Array.isArray(avail) && avail.length > 0
      })
      .map((employee) => {
        const emp = employee as Record<string, unknown>
        const name = typeof emp.name === 'string' ? emp.name : ''
        const availability = Array.isArray(emp.availability) ? emp.availability : []
        return [normalizeEmployeeConstraintName(name), availability] as const
      }),
  )
}

function buildAvailabilityExtractionMessages(input: {
  employeeNames: string[]
  model: string
  scheduleWeek: SchedulingWeekWindow
  sections: SchedulingSourceSections
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You extract recurring weekly employee availability from one scheduling availability paragraph plus nearby context.',
        'Return compact JSON only in the shape {"employees":[{"name":"...","availability":[{"dayOfWeek":"monday","startTime":"09:00","endTime":"17:00"}]}]}.',
        'Only include employees whose recurring weekly availability can be represented in the JSON output.',
        'Use lowercase weekday names sunday through saturday and 24-hour HH:MM times.',
        'Interpret "all times" and "any time" as 00:00 through 23:59.',
        'Interpret "open" as 00:00 and "close" as 23:59.',
        'Interpret "until 5pm" as startTime 00:00 and endTime 17:00.',
        'Interpret "5pm to close" as startTime 17:00 and endTime 23:59.',
        'Expand weekday lists like "Tue, Thu, Sun" into separate availability entries.',
        'Ignore one-off date exceptions, training notes, and non-recurring constraints when they cannot be represented in the recurring weekly availability schema.',
        'Do not include markdown, explanations, notes, or unknownEntities.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        employeeContext: input.sections.employeeSection,
        employeeNames: input.employeeNames,
        planningContext: truncate(input.sections.planningContextSection, 4000),
        preferencesContext: truncate(input.sections.preferencesSection, 2000),
        recurringAvailabilityParagraph: input.sections.availabilitySection,
        scheduleWeek: input.scheduleWeek,
      }),
    },
  ]
}

function coerceSchedulingAvailabilitySupplementObject(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    employees: Array.isArray(value.employees)
      ? value.employees.map((employee) => {
          if (!isRecord(employee)) {
            return employee
          }

          return {
            ...employee,
            availability: coerceAvailabilityWindows(employee.availability),
          }
        })
      : value.employees,
  }
}

function buildSchedulingSourceSections(sourceText: string): SchedulingSourceSections {
  return {
    availabilitySection: extractSourceSection(
      sourceText,
      /The availability for the staff is:\s*([\s\S]*?)(?:\n\nThe preferences (?:of|for) the staff are:|$)/i,
    ),
    employeeSection: extractEmployeeSection(sourceText),
    planningContextSection: extractSourceSection(sourceText, /^([\s\S]*?)(?:\n\nEmployees:|$)/i),
    preferencesSection: extractSourceSection(sourceText, /The preferences (?:of|for) the staff are:\s*([\s\S]*?)$/i),
  }
}

function extractSourceSection(sourceText: string, pattern: RegExp): string {
  return sourceText.match(pattern)?.[1]?.trim() ?? ''
}

function shouldUseParagraphAvailabilitySupplement(value: unknown, availabilitySection: string): boolean {
  if (availabilitySection.length === 0 || !Array.isArray(value)) {
    return false
  }

  return value.some((employee) => {
    if (!isRecord(employee)) {
      return false
    }

    if (!Array.isArray(employee.availability) || employee.availability.length === 0) {
      return true
    }

    return employee.availability.some((window) => (
      !isRecord(window)
      || typeof normalizeWeekdayValue(window.dayOfWeek) !== 'string'
      || !isNormalizedTimeOfDayValue(normalizeAvailabilityTimeOfDayValue(window.startTime, 'start'))
      || !isNormalizedTimeOfDayValue(normalizeAvailabilityTimeOfDayValue(window.endTime, 'end'))
    ))
  })
}

function extractEmployeeNamesFromParsedValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter(isRecord)
    .map((employee) => (typeof employee.name === 'string' ? employee.name.trim() : ''))
    .filter((name) => name.length > 0)
}

function coerceShiftRequirements(value: unknown, sourceDerivedShiftRequirements: SourceDerivedShiftRequirement[]): unknown {
  if (!Array.isArray(value) || value.length === 0) {
    return sourceDerivedShiftRequirements
  }

  const normalizedRequirements = value.map((shiftRequirement) => {
    if (!isRecord(shiftRequirement)) {
      return shiftRequirement
    }

    return {
      ...shiftRequirement,
      allowedEmployeeNames: arrayOfStrings(shiftRequirement.allowedEmployeeNames),
      dayOfWeek: normalizeWeekdayValue(shiftRequirement.dayOfWeek),
      disallowedEmployeeNames: arrayOfStrings(shiftRequirement.disallowedEmployeeNames),
      endTime: normalizeTimeOfDayValue(shiftRequirement.endTime),
      requiredQualifications: arrayOfStrings(shiftRequirement.requiredQualifications),
      startTime: normalizeTimeOfDayValue(shiftRequirement.startTime),
      tags: arrayOfStrings(shiftRequirement.tags),
    }
  })

  const existingKeys = new Set(
    normalizedRequirements
      .filter(isRecord)
      .map((shiftRequirement) => buildShiftRequirementKey({
        dayOfWeek: typeof shiftRequirement.dayOfWeek === 'string' ? shiftRequirement.dayOfWeek : '',
        endTime: typeof shiftRequirement.endTime === 'string' ? shiftRequirement.endTime : '',
        label: typeof shiftRequirement.label === 'string' ? shiftRequirement.label : '',
        startTime: typeof shiftRequirement.startTime === 'string' ? shiftRequirement.startTime : '',
      })),
  )

  const missingRequirements = sourceDerivedShiftRequirements.filter(
    (shiftRequirement) => !existingKeys.has(buildShiftRequirementKey(shiftRequirement)),
  )

  return missingRequirements.length > 0 ? [...normalizedRequirements, ...missingRequirements] : normalizedRequirements
}

function coerceAvailabilityWindows(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value
  }

  return value.map((window) => {
    if (!isRecord(window)) {
      return window
    }

    return {
      ...window,
      dayOfWeek: normalizeWeekdayValue(window.dayOfWeek),
      endTime: normalizeAvailabilityTimeOfDayValue(window.endTime, 'end'),
      startTime: normalizeAvailabilityTimeOfDayValue(window.startTime, 'start'),
    }
  })
}

function coerceWeekdayArray(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value
  }

  return value
    .map((entry) => normalizeWeekdayValue(entry))
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

type SourceDerivedShiftRequirement = {
  allowedEmployeeNames: string[]
  continuityGroup: null
  dayOfWeek: string
  disallowedEmployeeNames: string[]
  endTime: string
  label: string
  requiredHeadcount: number
  requiredQualifications: string[]
  roleLabel: null
  startTime: string
  tags: string[]
}

const WEEKDAY_ORDER = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const

const WEEKDAY_ALIASES = new Map<string, (typeof WEEKDAY_ORDER)[number]>([
  ['sun', 'sunday'],
  ['sunday', 'sunday'],
  ['mon', 'monday'],
  ['monday', 'monday'],
  ['tue', 'tuesday'],
  ['tues', 'tuesday'],
  ['tuesday', 'tuesday'],
  ['wed', 'wednesday'],
  ['wednesday', 'wednesday'],
  ['thu', 'thursday'],
  ['thur', 'thursday'],
  ['thurs', 'thursday'],
  ['thursday', 'thursday'],
  ['fri', 'friday'],
  ['friday', 'friday'],
  ['sat', 'saturday'],
  ['saturday', 'saturday'],
])

const KNOWN_SOURCE_QUALIFICATIONS = ['qb', 'delivery', 'inventory', 'staff']

function buildEmployeeQualificationAssignments(sourceText: string): Map<string, Set<string>> {
  const assignments = new Map<string, Set<string>>()
  const employeeSection = extractEmployeeSection(sourceText)
  if (!employeeSection) {
    return assignments
  }

  addQualificationAssignmentsFromMatches(
    assignments,
    employeeSection,
    /The following are\s+([^:\n]+):\s*([^\.]+)\./gi,
    1,
    2,
  )
  addQualificationAssignmentsFromMatches(
    assignments,
    employeeSection,
    /All remaining employees are\s+([^\.]+)\.\s*They are:\s*([^\.]+)\./gi,
    1,
    2,
  )
  addQualificationAssignmentsFromMatches(
    assignments,
    employeeSection,
    /([A-Z][a-z]+(?:\s+and\s+[A-Z][a-z]+)+)\s+are\s+([^\.]+)\./g,
    2,
    1,
  )
  addQualificationAssignmentsFromMatches(
    assignments,
    employeeSection,
    /\b([A-Z][a-z]+)\s+is also\s+([^\.]+?)(?:\.|,)/g,
    2,
    1,
  )
  addQualificationAssignmentsFromMatches(
    assignments,
    employeeSection,
    /\b([A-Z][a-z]+)\s+is\s+([^\.]+?)(?:\.|,)/g,
    2,
    1,
  )

  return assignments
}

function extractEmployeeSection(sourceText: string): string {
  const employeeSectionMatch = sourceText.match(/Employees:\s*([\s\S]*?)(?:\n\nThe availability for the staff is:|$)/i)
  return employeeSectionMatch?.[1]?.trim() ?? ''
}

function addQualificationAssignmentsFromMatches(
  assignments: Map<string, Set<string>>,
  sourceText: string,
  pattern: RegExp,
  qualificationsIndex: number,
  namesIndex: number,
): void {
  for (const match of sourceText.matchAll(pattern)) {
    const qualifications = extractQualificationsFromPhrase(match[qualificationsIndex] ?? '')
    if (qualifications.length === 0) {
      continue
    }

    for (const name of parseNameList(match[namesIndex] ?? '')) {
      const normalizedName = normalizeEmployeeConstraintName(name)
      if (!normalizedName) {
        continue
      }

      const assignment = assignments.get(normalizedName) ?? new Set<string>()
      for (const qualification of qualifications) {
        assignment.add(qualification)
      }
      assignments.set(normalizedName, assignment)
    }
  }
}

function extractQualificationsFromPhrase(phrase: string): string[] {
  const normalizedPhrase = normalizeQualification(phrase)
  return KNOWN_SOURCE_QUALIFICATIONS.filter((qualification) => containsWholePhrase(normalizedPhrase, qualification))
}

function parseNameList(value: string): string[] {
  return value
    .replace(/\band\b/gi, ',')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*$/.test(name))
}

function buildShiftRequirementsFromSource(sourceText: string): SourceDerivedShiftRequirement[] {
  const lines = sourceText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const shiftRequirements: SourceDerivedShiftRequirement[] = []
  let activeDays: string[] = []
  let pendingTaggedRequirementStartIndex: number | null = null

  for (const line of lines) {
    const parsedDayRange = parseDayRangeHeader(line)
    if (parsedDayRange.length > 0) {
      activeDays = parsedDayRange
      pendingTaggedRequirementStartIndex = null
      continue
    }

    const parsedShiftTagNote = parseShiftTagNoteLine(line)
    if (
      parsedShiftTagNote.length > 0
      && pendingTaggedRequirementStartIndex !== null
      && pendingTaggedRequirementStartIndex < shiftRequirements.length
    ) {
      appendTagsToShiftRequirements(
        shiftRequirements,
        pendingTaggedRequirementStartIndex,
        parsedShiftTagNote,
      )
      pendingTaggedRequirementStartIndex = null
      continue
    }

    if (/:$/.test(line)) {
      activeDays = []
      pendingTaggedRequirementStartIndex = null
      continue
    }

    if (activeDays.length === 0) {
      continue
    }

    const parsedShiftLine = parseSourceShiftLine(line)
    if (!parsedShiftLine) {
      continue
    }

    if (pendingTaggedRequirementStartIndex === null) {
      pendingTaggedRequirementStartIndex = shiftRequirements.length
    }

    for (const dayOfWeek of activeDays) {
      for (const timeRange of parsedShiftLine.timeRanges) {
        shiftRequirements.push({
          allowedEmployeeNames: [],
          continuityGroup: null,
          dayOfWeek,
          disallowedEmployeeNames: [],
          endTime: timeRange.endTime,
          label: parsedShiftLine.label,
          requiredHeadcount: 1,
          requiredQualifications: [],
          roleLabel: null,
          startTime: timeRange.startTime,
          tags: parsedShiftLine.tags,
        })
      }
    }
  }

  return shiftRequirements
}

function parseDayRangeHeader(line: string): string[] {
  const match = line.match(
    /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+through\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s*,\s*[^:]+)?(?:\s+there are)?:\s*$/i,
  )
  if (!match) {
    return []
  }

  const startDay = normalizeWeekdayValue(match[1])
  const endDay = normalizeWeekdayValue(match[2])
  if (typeof startDay !== 'string' || typeof endDay !== 'string' || !startDay || !endDay) {
    return []
  }

  return expandWeekdayRange(startDay, endDay)
}

function parseShiftTagNoteLine(line: string): string[] {
  const normalizedLine = line.replace(/[“”]/g, '"')
  const match = normalizedLine.match(
    /^(?:the above shifts|these shifts|those shifts)\s+are\s+all\s+tagged\s+(?:as\s+)?"?([^".]+?)"?\s+shifts?\.?$/i,
  )
  if (!match) {
    return []
  }

  return match[1]
    ?.split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0) ?? []
}

function appendTagsToShiftRequirements(
  shiftRequirements: SourceDerivedShiftRequirement[],
  startIndex: number,
  tags: string[],
): void {
  for (let index = startIndex; index < shiftRequirements.length; index += 1) {
    const shiftRequirement = shiftRequirements[index]
    if (!shiftRequirement) {
      continue
    }

    shiftRequirement.tags = [...new Set([...shiftRequirement.tags, ...tags])]
  }
}

function expandWeekdayRange(startDay: string, endDay: string): string[] {
  const startIndex = WEEKDAY_ORDER.indexOf(startDay as (typeof WEEKDAY_ORDER)[number])
  const endIndex = WEEKDAY_ORDER.indexOf(endDay as (typeof WEEKDAY_ORDER)[number])
  if (startIndex < 0 || endIndex < 0) {
    return []
  }

  const days: string[] = []
  for (let index = startIndex; ; index = (index + 1) % WEEKDAY_ORDER.length) {
    days.push(WEEKDAY_ORDER[index] ?? startDay)
    if (index === endIndex) {
      break
    }
  }
  return days
}

function parseSourceShiftLine(line: string): { label: string; tags: string[]; timeRanges: Array<{ endTime: string; startTime: string }> } | null {
  const match = line.match(/^(.*?)\s+(\d{1,2}(?::\d{2})?\s*-\s*\d{1,2}(?::\d{2})?(?:\s*,\s*\d{1,2}(?::\d{2})?\s*-\s*\d{1,2}(?::\d{2})?)*)$/)
  if (!match) {
    return null
  }

  const rawLabel = match[1]?.trim() ?? ''
  const timesSegment = match[2]?.trim() ?? ''
  if (!rawLabel || !timesSegment) {
    return null
  }

  const tagMatches = [...rawLabel.matchAll(/\[([^\]]+)\]/g)]
  const tags = tagMatches.flatMap((tagMatch) => tagMatch[1]?.split(',') ?? []).map((tag) => tag.trim()).filter(Boolean)
  const label = rawLabel.replace(/\s*\[[^\]]+\]/g, '').trim()
  const timeRanges = parseSourceTimeRanges(timesSegment)
  if (!label || timeRanges.length === 0) {
    return null
  }

  return { label, tags, timeRanges }
}

function parseSourceTimeRanges(timesSegment: string): Array<{ endTime: string; startTime: string }> {
  const parsedRanges: Array<{ endMinute: number; startMinute: number }> = []
  let previousEndMinute = 8 * 60

  for (const rawRange of timesSegment.split(',')) {
    const [rawStart, rawEnd] = rawRange.split('-').map((part) => part.trim())
    if (!rawStart || !rawEnd) {
      return []
    }

    const parsedRange = pickBestTimeRange(rawStart, rawEnd, previousEndMinute)
    if (!parsedRange) {
      return []
    }

    parsedRanges.push(parsedRange)
    previousEndMinute = parsedRange.endMinute
  }

  return parsedRanges.map((range) => ({
    endTime: formatClockMinutes(range.endMinute),
    startTime: formatClockMinutes(range.startMinute),
  }))
}

function pickBestTimeRange(
  rawStart: string,
  rawEnd: string,
  previousEndMinute: number,
): { endMinute: number; startMinute: number } | null {
  const startCandidates = buildClockCandidates(rawStart)
  const endCandidates = buildClockCandidates(rawEnd)
  let bestRange: { endMinute: number; score: number; startMinute: number } | null = null

  for (const startMinute of startCandidates) {
    for (const endMinute of endCandidates) {
      if (endMinute <= startMinute) {
        continue
      }

      const duration = endMinute - startMinute
      if (duration < 15 || duration > 16 * 60) {
        continue
      }

      const startsBeforePrevious = startMinute < previousEndMinute
      const score = (startsBeforePrevious ? 10_000 : 0)
        + Math.max(0, startMinute - previousEndMinute)
        + Math.max(0, endMinute - 24 * 60)

      if (!bestRange || score < bestRange.score) {
        bestRange = { endMinute, score, startMinute }
      }
    }
  }

  if (!bestRange) {
    return null
  }

  return { endMinute: bestRange.endMinute, startMinute: bestRange.startMinute }
}

function buildClockCandidates(value: string): number[] {
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?$/)
  if (!match) {
    return []
  }

  const hour = Number.parseInt(match[1] ?? '', 10)
  const minute = Number.parseInt(match[2] ?? '0', 10)
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 12 || minute < 0 || minute >= 60) {
    return []
  }

  const baseMinutes = (hour % 12) * 60 + minute
  const candidates = new Set<number>()
  for (const offset of [0, 12 * 60, 24 * 60]) {
    const candidate = baseMinutes + offset
    if (candidate >= 8 * 60 && candidate <= 26 * 60) {
      candidates.add(candidate)
    }
  }

  if (hour === 12) {
    const noonCandidate = 12 * 60 + minute
    if (noonCandidate >= 8 * 60 && noonCandidate <= 26 * 60) {
      candidates.add(noonCandidate)
    }

    const midnightCandidate = 24 * 60 + minute
    if (midnightCandidate >= 8 * 60 && midnightCandidate <= 26 * 60) {
      candidates.add(midnightCandidate)
    }
  }

  return [...candidates].sort((left, right) => left - right)
}

function formatClockMinutes(totalMinutes: number): string {
  const normalizedMinutes = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60)
  const hours = Math.floor(normalizedMinutes / 60)
  const minutes = normalizedMinutes % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function normalizeWeekdayValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }

  return WEEKDAY_ALIASES.get(value.trim().toLowerCase()) ?? value.trim().toLowerCase()
}

function normalizeTimeOfDayValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }

  const trimmedValue = value.trim().toLowerCase()
  if (!trimmedValue) {
    return value
  }

  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmedValue)) {
    return trimmedValue
  }

  if (trimmedValue === 'noon') {
    return '12:00'
  }
  if (trimmedValue === 'midnight') {
    return '00:00'
  }

  const meridiemMatch = trimmedValue.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (meridiemMatch) {
    const rawHour = Number.parseInt(meridiemMatch[1] ?? '', 10)
    const minutes = Number.parseInt(meridiemMatch[2] ?? '0', 10)
    const meridiem = meridiemMatch[3]
    if (Number.isFinite(rawHour) && Number.isFinite(minutes) && rawHour >= 1 && rawHour <= 12 && minutes >= 0 && minutes < 60) {
      let hours = rawHour % 12
      if (meridiem === 'pm') {
        hours += 12
      }
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    }
  }

  const shortClockMatch = trimmedValue.match(/^(\d{1,2})(?::(\d{2}))?$/)
  if (shortClockMatch) {
    const hours = Number.parseInt(shortClockMatch[1] ?? '', 10)
    const minutes = Number.parseInt(shortClockMatch[2] ?? '0', 10)
    if (Number.isFinite(hours) && Number.isFinite(minutes) && hours >= 0 && hours <= 23 && minutes >= 0 && minutes < 60) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    }
  }

  return value
}

function isNormalizedTimeOfDayValue(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

function normalizeAvailabilityTimeOfDayValue(value: unknown, boundary: 'end' | 'start'): unknown {
  if (typeof value !== 'string') {
    return value
  }

  const normalizedValue = value
    .trim()
    .toLowerCase()
    .replace(/[.,;:!?]+$/g, '')
    .replace(/^\((.*)\)$/g, '$1')
    .replace(/\s+/g, ' ')
  if (!normalizedValue) {
    return value
  }

  const boundaryStrippedValue = normalizedValue.replace(/^(?:at|by|from|through|thru|till|til|to|until)\s+/, '')

  if (/^24(?::00)?$/.test(boundaryStrippedValue)) {
    return boundary === 'start' ? '00:00' : '23:59'
  }

  if (/^(?:all(?:[ -]?day|[ -]?times?)|any(?:[ -]?time|[ -]?times?))$/.test(boundaryStrippedValue)) {
    return boundary === 'start' ? '00:00' : '23:59'
  }

  if (/^(?:open|opening)$/.test(boundaryStrippedValue)) {
    return '00:00'
  }

  if (/^(?:close|closing)$/.test(boundaryStrippedValue)) {
    return '23:59'
  }

  return normalizeTimeOfDayValue(boundaryStrippedValue)
}

function arrayOfStrings(value: unknown): string[] {
  if (value === null || value === undefined) {
    return []
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string')
  }
  return typeof value === 'string' ? [value] : []
}

function buildShiftRequirementKey(input: { dayOfWeek: string; endTime: string; label: string; startTime: string }): string {
  return `${input.dayOfWeek}|${input.label}|${input.startTime}|${input.endTime}`
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || 'item'
}

function buildEmployeeIdByName(
  employees: NormalizedSolverInput['employees'],
  issues: SchedulingValidationIssue[],
): Map<string, string> {
  const employeeIdByName = new Map<string, string>()

  for (const employee of employees) {
    const normalizedName = normalizeEmployeeConstraintName(employee.name)
    const existingEmployeeId = employeeIdByName.get(normalizedName)
    if (existingEmployeeId && existingEmployeeId !== employee.id) {
      issues.push({
        code: 'ambiguous-employee-name',
        message: `Multiple employees normalize to ${employee.name}, so role-specific employee constraints should be reviewed manually.`,
        severity: 'warning',
      })
      employeeIdByName.delete(normalizedName)
      continue
    }

    employeeIdByName.set(normalizedName, employee.id)
  }

  return employeeIdByName
}

function buildEmployeeQualificationsByName(
  employees: LLMExtractedConstraints['employees'],
): Map<string, Set<string>> {
  const qualificationsByName = new Map<string, Set<string>>()

  for (const employee of employees) {
    qualificationsByName.set(
      normalizeEmployeeConstraintName(employee.name),
      new Set(employee.qualifications.map(normalizeQualification)),
    )
  }

  return qualificationsByName
}

function buildKnownQualifications(
  employees: LLMExtractedConstraints['employees'],
): Set<string> {
  const knownQualifications = new Set<string>()

  for (const employee of employees) {
    for (const qualification of employee.qualifications) {
      knownQualifications.add(normalizeQualification(qualification))
    }
  }

  return knownQualifications
}

function buildRequiredQualifications(
  shiftRequirement: LLMExtractedConstraints['shiftRequirements'][number],
  knownQualifications: Set<string>,
): string[] {
  const requiredQualifications = new Set(shiftRequirement.requiredQualifications.map(normalizeQualification))
  const derivedRoleQualification = deriveRoleQualification(shiftRequirement)
  const derivedKnownQualifications = deriveKnownQualificationsFromShift(shiftRequirement, knownQualifications)

  if (derivedRoleQualification) {
    requiredQualifications.add(derivedRoleQualification)
  }
  for (const qualification of derivedKnownQualifications) {
    requiredQualifications.add(qualification)
  }

  return [...requiredQualifications].sort()
}

function deriveRoleQualification(
  shiftRequirement: LLMExtractedConstraints['shiftRequirements'][number],
): string | null {
  if (
    shiftRequirement.roleLabel === null
    || (shiftRequirement.allowedEmployeeNames.length === 0 && shiftRequirement.disallowedEmployeeNames.length === 0)
  ) {
    return null
  }

  return normalizeQualification(shiftRequirement.roleLabel)
}

function deriveKnownQualificationsFromShift(
  shiftRequirement: LLMExtractedConstraints['shiftRequirements'][number],
  knownQualifications: Set<string>,
): string[] {
  const derivedQualifications: string[] = []

  for (const qualification of knownQualifications) {
    if (shiftReferencesQualification(shiftRequirement, qualification)) {
      derivedQualifications.push(qualification)
    }
  }

  return derivedQualifications.sort()
}

function shiftReferencesQualification(
  shiftRequirement: LLMExtractedConstraints['shiftRequirements'][number],
  qualification: string,
): boolean {
  const needle = normalizeQualification(qualification)
  if (needle.length === 0) {
    return false
  }

  return [shiftRequirement.label, shiftRequirement.roleLabel ?? '', ...shiftRequirement.tags]
    .map((value) => normalizeQualification(value))
    .some((value) => containsWholePhrase(value, needle))
}

function containsWholePhrase(value: string, phrase: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}([^a-z0-9]|$)`, 'i').test(value)
}

function inferImplicitContinuityGroups(
  shiftRequirements: LLMExtractedConstraints['shiftRequirements'],
  knownQualifications: Set<string>,
): Map<number, string> {
  const derivedGroups = new Map<number, string>()
  const indexedRequirements = shiftRequirements.map((shiftRequirement, index) => ({
    index,
    requiredQualifications: buildRequiredQualifications(shiftRequirement, knownQualifications),
    shiftRequirement,
  }))

  for (const source of indexedRequirements) {
    if (normalizeOptionalString(source.shiftRequirement.continuityGroup)) {
      continue
    }
    if (!isPassiveQualifiedShift(source.shiftRequirement, source.requiredQualifications)) {
      continue
    }

    const target = indexedRequirements
      .filter((candidate) => candidate.index !== source.index)
      .filter((candidate) => candidate.shiftRequirement.dayOfWeek === source.shiftRequirement.dayOfWeek)
      .filter((candidate) => !isPassiveQualifiedShift(candidate.shiftRequirement, candidate.requiredQualifications))
      .filter((candidate) => shiftsTouchOrOverlap(source.shiftRequirement, candidate.shiftRequirement))
      .sort((left, right) => compareContinuityTarget(source.shiftRequirement, left.shiftRequirement, right.shiftRequirement))[0]

    if (!target) {
      continue
    }

    const group = `derived-${slugify(`${source.shiftRequirement.dayOfWeek}-${source.shiftRequirement.label}-${source.shiftRequirement.startTime}-${target.shiftRequirement.label}-${target.shiftRequirement.startTime}`)}`
    derivedGroups.set(source.index, group)
    if (!normalizeOptionalString(target.shiftRequirement.continuityGroup)) {
      derivedGroups.set(target.index, group)
    }
  }

  return derivedGroups
}

function isPassiveQualifiedShift(
  shiftRequirement: LLMExtractedConstraints['shiftRequirements'][number],
  requiredQualifications: string[],
): boolean {
  if (requiredQualifications.length === 0) {
    return false
  }

  return [shiftRequirement.label, shiftRequirement.roleLabel ?? '', ...shiftRequirement.tags]
    .some((value) => /(^|[^a-z])(passive|open|opening)([^a-z]|$)/i.test(value))
}

function shiftsTouchOrOverlap(
  left: LLMExtractedConstraints['shiftRequirements'][number],
  right: LLMExtractedConstraints['shiftRequirements'][number],
): boolean {
  const leftInterval = buildClockInterval(left.startTime, left.endTime)
  const rightInterval = buildClockInterval(right.startTime, right.endTime)
  return leftInterval.startMinute <= rightInterval.endMinute && rightInterval.startMinute <= leftInterval.endMinute
}

function compareContinuityTarget(
  source: LLMExtractedConstraints['shiftRequirements'][number],
  left: LLMExtractedConstraints['shiftRequirements'][number],
  right: LLMExtractedConstraints['shiftRequirements'][number],
): number {
  const leftScore = buildContinuityTargetScore(source, left)
  const rightScore = buildContinuityTargetScore(source, right)
  if (leftScore !== rightScore) {
    return leftScore - rightScore
  }

  if (left.startTime !== right.startTime) {
    return left.startTime.localeCompare(right.startTime)
  }

  return left.label.localeCompare(right.label)
}

function buildContinuityTargetScore(
  source: LLMExtractedConstraints['shiftRequirements'][number],
  target: LLMExtractedConstraints['shiftRequirements'][number],
): number {
  const sourceInterval = buildClockInterval(source.startTime, source.endTime)
  const targetInterval = buildClockInterval(target.startTime, target.endTime)
  const startsInsideSource = targetInterval.startMinute >= sourceInterval.startMinute
    && targetInterval.startMinute <= sourceInterval.endMinute
  const sourceEndsInsideTarget = sourceInterval.endMinute >= targetInterval.startMinute
    && sourceInterval.endMinute <= targetInterval.endMinute

  if (startsInsideSource) {
    return 0
  }
  if (sourceEndsInsideTarget) {
    return 1
  }

  return Math.abs(sourceInterval.endMinute - targetInterval.startMinute) + 10
}

function buildClockInterval(startTime: string, endTime: string): { endMinute: number; startMinute: number } {
  const startMinute = parseClockMinutes(startTime)
  let endMinute = parseClockMinutes(endTime)
  if (endMinute <= startMinute) {
    endMinute += 24 * 60
  }

  return { endMinute, startMinute }
}

function parseClockMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map((part) => Number.parseInt(part, 10))
  return hours * 60 + minutes
}

function resolveEmployeeConstraintIds(input: {
  employeeIdByName: Map<string, string>
  issues: SchedulingValidationIssue[]
  names: string[]
  requiredQualifications: string[]
  roleLabel: string | null
  shiftLabel: string
  type: 'allowed' | 'disallowed'
}): string[] {
  const resolvedEmployeeIds: string[] = []

  for (const name of input.names) {
    const employeeId = input.employeeIdByName.get(normalizeEmployeeConstraintName(name))
    if (!employeeId) {
      input.issues.push({
        code: 'unknown-role-employee-constraint',
        message: `Could not match ${name} to an employee for ${formatConstraintTarget(input)} ${input.type} list.`,
        severity: 'warning',
      })
      continue
    }

    if (!resolvedEmployeeIds.includes(employeeId)) {
      resolvedEmployeeIds.push(employeeId)
    }
  }

  return resolvedEmployeeIds
}

function normalizeEmployeeConstraintName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizeQualification(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizeOptionalString(value: string | null): string | null {
  if (value === null) {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function formatConstraintTarget(input: {
  requiredQualifications: string[]
  roleLabel: string | null
  shiftLabel: string
}): string {
  const qualificationLabel = input.requiredQualifications.join(', ')
  if (qualificationLabel.length > 0) {
    return qualificationLabel
  }

  return input.roleLabel ?? input.shiftLabel
}

function describeStructuredOutputError(error: Error | null): string {
  if (error instanceof ZodError) {
    return error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
  }

  return error?.message ?? 'Unknown structured-output error.'
}

async function requestMantleJson(input: {
  maxTokens: number
  messages: ChatMessage[]
  model: string
  temperature: number
}): Promise<{ assistantContent: string }> {
  const env = getWorkerEnv()
  if (!env.bedrockMantleBearerToken) {
    throw new Error('BEDROCK_MANTLE_BEARER_TOKEN is required for scheduling constraint extraction.')
  }

  let response: Response
  try {
    response = await fetch(`${env.bedrockMantleBaseUrl}/chat/completions`, {
      body: JSON.stringify({
        max_tokens: input.maxTokens,
        messages: input.messages,
        model: input.model,
        response_format: { type: 'json_object' },
        temperature: input.temperature,
        top_p: 0.2,
      }),
      headers: {
        Authorization: `Bearer ${env.bedrockMantleBearerToken}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(env.llmRequestTimeoutMs),
    })
  } catch (error) {
    throw new RetryableWorkerError(buildTransportErrorMessage(error))
  }

  const responseText = await response.text()
  if (!response.ok) {
    const message = `Scheduling extraction request returned HTTP ${response.status}: ${truncate(responseText)}`
    if (isRetryableStatusCode(response.status)) {
      throw new RetryableWorkerError(message)
    }
    throw new Error(message)
  }

  let parsedResponse: unknown
  try {
    parsedResponse = JSON.parse(responseText)
  } catch {
    throw new RetryableWorkerError(`Scheduling extraction returned invalid JSON: ${truncate(responseText)}`)
  }

  return { assistantContent: extractAssistantContent(parsedResponse) }
}

function extractAssistantContent(payload: unknown): string {
  if (!isRecord(payload)) {
    throw new Error('LLM response payload was not an object.')
  }

  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('LLM response contained no choices.')
  }

  const firstChoice = choices[0]
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error('LLM response contained no message payload.')
  }

  const content = firstChoice.message.content
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
      .join('')
      .trim()

    if (joined) {
      return joined
    }
  }

  throw new Error('LLM response did not include assistant text content.')
}

function parseJsonObject(content: string): Record<string, unknown> {
  const normalized = normalizeJsonEnvelope(content)

  try {
    return parseJsonObjectStrict(normalized)
  } catch (error) {
    const repaired = repairMalformedJson(normalized)
    if (repaired !== normalized) {
      return parseJsonObjectStrict(repaired)
    }
    throw error
  }
}

function normalizeJsonEnvelope(content: string): string {
  const unfenced = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const firstObjectStart = unfenced.indexOf('{')
  const lastObjectEnd = unfenced.lastIndexOf('}')

  if (firstObjectStart >= 0 && lastObjectEnd > firstObjectStart) {
    return unfenced.slice(firstObjectStart, lastObjectEnd + 1)
  }

  return unfenced
}

function parseJsonObjectStrict(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as unknown
  if (!isRecord(parsed)) {
    throw new Error('Scheduling extraction did not return an object.')
  }
  return parsed
}

function repairMalformedJson(content: string): string {
  let repaired = ''
  let inString = false
  let isEscaped = false

  for (const character of content) {
    if (inString) {
      if (isEscaped) {
        repaired += character
        isEscaped = false
        continue
      }

      if (character === '\\') {
        repaired += character
        isEscaped = true
        continue
      }

      if (character === '"') {
        repaired += character
        inString = false
        continue
      }

      if (character === '\n') {
        repaired += '\\n'
        continue
      }

      if (character === '\r') {
        repaired += '\\r'
        continue
      }

      if (character === '\t') {
        repaired += '\\t'
        continue
      }

      if (character < ' ') {
        repaired += `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
        continue
      }

      repaired += character
      continue
    }

    if (character === '"') {
      inString = true
    }

    repaired += character
  }

  return repaired.replace(/,(\s*[}\]])/g, '$1')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isRetryableStatusCode(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

function buildTransportErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `Scheduling extraction transport failed: ${error.message}`
  }
  return 'Scheduling extraction transport failed.'
}

function truncate(value: string, limit = 400): string {
  if (value.length <= limit) {
    return value
  }
  return `${value.slice(0, limit - 3)}...`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export {
  SCHEDULING_EXTRACTION_MODEL,
  SCHEDULING_EXTRACTION_PROMPT_VERSION,
}

export const __test__ = {
  buildEmployeeQualificationAssignments,
  buildRepairMessages,
  buildShiftRequirementsFromSource,
  coerceSchedulingExtractionObject,
  normalizeExtractedConstraints,
  parseJsonObject,
}
