import {
  DEFAULT_SCHEDULING_CANDIDATE_COUNT,
  NormalizedSolverInputSchema,
  SchedulingCandidateCountSchema,
  applySchedulingWeeklyHoursPolicy,
  countSchedulingWeeks,
  type NormalizedSolverInput,
  type ScheduleCandidate,
  type SchedulingWeekday,
} from '../../shared/contracts/index.js'

const WEEKDAY_ORDER: SchedulingWeekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

interface CandidateVariant {
  biweeklyStabilityBonus: number
  biweeklyStabilityPenalty: number
  code: string
  costWeight: number
  label: string
  preferenceWeight: number
  repeatPenalty: number
  seed: number
  weeklyStabilityBonus: number
  weeklyStabilityPenalty: number
}

const BASE_CANDIDATE_VARIANTS: CandidateVariant[] = [
  {
    code: 'stable-weekly',
    costWeight: 0.18,
    label: 'Stable weekly cycle',
    preferenceWeight: 0.9,
    repeatPenalty: 120,
    seed: 0,
    biweeklyStabilityBonus: 1_800,
    biweeklyStabilityPenalty: 900,
    weeklyStabilityBonus: 2_500,
    weeklyStabilityPenalty: 1_400,
  },
  {
    code: 'stable-biweekly',
    costWeight: 0.2,
    label: 'Stable 2-week cycle',
    preferenceWeight: 0.85,
    repeatPenalty: 200,
    seed: 1,
    biweeklyStabilityBonus: 2_600,
    biweeklyStabilityPenalty: 1_500,
    weeklyStabilityBonus: 1_500,
    weeklyStabilityPenalty: 700,
  },
  {
    code: 'balanced',
    costWeight: 0.16,
    label: 'Balanced coverage',
    preferenceWeight: 1,
    repeatPenalty: 260,
    seed: 2,
    biweeklyStabilityBonus: 1_900,
    biweeklyStabilityPenalty: 900,
    weeklyStabilityBonus: 2_000,
    weeklyStabilityPenalty: 1_050,
  },
  {
    code: 'preference-first',
    costWeight: 0.12,
    label: 'Preference-first',
    preferenceWeight: 1.7,
    repeatPenalty: 360,
    seed: 3,
    biweeklyStabilityBonus: 1_700,
    biweeklyStabilityPenalty: 800,
    weeklyStabilityBonus: 2_100,
    weeklyStabilityPenalty: 1_100,
  },
  {
    code: 'cost-aware',
    costWeight: 0.55,
    label: 'Cost-aware',
    preferenceWeight: 0.65,
    repeatPenalty: 520,
    seed: 4,
    biweeklyStabilityBonus: 1_600,
    biweeklyStabilityPenalty: 900,
    weeklyStabilityBonus: 1_900,
    weeklyStabilityPenalty: 1_100,
  },
]

interface ShiftOccurrence {
  date: string
  occurrenceKey: string
  shiftRequirement: NormalizedSolverInput['shiftRequirements'][number]
  weekIndex: number
  weekStartDate: string
}

interface ContinuityLink {
  carryForwardSeatCount: number
  nextOccurrenceKey: string
  previousOccurrenceKey: string
}

interface ContinuityIndex {
  incomingByOccurrenceKey: Map<string, ContinuityLink>
  linkedOccurrenceKeysByOccurrenceKey: Map<string, Set<string>>
  outgoingByOccurrenceKey: Map<string, ContinuityLink>
}

interface TimeInterval {
  endMinute: number
  startMinute: number
}

export function buildScheduleCandidates(
  input: NormalizedSolverInput,
  requestedCandidateCount = DEFAULT_SCHEDULING_CANDIDATE_COUNT,
): ScheduleCandidate[] {
  const normalizedInput = applySchedulingWeeklyHoursPolicy(NormalizedSolverInputSchema.parse(input))
  const targetCandidateCount = SchedulingCandidateCountSchema.parse(requestedCandidateCount)
  const shiftOccurrences = buildShiftOccurrences(normalizedInput)
  const continuity = buildContinuityIndex(shiftOccurrences)
  const uniqueCandidates: ScheduleCandidate[] = []
  const signatures = new Set<string>()

  for (const variant of buildCandidateVariants(targetCandidateCount)) {
    const candidate = buildCandidateForVariant({
      input: normalizedInput,
      priorCandidates: uniqueCandidates,
      shiftOccurrences,
      continuity,
      variant,
    })
    const signature = JSON.stringify(candidate.assignments)
    if (signatures.has(signature)) {
      continue
    }

    signatures.add(signature)
    uniqueCandidates.push(candidate)
    if (uniqueCandidates.length >= targetCandidateCount) {
      break
    }
  }

  return uniqueCandidates
}

function buildCandidateForVariant(input: {
  continuity: ContinuityIndex
  input: NormalizedSolverInput
  priorCandidates: ScheduleCandidate[]
  shiftOccurrences: ShiftOccurrence[]
  variant: CandidateVariant
}): ScheduleCandidate {
  const assignments = new Map<string, string[]>()
  const assignedMinutesByEmployee = new Map<string, number>(input.input.employees.map((employee) => [employee.id, 0]))
  const assignedMinutesByEmployeeWeek = new Map<string, number>()
  const assignedIntervalsByEmployeeDate = new Map<string, TimeInterval[]>()
  const assignedOccurrenceKeysByEmployee = new Map<string, string[]>(input.input.employees.map((employee) => [employee.id, []]))
  const assignedEmployeesByShiftSeriesWeek = new Map<string, string[]>()
  const occurrenceByKey = new Map(input.shiftOccurrences.map((occurrence) => [occurrence.occurrenceKey, occurrence]))
  const coverageWarnings: ScheduleCandidate['coverageWarnings'] = []

  input.shiftOccurrences.forEach((occurrence, occurrenceIndex) => {
    const assignedEmployeeIds = carryForwardEmployeesIntoOccurrence({
      assignments,
      assignedOccurrenceKeysByEmployee,
      continuity: input.continuity,
      input: input.input,
      occurrence,
      occurrenceByKey,
    })
    assignments.set(occurrence.occurrenceKey, assignedEmployeeIds)
    for (const employeeId of assignedEmployeeIds) {
      const incrementalMinutes = recordAssignedInterval({
        assignedIntervalsByEmployeeDate,
        date: occurrence.date,
        employeeId,
        occurrence,
      })
      assignedMinutesByEmployee.set(employeeId, (assignedMinutesByEmployee.get(employeeId) ?? 0) + incrementalMinutes)
      assignedMinutesByEmployeeWeek.set(
        buildEmployeeWeekKey(employeeId, occurrence.weekStartDate),
        (assignedMinutesByEmployeeWeek.get(buildEmployeeWeekKey(employeeId, occurrence.weekStartDate)) ?? 0) + incrementalMinutes,
      )
      assignedOccurrenceKeysByEmployee.set(employeeId, [
        ...(assignedOccurrenceKeysByEmployee.get(employeeId) ?? []),
        occurrence.occurrenceKey,
      ])
    }
    const incomingLink = input.continuity.incomingByOccurrenceKey.get(occurrence.occurrenceKey)
    if (incomingLink && assignedEmployeeIds.length < incomingLink.carryForwardSeatCount) {
      coverageWarnings.push({
        date: occurrence.date,
        message: `Could not preserve ${incomingLink.carryForwardSeatCount} carry-forward seat${incomingLink.carryForwardSeatCount === 1 ? '' : 's'} into ${occurrence.shiftRequirement.label}.`,
        shiftRequirementId: occurrence.shiftRequirement.id,
      })
    }
    const outgoingLink = input.continuity.outgoingByOccurrenceKey.get(occurrence.occurrenceKey)

    for (let seatIndex = assignedEmployeeIds.length; seatIndex < occurrence.shiftRequirement.requiredHeadcount; seatIndex += 1) {
      const availableEmployees = input.input.employees
        .filter((employee) => isEmployeeAvailableForShift(employee, occurrence.shiftRequirement))
        .filter((employee) => isEmployeeEligibleForShift(employee, occurrence.shiftRequirement))
        .filter((employee) => !assignedEmployeeIds.includes(employee.id))
        .filter((employee) => !hasShiftOverlap(employee.id, occurrence, occurrenceByKey, assignedOccurrenceKeysByEmployee, input.continuity))
        .filter((employee) => {
          if (!outgoingLink || seatIndex >= outgoingLink.carryForwardSeatCount) {
            return true
          }

          return canEmployeeSatisfyContinuityChain(employee, occurrence, occurrenceByKey, input.continuity)
        })

      if (availableEmployees.length === 0) {
        break
      }

      const selectedEmployee = [...availableEmployees]
        .sort((left, right) => compareCandidateEmployees({
          assignedEmployeesByShiftSeriesWeek,
          assignedIntervalsByEmployeeDate,
          assignedMinutesByEmployee,
          assignedMinutesByEmployeeWeek,
          input: input.input,
          left,
          occurrence,
          occurrenceIndex,
          priorCandidates: input.priorCandidates,
          right,
          seatIndex,
          variant: input.variant,
        }))[0]

      assignedEmployeeIds.push(selectedEmployee.id)
      assignments.set(occurrence.occurrenceKey, assignedEmployeeIds)
      const incrementalMinutes = recordAssignedInterval({
        assignedIntervalsByEmployeeDate,
        date: occurrence.date,
        employeeId: selectedEmployee.id,
        occurrence,
      })
      assignedMinutesByEmployee.set(selectedEmployee.id, (assignedMinutesByEmployee.get(selectedEmployee.id) ?? 0) + incrementalMinutes)
      assignedMinutesByEmployeeWeek.set(
        buildEmployeeWeekKey(selectedEmployee.id, occurrence.weekStartDate),
        (assignedMinutesByEmployeeWeek.get(buildEmployeeWeekKey(selectedEmployee.id, occurrence.weekStartDate)) ?? 0) + incrementalMinutes,
      )
      assignedOccurrenceKeysByEmployee.set(selectedEmployee.id, [
        ...(assignedOccurrenceKeysByEmployee.get(selectedEmployee.id) ?? []),
        occurrence.occurrenceKey,
      ])
    }

    assignedEmployeesByShiftSeriesWeek.set(buildShiftSeriesWeekKey(occurrence.shiftRequirement.id, occurrence.weekIndex), assignedEmployeeIds)
    if (assignedEmployeeIds.length < occurrence.shiftRequirement.requiredHeadcount) {
      coverageWarnings.push({
        date: occurrence.date,
        message: `Only filled ${assignedEmployeeIds.length} of ${occurrence.shiftRequirement.requiredHeadcount} seats for ${occurrence.shiftRequirement.label}.`,
        shiftRequirementId: occurrence.shiftRequirement.id,
      })
    }
  })

  const assignmentList = input.shiftOccurrences.map((occurrence) => ({
    date: occurrence.date,
    employeeIds: assignments.get(occurrence.occurrenceKey) ?? [],
    shiftRequirementId: occurrence.shiftRequirement.id,
  }))
  const weekCount = countSchedulingWeeks(input.input.scheduleWeek)
  const assignedSeatCount = assignmentList.reduce((sum, assignment) => sum + assignment.employeeIds.length, 0)
  const totalRequiredSeats = input.shiftOccurrences.reduce((sum, occurrence) => sum + occurrence.shiftRequirement.requiredHeadcount, 0)
  const preferenceMatches = assignmentList.reduce((sum, assignment) => {
    const occurrence = input.shiftOccurrences.find((candidate) => candidate.occurrenceKey === buildOccurrenceKey(assignment.shiftRequirementId, assignment.date ?? input.input.scheduleWeek.startDate))
    if (!occurrence) {
      return sum
    }

    return sum + assignment.employeeIds.filter((employeeId) => {
      const employee = input.input.employees.find((candidate) => candidate.id === employeeId)
      if (!employee) {
        return false
      }

      return employee.preferredDays.includes(occurrence.shiftRequirement.dayOfWeek)
        || occurrence.shiftRequirement.tags.some((tag) => employee.preferredShiftTags.includes(tag))
    }).length
  }, 0)
  const totalAssignedMinutes = [...assignedMinutesByEmployee.values()].reduce((sum, minutes) => sum + minutes, 0)
  const totalLaborCost = input.input.employees.reduce((sum, employee) => {
    const minutes = assignedMinutesByEmployee.get(employee.id) ?? 0
    return sum + (minutes / 60) * employee.hourlyRate
  }, 0)
  const overtimeAssignmentCount = [...assignedMinutesByEmployeeWeek.entries()].filter(([employeeWeekKey, minutes]) => {
    const employeeId = employeeWeekKey.split('::', 1)[0]
    const employee = input.input.employees.find((candidate) => candidate.id === employeeId)
    return employee !== undefined && minutes > employee.maxMinutesPerWeek!
  }).length
  const fairnessScore = calculateFairnessScore(input.input.employees.map((employee) => (assignedMinutesByEmployee.get(employee.id) ?? 0) / weekCount))

  return {
    assignments: assignmentList,
    candidateCode: input.variant.code,
    coverageWarnings,
    label: input.variant.label,
    metrics: {
      coverageWarningCount: coverageWarnings.length,
      fairnessScore,
      overtimeAssignmentCount,
      preferenceScore: assignedSeatCount === 0 ? 100 : Number(((preferenceMatches / assignedSeatCount) * 100).toFixed(1)),
      totalAssignedMinutes,
      totalLaborCost: Number(totalLaborCost.toFixed(2)),
    },
    summary: buildCandidateSummary({
      assignedSeatCount,
      coverageWarningCount: coverageWarnings.length,
      fairnessScore,
      overtimeAssignmentCount,
      totalAssignedMinutes,
      totalLaborCost,
      totalRequiredSeats,
      weekCount,
    }),
  }
}

function buildCandidateVariants(targetCandidateCount: number): CandidateVariant[] {
  const variants: CandidateVariant[] = []
  const targetVariantCount = Math.max(targetCandidateCount * 4, BASE_CANDIDATE_VARIANTS.length)

  for (let index = 0; index < targetVariantCount; index += 1) {
    const baseVariant = BASE_CANDIDATE_VARIANTS[index % BASE_CANDIDATE_VARIANTS.length]
    const cycle = Math.floor(index / BASE_CANDIDATE_VARIANTS.length)
    variants.push({
      ...baseVariant,
      code: cycle === 0 ? baseVariant.code : `${baseVariant.code}-${cycle + 1}`,
      label: cycle === 0 ? baseVariant.label : `${baseVariant.label} ${cycle + 1}`,
      preferenceWeight: Number((baseVariant.preferenceWeight + cycle * 0.08).toFixed(2)),
      repeatPenalty: baseVariant.repeatPenalty + cycle * 120,
      seed: baseVariant.seed + cycle * 11,
    })
  }

  return variants
}

function buildShiftOccurrences(input: NormalizedSolverInput): ShiftOccurrence[] {
  const weekCount = countSchedulingWeeks(input.scheduleWeek)
  const windowStartDate = parseIsoDate(input.scheduleWeek.startDate)
  const sortedShiftRequirements = [...input.shiftRequirements].sort(compareShiftRequirements)
  const occurrences: ShiftOccurrence[] = []

  for (let weekIndex = 0; weekIndex < weekCount; weekIndex += 1) {
    const weekStartDate = toIsoDate(addDays(windowStartDate, weekIndex * 7))
    for (const shiftRequirement of sortedShiftRequirements) {
      const date = toIsoDate(addDays(windowStartDate, weekIndex * 7 + WEEKDAY_ORDER.indexOf(shiftRequirement.dayOfWeek)))
      occurrences.push({
        date,
        occurrenceKey: buildOccurrenceKey(shiftRequirement.id, date),
        shiftRequirement,
        weekIndex,
        weekStartDate,
      })
    }
  }

  return occurrences
}

function compareCandidateEmployees(input: {
  assignedEmployeesByShiftSeriesWeek: Map<string, string[]>
  assignedIntervalsByEmployeeDate: Map<string, TimeInterval[]>
  assignedMinutesByEmployee: Map<string, number>
  assignedMinutesByEmployeeWeek: Map<string, number>
  input: NormalizedSolverInput
  left: NormalizedSolverInput['employees'][number]
  occurrence: ShiftOccurrence
  occurrenceIndex: number
  priorCandidates: ScheduleCandidate[]
  right: NormalizedSolverInput['employees'][number]
  seatIndex: number
  variant: CandidateVariant
}): number {
  const leftScore = computeAssignmentScore(input, input.left)
  const rightScore = computeAssignmentScore(input, input.right)
  if (leftScore !== rightScore) {
    return leftScore - rightScore
  }

  return input.left.name.localeCompare(input.right.name)
}

function computeAssignmentScore(
  input: {
    assignedEmployeesByShiftSeriesWeek: Map<string, string[]>
    assignedIntervalsByEmployeeDate: Map<string, TimeInterval[]>
    assignedMinutesByEmployee: Map<string, number>
    assignedMinutesByEmployeeWeek: Map<string, number>
    input: NormalizedSolverInput
    occurrence: ShiftOccurrence
    occurrenceIndex: number
    priorCandidates: ScheduleCandidate[]
    seatIndex: number
    variant: CandidateVariant
  },
  employee: NormalizedSolverInput['employees'][number],
): number {
  const incrementalMinutes = getIncrementalAssignedMinutes({
    assignedIntervalsByEmployeeDate: input.assignedIntervalsByEmployeeDate,
    date: input.occurrence.date,
    employeeId: employee.id,
    occurrence: input.occurrence,
  })
  const assignedMinutesTotal = input.assignedMinutesByEmployee.get(employee.id) ?? 0
  const assignedMinutesThisWeek = input.assignedMinutesByEmployeeWeek.get(buildEmployeeWeekKey(employee.id, input.occurrence.weekStartDate)) ?? 0
  const projectedMinutesThisWeek = assignedMinutesThisWeek + incrementalMinutes
  const isPreferred = employee.preferredDays.includes(input.occurrence.shiftRequirement.dayOfWeek)
    || input.occurrence.shiftRequirement.tags.some((tag) => employee.preferredShiftTags.includes(tag))
  const overtimePenalty = projectedMinutesThisWeek > employee.maxMinutesPerWeek!
    ? 10_000 + (projectedMinutesThisWeek - employee.maxMinutesPerWeek!)
    : 0
  const priorWeekEmployees = input.assignedEmployeesByShiftSeriesWeek.get(
    buildShiftSeriesWeekKey(input.occurrence.shiftRequirement.id, input.occurrence.weekIndex - 1),
  ) ?? []
  const priorBiweeklyEmployees = input.assignedEmployeesByShiftSeriesWeek.get(
    buildShiftSeriesWeekKey(input.occurrence.shiftRequirement.id, input.occurrence.weekIndex - 2),
  ) ?? []
  const weeklyStabilityScore = priorWeekEmployees.includes(employee.id)
    ? -input.variant.weeklyStabilityBonus
    : priorWeekEmployees.length > 0
      ? input.variant.weeklyStabilityPenalty
      : 0
  const biweeklyStabilityScore = priorBiweeklyEmployees.includes(employee.id)
    ? -input.variant.biweeklyStabilityBonus
    : priorBiweeklyEmployees.length > 0
      ? input.variant.biweeklyStabilityPenalty
      : 0
  const repetitionPenalty = input.priorCandidates.reduce((sum, candidate) => {
    const priorAssignment = candidate.assignments.find((assignment) => (
      assignment.shiftRequirementId === input.occurrence.shiftRequirement.id
        && resolveAssignmentDate(assignment, input.occurrence.shiftRequirement, input.input.scheduleWeek.startDate) === input.occurrence.date
    ))

    return sum + (priorAssignment?.employeeIds.includes(employee.id) ? input.variant.repeatPenalty : 0)
  }, 0)
  const diversityOffset = ((input.occurrenceIndex + input.seatIndex + input.variant.seed + hashEmployeeId(employee.id)) % 11) / 10

  return assignedMinutesThisWeek
    + assignedMinutesTotal * 0.15
    + overtimePenalty
    + repetitionPenalty
    + employee.hourlyRate * input.variant.costWeight
    + weeklyStabilityScore
    + biweeklyStabilityScore
    - (isPreferred ? 140 * input.variant.preferenceWeight : 0)
    + diversityOffset
}

function compareShiftRequirements(
  left: NormalizedSolverInput['shiftRequirements'][number],
  right: NormalizedSolverInput['shiftRequirements'][number],
): number {
  const leftWeekdayIndex = WEEKDAY_ORDER.indexOf(left.dayOfWeek)
  const rightWeekdayIndex = WEEKDAY_ORDER.indexOf(right.dayOfWeek)
  if (leftWeekdayIndex !== rightWeekdayIndex) {
    return leftWeekdayIndex - rightWeekdayIndex
  }
  if (left.startTime !== right.startTime) {
    return left.startTime.localeCompare(right.startTime)
  }
  return left.label.localeCompare(right.label)
}

function isEmployeeAvailableForShift(
  employee: NormalizedSolverInput['employees'][number],
  shiftRequirement: NormalizedSolverInput['shiftRequirements'][number],
): boolean {
  return employee.availability.some((window) => (
    window.dayOfWeek === shiftRequirement.dayOfWeek
      && window.startTime <= shiftRequirement.startTime
      && window.endTime >= shiftRequirement.endTime
  ))
}

function isEmployeeEligibleForShift(
  employee: NormalizedSolverInput['employees'][number],
  shiftRequirement: NormalizedSolverInput['shiftRequirements'][number],
): boolean {
  if (shiftRequirement.requiredQualifications.length > 0) {
    const employeeQualifications = new Set(employee.qualifications.map(normalizeMatchingKey))
    const hasAllRequiredQualifications = shiftRequirement.requiredQualifications.every((qualification) => (
      employeeQualifications.has(normalizeMatchingKey(qualification))
    ))
    if (!hasAllRequiredQualifications) {
      return false
    }
  }

  if (shiftRequirement.allowedEmployeeIds.length > 0 && !shiftRequirement.allowedEmployeeIds.includes(employee.id)) {
    return false
  }

  if (shiftRequirement.disallowedEmployeeIds.includes(employee.id)) {
    return false
  }

  return true
}

function carryForwardEmployeesIntoOccurrence(input: {
  assignments: Map<string, string[]>
  assignedOccurrenceKeysByEmployee: Map<string, string[]>
  continuity: ContinuityIndex
  input: NormalizedSolverInput
  occurrence: ShiftOccurrence
  occurrenceByKey: Map<string, ShiftOccurrence>
}): string[] {
  const incomingLink = input.continuity.incomingByOccurrenceKey.get(input.occurrence.occurrenceKey)
  if (!incomingLink) {
    return []
  }

  const priorEmployeeIds = input.assignments.get(incomingLink.previousOccurrenceKey) ?? []
  const carriedEmployeeIds: string[] = []

  for (const employeeId of priorEmployeeIds.slice(0, incomingLink.carryForwardSeatCount)) {
    const employee = input.input.employees.find((candidate) => candidate.id === employeeId)
    if (!employee) {
      continue
    }

    if (!isEmployeeAvailableForShift(employee, input.occurrence.shiftRequirement) || !isEmployeeEligibleForShift(employee, input.occurrence.shiftRequirement)) {
      continue
    }

    if (!hasShiftOverlap(employee.id, input.occurrence, input.occurrenceByKey, input.assignedOccurrenceKeysByEmployee, input.continuity)) {
      carriedEmployeeIds.push(employee.id)
    }
  }

  return carriedEmployeeIds
}

function canEmployeeSatisfyContinuityChain(
  employee: NormalizedSolverInput['employees'][number],
  occurrence: ShiftOccurrence,
  occurrenceByKey: Map<string, ShiftOccurrence>,
  continuity: ContinuityIndex,
): boolean {
  let currentOccurrence = occurrence
  let outgoingLink = continuity.outgoingByOccurrenceKey.get(currentOccurrence.occurrenceKey)

  while (outgoingLink) {
    const nextOccurrence = occurrenceByKey.get(outgoingLink.nextOccurrenceKey)
    if (!nextOccurrence) {
      return false
    }

    if (!isEmployeeAvailableForShift(employee, nextOccurrence.shiftRequirement) || !isEmployeeEligibleForShift(employee, nextOccurrence.shiftRequirement)) {
      return false
    }

    currentOccurrence = nextOccurrence
    outgoingLink = continuity.outgoingByOccurrenceKey.get(currentOccurrence.occurrenceKey)
  }

  return true
}

function buildContinuityIndex(occurrences: ShiftOccurrence[]): ContinuityIndex {
  const incomingByOccurrenceKey = new Map<string, ContinuityLink>()
  const linkedOccurrenceKeysByOccurrenceKey = new Map<string, Set<string>>()
  const outgoingByOccurrenceKey = new Map<string, ContinuityLink>()
  const lastOccurrenceByExplicitGroup = new Map<string, ShiftOccurrence>()
  const lastOpeningOccurrenceByQualificationKey = new Map<string, ShiftOccurrence>()
  let activeDate: string | null = null

  for (const occurrence of occurrences) {
    if (occurrence.date !== activeDate) {
      activeDate = occurrence.date
      lastOccurrenceByExplicitGroup.clear()
      lastOpeningOccurrenceByQualificationKey.clear()
    }

    const explicitGroupKey = normalizeOptionalMatchingKey(occurrence.shiftRequirement.continuityGroup)
    const qualificationKey = buildQualificationKey(occurrence.shiftRequirement.requiredQualifications)
    const predecessor = explicitGroupKey
      ? lastOccurrenceByExplicitGroup.get(explicitGroupKey)
      : qualificationKey
        ? lastOpeningOccurrenceByQualificationKey.get(qualificationKey)
        : undefined

    if (
      predecessor
      && predecessor.date === occurrence.date
      && intervalsTouchOrOverlap(
        buildShiftInterval(predecessor.shiftRequirement.startTime, predecessor.shiftRequirement.endTime),
        buildShiftInterval(occurrence.shiftRequirement.startTime, occurrence.shiftRequirement.endTime),
      )
    ) {
      const link: ContinuityLink = {
        carryForwardSeatCount: Math.min(predecessor.shiftRequirement.requiredHeadcount, occurrence.shiftRequirement.requiredHeadcount),
        nextOccurrenceKey: occurrence.occurrenceKey,
        previousOccurrenceKey: predecessor.occurrenceKey,
      }
      incomingByOccurrenceKey.set(occurrence.occurrenceKey, link)
      outgoingByOccurrenceKey.set(predecessor.occurrenceKey, link)
      addLinkedOccurrenceKey(linkedOccurrenceKeysByOccurrenceKey, predecessor.occurrenceKey, occurrence.occurrenceKey)
      addLinkedOccurrenceKey(linkedOccurrenceKeysByOccurrenceKey, occurrence.occurrenceKey, predecessor.occurrenceKey)
    }

    if (explicitGroupKey) {
      lastOccurrenceByExplicitGroup.set(explicitGroupKey, occurrence)
    }
    if (qualificationKey && isOpeningPassiveShift(occurrence.shiftRequirement)) {
      lastOpeningOccurrenceByQualificationKey.set(qualificationKey, occurrence)
    }
  }

  return { incomingByOccurrenceKey, linkedOccurrenceKeysByOccurrenceKey, outgoingByOccurrenceKey }
}

function buildQualificationKey(qualifications: string[]): string | null {
  const normalizedQualifications = qualifications.map(normalizeMatchingKey).filter((value) => value.length > 0).sort()
  if (normalizedQualifications.length === 0) {
    return null
  }

  return normalizedQualifications.join('|')
}

function isOpeningPassiveShift(shiftRequirement: NormalizedSolverInput['shiftRequirements'][number]): boolean {
  return [shiftRequirement.label, shiftRequirement.roleLabel ?? '', ...shiftRequirement.tags]
    .some((value) => /(^|[^a-z])(open|opening|passive)([^a-z]|$)/i.test(value))
}

function normalizeMatchingKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizeOptionalMatchingKey(value: string | null): string | null {
  if (value === null) {
    return null
  }

  const normalized = normalizeMatchingKey(value)
  return normalized.length > 0 ? normalized : null
}

function hasShiftOverlap(
  employeeId: string,
  nextOccurrence: ShiftOccurrence,
  occurrenceByKey: Map<string, ShiftOccurrence>,
  assignedOccurrenceKeysByEmployee: Map<string, string[]>,
  continuity: ContinuityIndex,
): boolean {
  const assignedOccurrenceKeys = assignedOccurrenceKeysByEmployee.get(employeeId) ?? []

  return assignedOccurrenceKeys.some((assignedOccurrenceKey) => {
    if (continuity.linkedOccurrenceKeysByOccurrenceKey.get(assignedOccurrenceKey)?.has(nextOccurrence.occurrenceKey)) {
      return false
    }

    const assignedOccurrence = occurrenceByKey.get(assignedOccurrenceKey)
    if (!assignedOccurrence || assignedOccurrence.date !== nextOccurrence.date) {
      return false
    }

    return timesOverlap(
      buildShiftInterval(assignedOccurrence.shiftRequirement.startTime, assignedOccurrence.shiftRequirement.endTime),
      buildShiftInterval(nextOccurrence.shiftRequirement.startTime, nextOccurrence.shiftRequirement.endTime),
    )
  })
}

function recordAssignedInterval(input: {
  assignedIntervalsByEmployeeDate: Map<string, TimeInterval[]>
  date: string
  employeeId: string
  occurrence: ShiftOccurrence
}): number {
  const key = buildEmployeeDateKey(input.employeeId, input.date)
  const existingIntervals = input.assignedIntervalsByEmployeeDate.get(key) ?? []
  const beforeMinutes = sumIntervalMinutes(existingIntervals)
  const nextIntervals = mergeIntervals([...existingIntervals, buildShiftInterval(input.occurrence.shiftRequirement.startTime, input.occurrence.shiftRequirement.endTime)])
  input.assignedIntervalsByEmployeeDate.set(key, nextIntervals)
  return sumIntervalMinutes(nextIntervals) - beforeMinutes
}

function getIncrementalAssignedMinutes(input: {
  assignedIntervalsByEmployeeDate: Map<string, TimeInterval[]>
  date: string
  employeeId: string
  occurrence: ShiftOccurrence
}): number {
  const key = buildEmployeeDateKey(input.employeeId, input.date)
  const existingIntervals = input.assignedIntervalsByEmployeeDate.get(key) ?? []
  const beforeMinutes = sumIntervalMinutes(existingIntervals)
  const nextIntervals = mergeIntervals([...existingIntervals, buildShiftInterval(input.occurrence.shiftRequirement.startTime, input.occurrence.shiftRequirement.endTime)])
  return sumIntervalMinutes(nextIntervals) - beforeMinutes
}

function resolveAssignmentDate(
  assignment: ScheduleCandidate['assignments'][number],
  shiftRequirement: NormalizedSolverInput['shiftRequirements'][number],
  defaultWeekStartDate: string,
): string {
  if (assignment.date) {
    return assignment.date
  }

  return toIsoDate(addDays(parseIsoDate(defaultWeekStartDate), WEEKDAY_ORDER.indexOf(shiftRequirement.dayOfWeek)))
}

function buildOccurrenceKey(shiftRequirementId: string, date: string): string {
  return `${shiftRequirementId}:${date}`
}

function buildShiftSeriesWeekKey(shiftRequirementId: string, weekIndex: number): string {
  return `${shiftRequirementId}:${weekIndex}`
}

function buildEmployeeWeekKey(employeeId: string, weekStartDate: string): string {
  return `${employeeId}::${weekStartDate}`
}

function buildEmployeeDateKey(employeeId: string, date: string): string {
  return `${employeeId}::${date}`
}

function timesOverlap(left: TimeInterval, right: TimeInterval): boolean {
  return left.startMinute < right.endMinute && right.startMinute < left.endMinute
}

function buildShiftInterval(startTime: string, endTime: string): TimeInterval {
  const startMinute = parseClockMinutes(startTime)
  let endMinute = parseClockMinutes(endTime)
  if (endMinute <= startMinute) {
    endMinute += 24 * 60
  }

  return { endMinute, startMinute }
}

function intervalsTouchOrOverlap(left: TimeInterval, right: TimeInterval): boolean {
  return left.startMinute <= right.endMinute && right.startMinute <= left.endMinute
}

function parseClockMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map((part) => Number.parseInt(part, 10))
  return hours * 60 + minutes
}

function mergeIntervals(intervals: TimeInterval[]): TimeInterval[] {
  if (intervals.length <= 1) {
    return intervals.map((interval) => ({ ...interval }))
  }

  const sortedIntervals = [...intervals].sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute)
  const merged: TimeInterval[] = [{ ...sortedIntervals[0]! }]

  for (const interval of sortedIntervals.slice(1)) {
    const currentInterval = merged[merged.length - 1]!
    if (interval.startMinute <= currentInterval.endMinute) {
      currentInterval.endMinute = Math.max(currentInterval.endMinute, interval.endMinute)
      continue
    }

    merged.push({ ...interval })
  }

  return merged
}

function sumIntervalMinutes(intervals: TimeInterval[]): number {
  return intervals.reduce((sum, interval) => sum + Math.max(0, interval.endMinute - interval.startMinute), 0)
}

function addLinkedOccurrenceKey(linkedKeysByOccurrenceKey: Map<string, Set<string>>, occurrenceKey: string, linkedOccurrenceKey: string): void {
  const linkedKeys = linkedKeysByOccurrenceKey.get(occurrenceKey) ?? new Set<string>()
  linkedKeys.add(linkedOccurrenceKey)
  linkedKeysByOccurrenceKey.set(occurrenceKey, linkedKeys)
}

function calculateFairnessScore(values: number[]): number {
  if (values.length === 0) {
    return 100
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  if (mean === 0) {
    return 100
  }
  const meanAbsoluteDeviation = values.reduce((sum, value) => sum + Math.abs(value - mean), 0) / values.length
  return Number(Math.max(0, 100 - (meanAbsoluteDeviation / mean) * 100).toFixed(1))
}

function buildCandidateSummary(input: {
  assignedSeatCount: number
  coverageWarningCount: number
  fairnessScore: number
  overtimeAssignmentCount: number
  totalAssignedMinutes: number
  totalLaborCost: number
  totalRequiredSeats: number
  weekCount: number
}): string {
  return [
    `${input.assignedSeatCount}/${input.totalRequiredSeats} seats filled`,
    `${formatHoursWithTotal(input.totalAssignedMinutes / input.weekCount / 60, input.totalAssignedMinutes / 60)} scheduled`,
    `${formatCurrencyWithTotal(input.totalLaborCost / input.weekCount, input.totalLaborCost)} payroll`,
    `${input.fairnessScore.toFixed(1)} fairness`,
    `${input.weekCount} week${input.weekCount === 1 ? '' : 's'}`,
    input.coverageWarningCount > 0 ? `${input.coverageWarningCount} coverage warning${input.coverageWarningCount === 1 ? '' : 's'}` : null,
    input.overtimeAssignmentCount > 0 ? `${input.overtimeAssignmentCount} overtime flag${input.overtimeAssignmentCount === 1 ? '' : 's'}` : null,
  ].filter((part): part is string => part !== null).join(' · ')
}

function formatHoursWithTotal(averageHoursPerWeek: number, totalHours: number): string {
  return `${averageHoursPerWeek.toFixed(1)}h/week (${totalHours.toFixed(1)}h total)`
}

function formatCurrencyWithTotal(averageAmountPerWeek: number, totalAmount: number): string {
  return `$${averageAmountPerWeek.toFixed(2)}/week ($${totalAmount.toFixed(2)} total)`
}

function hashEmployeeId(value: string): number {
  return [...value].reduce((sum, character) => sum + character.charCodeAt(0), 0)
}

function parseIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`)
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}
