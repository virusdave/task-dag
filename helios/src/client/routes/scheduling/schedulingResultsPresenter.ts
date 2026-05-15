import { countSchedulingWeeks, type NormalizedSolverInput, type ScheduleCandidate, type SchedulingWeekday } from '../../../shared/contracts/index.js'

const WEEKDAY_ORDER: SchedulingWeekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

const WEEKDAY_LABEL_FORMATTER = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
  weekday: 'short',
})

const DAY_TITLE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
  weekday: 'long',
  year: 'numeric',
})

const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  timeZone: 'UTC',
  year: 'numeric',
})

const WEEK_RANGE_LABEL_FORMATTER = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})

export interface SchedulingEmployeeColor {
  background: string
  border: string
  text: string
}

export interface PresentedEmployee {
  color: SchedulingEmployeeColor
  id: string
  name: string
}

export interface PresentedShiftAssignment {
  assignedEmployees: PresentedEmployee[]
  date: string
  dateLabel: string
  endTime: string
  employeeIds: string[]
  label: string
  occurrenceKey: string
  requiredHeadcount: number
  roleLabel: string | null
  shiftRequirementId: string
  startTime: string
  tags: string[]
  timeLabel: string
  unfilledSeatCount: number
}

export interface PresentedDay {
  assignedEmployees: PresentedEmployee[]
  assignments: PresentedShiftAssignment[]
  date: string
  label: string
  titleLabel: string
}

export interface PresentedMonthDay {
  assignedEmployees: PresentedEmployee[]
  assignments: PresentedShiftAssignment[]
  date: string
  dayNumberLabel: string
  isCurrentMonth: boolean
  isScheduledWeek: boolean
  titleLabel: string
}

export interface PresentedMonth {
  label: string
  weeks: PresentedMonthDay[][]
}

export interface PresentedShiftLaneCell {
  assignments: PresentedShiftAssignment[]
  date: string
}

export interface PresentedShiftLane {
  cells: PresentedShiftLaneCell[]
  key: string
  label: string
  roleLabel: string | null
  tags: string[]
  timeLabel: string
}

export interface PresentedCoverageWarning {
  date: string
  dateLabel: string
  message: string
  shiftLabel: string
}

export interface PresentedHoursSummaryEmployee {
  averageHoursPerWeek: number
  employee: PresentedEmployee
}

export interface PresentedHoursSummary {
  averageScheduledHoursPerWeek: number
  bottomEmployees: PresentedHoursSummaryEmployee[]
  topEmployees: PresentedHoursSummaryEmployee[]
}

export interface PresentedHoursCostWeek {
  laborCost: number
  scheduledHours: number
  weekEndDate: string
  weekLabel: string
  weekStartDate: string
}

export interface PresentedHoursCostEmployee {
  averageHoursPerWeek: number
  averageLaborCostPerWeek: number
  employee: PresentedEmployee
  totalLaborCost: number
  totalScheduledHours: number
  weeks: PresentedHoursCostWeek[]
}

export interface PresentedHoursCostSummary {
  averageLaborCostPerWeek: number
  averageScheduledHoursPerWeek: number
  employees: PresentedHoursCostEmployee[]
  totalLaborCost: number
  totalScheduledHours: number
}

export interface SchedulingCandidatePresentation {
  coverageWarnings: PresentedCoverageWarning[]
  days: PresentedDay[]
  employeeLegend: PresentedEmployee[]
  hoursCostSummary: PresentedHoursCostSummary
  hoursSummary: PresentedHoursSummary
  months: PresentedMonth[]
  shiftLanes: PresentedShiftLane[]
}

interface SchedulingCandidateCsvRow {
  assignedEmployeeIds: string
  assignedEmployeeNames: string
  assignedSeatCount: string
  candidateId: string
  candidateLabel: string
  candidateSummary: string
  requiredHeadcount: string
  roleLabel: string
  runId: string
  scheduleWindowEnd: string
  scheduleWindowStart: string
  shiftDate: string
  shiftDay: string
  shiftLabel: string
  shiftTags: string
  timeLabel: string
  unfilledSeatCount: string
}

interface ShiftOccurrence {
  date: string
  occurrenceKey: string
  shiftRequirement: NormalizedSolverInput['shiftRequirements'][number]
  weekStartDate: string
}

interface TimeInterval {
  endMinute: number
  startMinute: number
}

export function buildSchedulingCandidatePresentation(input: {
  candidateId: number
  normalizedInput: NormalizedSolverInput
  runId: number
  schedule: ScheduleCandidate
}): SchedulingCandidatePresentation {
  const employeeById = new Map(
    input.normalizedInput.employees.map((employee) => [
      employee.id,
      {
        color: buildEmployeeColor(`${input.runId}:${employee.id}`),
        id: employee.id,
        name: employee.name,
      } satisfies PresentedEmployee,
    ]),
  )
  const shiftRequirementById = new Map(input.normalizedInput.shiftRequirements.map((shiftRequirement) => [shiftRequirement.id, shiftRequirement]))
  const shiftOccurrences = buildShiftOccurrences(input.normalizedInput)
  const assignmentByOccurrenceKey = new Map(
    input.schedule.assignments.map((assignment) => {
      const shiftRequirement = shiftRequirementById.get(assignment.shiftRequirementId)
      if (!shiftRequirement) {
        return null
      }

      const date = resolveAssignmentDate(assignment, shiftRequirement, input.normalizedInput.scheduleWeek.startDate)
      return [buildOccurrenceKey(assignment.shiftRequirementId, date), assignment] as const
    }).filter((entry): entry is readonly [string, ScheduleCandidate['assignments'][number]] => entry !== null),
  )
  const assignmentsByDate = new Map<string, PresentedShiftAssignment[]>()
  const scheduledDateSet = new Set(shiftOccurrences.map((occurrence) => occurrence.date))

  const presentedAssignments = shiftOccurrences.map((occurrence) => {
    const assignment = assignmentByOccurrenceKey.get(occurrence.occurrenceKey)
    const employeeIds = assignment?.employeeIds ?? []
    const assignedEmployees = employeeIds
      .map((employeeId) => employeeById.get(employeeId))
      .filter((employee): employee is PresentedEmployee => employee !== undefined)

    const presentedAssignment = {
      assignedEmployees,
      date: occurrence.date,
      dateLabel: formatDateLabel(occurrence.date),
      endTime: occurrence.shiftRequirement.endTime,
      employeeIds,
      label: occurrence.shiftRequirement.label,
      occurrenceKey: occurrence.occurrenceKey,
      requiredHeadcount: occurrence.shiftRequirement.requiredHeadcount,
      roleLabel: occurrence.shiftRequirement.roleLabel,
      shiftRequirementId: occurrence.shiftRequirement.id,
      startTime: occurrence.shiftRequirement.startTime,
      tags: occurrence.shiftRequirement.tags,
      timeLabel: `${formatClockLabel(occurrence.shiftRequirement.startTime)} - ${formatClockLabel(occurrence.shiftRequirement.endTime)}`,
      unfilledSeatCount: Math.max(occurrence.shiftRequirement.requiredHeadcount - employeeIds.length, 0),
    } satisfies PresentedShiftAssignment

    assignmentsByDate.set(occurrence.date, [...(assignmentsByDate.get(occurrence.date) ?? []), presentedAssignment])
    return presentedAssignment
  })

  const days = buildScheduleWindowDates(input.normalizedInput.scheduleWeek).map((date) => {
    const assignments = assignmentsByDate.get(date) ?? []
    return {
      assignedEmployees: dedupeEmployees(assignments.flatMap((assignment) => assignment.assignedEmployees)),
      assignments,
      date,
      label: formatDateLabel(date),
      titleLabel: formatDayTitle(date),
    } satisfies PresentedDay
  })

  const hourlyRateByEmployeeId = new Map(input.normalizedInput.employees.map((employee) => [employee.id, employee.hourlyRate]))
  const hoursCostSummary = buildHoursCostSummary(days, employeeById, hourlyRateByEmployeeId, input.normalizedInput.scheduleWeek)

  return {
    coverageWarnings: input.schedule.coverageWarnings.map((warning) => {
      const shiftRequirement = shiftRequirementById.get(warning.shiftRequirementId)
      const warningDate = warning.date ?? (shiftRequirement
        ? toIsoDate(addDays(parseIsoDate(input.normalizedInput.scheduleWeek.startDate), WEEKDAY_ORDER.indexOf(shiftRequirement.dayOfWeek)))
        : input.normalizedInput.scheduleWeek.startDate)
      return {
        date: warningDate,
        dateLabel: formatDateLabel(warningDate),
        message: warning.message,
        shiftLabel: shiftRequirement?.label ?? warning.shiftRequirementId,
      }
    }),
    days,
    employeeLegend: dedupeEmployees(presentedAssignments.flatMap((assignment) => assignment.assignedEmployees)).sort((left, right) => left.name.localeCompare(right.name)),
    hoursCostSummary,
    hoursSummary: buildHoursSummary(hoursCostSummary),
    months: buildPresentedMonths(assignmentsByDate, employeeById, scheduledDateSet, input.normalizedInput.scheduleWeek),
    shiftLanes: buildShiftLanes(days, presentedAssignments),
  }
}

export function buildSchedulingCandidateCsv(input: {
  candidateId: number
  candidateLabel: string
  candidateSummary: string
  presentation: SchedulingCandidatePresentation
  runId: number
  scheduleWeek: NormalizedSolverInput['scheduleWeek']
}): string {
  const rows: SchedulingCandidateCsvRow[] = input.presentation.days.flatMap((day) => day.assignments.map((assignment) => ({
    assignedEmployeeIds: assignment.employeeIds.join('; '),
    assignedEmployeeNames: assignment.assignedEmployees.map((employee) => employee.name).join('; '),
    assignedSeatCount: String(assignment.assignedEmployees.length),
    candidateId: String(input.candidateId),
    candidateLabel: input.candidateLabel,
    candidateSummary: input.candidateSummary,
    requiredHeadcount: String(assignment.requiredHeadcount),
    roleLabel: assignment.roleLabel ?? '',
    runId: String(input.runId),
    scheduleWindowEnd: input.scheduleWeek.endDate,
    scheduleWindowStart: input.scheduleWeek.startDate,
    shiftDate: assignment.date,
    shiftDay: day.titleLabel,
    shiftLabel: assignment.label,
    shiftTags: assignment.tags.join('; '),
    timeLabel: assignment.timeLabel,
    unfilledSeatCount: String(assignment.unfilledSeatCount),
  })))

  const headers: Array<keyof SchedulingCandidateCsvRow> = [
    'runId',
    'candidateId',
    'candidateLabel',
    'candidateSummary',
    'scheduleWindowStart',
    'scheduleWindowEnd',
    'shiftDate',
    'shiftDay',
    'shiftLabel',
    'roleLabel',
    'timeLabel',
    'shiftTags',
    'requiredHeadcount',
    'assignedSeatCount',
    'unfilledSeatCount',
    'assignedEmployeeNames',
    'assignedEmployeeIds',
  ]

  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => escapeCsvCell(row[header])).join(',')),
  ].join('\n')
}

export function buildSchedulingCandidateSummaryText(input: {
  presentation: SchedulingCandidatePresentation
  schedule: ScheduleCandidate
}): string {
  const assignedSeatCount = input.schedule.assignments.reduce((sum, assignment) => sum + assignment.employeeIds.length, 0)
  const totalRequiredSeats = input.presentation.days.reduce(
    (sum, day) => sum + day.assignments.reduce((daySum, assignment) => daySum + assignment.requiredHeadcount, 0),
    0,
  )

  return [
    `${assignedSeatCount}/${totalRequiredSeats} seats filled`,
    `${formatHoursWithTotal(input.presentation.hoursCostSummary.averageScheduledHoursPerWeek, input.presentation.hoursCostSummary.totalScheduledHours)} scheduled`,
    `${formatCurrencyWithTotal(input.presentation.hoursCostSummary.averageLaborCostPerWeek, input.presentation.hoursCostSummary.totalLaborCost)} payroll`,
    `${input.schedule.metrics.fairnessScore.toFixed(1)} fairness`,
    input.schedule.metrics.coverageWarningCount > 0
      ? `${input.schedule.metrics.coverageWarningCount} coverage warning${input.schedule.metrics.coverageWarningCount === 1 ? '' : 's'}`
      : null,
    input.schedule.metrics.overtimeAssignmentCount > 0
      ? `${input.schedule.metrics.overtimeAssignmentCount} overtime flag${input.schedule.metrics.overtimeAssignmentCount === 1 ? '' : 's'}`
      : null,
  ].filter((part): part is string => part !== null).join(' · ')
}

export function formatHoursWithTotal(averageHoursPerWeek: number, totalHours: number): string {
  return `${averageHoursPerWeek.toFixed(1)}h/week (${totalHours.toFixed(1)}h total)`
}

export function formatCurrencyWithTotal(averageAmountPerWeek: number, totalAmount: number): string {
  return `$${averageAmountPerWeek.toFixed(2)}/week ($${totalAmount.toFixed(2)} total)`
}

function buildShiftLanes(days: PresentedDay[], assignments: PresentedShiftAssignment[]): PresentedShiftLane[] {
  const laneMap = new Map<string, Omit<PresentedShiftLane, 'cells'> & { assignmentsByDate: Map<string, PresentedShiftAssignment[]> }>()

  assignments.forEach((assignment) => {
    const laneKey = [assignment.label, assignment.roleLabel ?? '', assignment.timeLabel, assignment.tags.join('|')].join('::')
    const existingLane = laneMap.get(laneKey)
    if (existingLane) {
      existingLane.assignmentsByDate.set(assignment.date, [...(existingLane.assignmentsByDate.get(assignment.date) ?? []), assignment])
      return
    }

    laneMap.set(laneKey, {
      assignmentsByDate: new Map([[assignment.date, [assignment]]]),
      key: laneKey,
      label: assignment.label,
      roleLabel: assignment.roleLabel,
      tags: assignment.tags,
      timeLabel: assignment.timeLabel,
    })
  })

  return [...laneMap.values()]
    .sort((left, right) => compareLaneMeta(left, right))
    .map((lane) => ({
      cells: days.map((day) => ({
        assignments: lane.assignmentsByDate.get(day.date) ?? [],
        date: day.date,
      })),
      key: lane.key,
      label: lane.label,
      roleLabel: lane.roleLabel,
      tags: lane.tags,
      timeLabel: lane.timeLabel,
    }))
}

function escapeCsvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`
  }

  return value
}

function buildPresentedMonths(
  assignmentsByDate: Map<string, PresentedShiftAssignment[]>,
  employeeById: Map<string, PresentedEmployee>,
  scheduledDateSet: Set<string>,
  scheduleWeek: NormalizedSolverInput['scheduleWeek'],
): PresentedMonth[] {
  const monthStarts = buildTouchedMonthStarts(scheduleWeek.startDate, scheduleWeek.endDate)

  return monthStarts.map((monthStartDate) => {
    const monthEndDate = endOfMonth(monthStartDate)
    const gridStartDate = addDays(monthStartDate, -monthStartDate.getUTCDay())
    const gridEndDate = addDays(monthEndDate, 6 - monthEndDate.getUTCDay())
    const weeks: PresentedMonthDay[][] = []
    let currentWeek: PresentedMonthDay[] = []

    for (let cursor = new Date(gridStartDate); cursor <= gridEndDate; cursor = addDays(cursor, 1)) {
      const date = toIsoDate(cursor)
      const assignments = assignmentsByDate.get(date) ?? []
      currentWeek.push({
        assignedEmployees: dedupeEmployees(assignments.flatMap((assignment) => assignment.employeeIds.map((employeeId) => employeeById.get(employeeId)).filter((employee): employee is PresentedEmployee => employee !== undefined))),
        assignments,
        date,
        dayNumberLabel: String(cursor.getUTCDate()),
        isCurrentMonth: cursor.getUTCMonth() === monthStartDate.getUTCMonth(),
        isScheduledWeek: scheduledDateSet.has(date),
        titleLabel: formatDayTitle(date),
      })

      if (currentWeek.length === 7) {
        weeks.push(currentWeek)
        currentWeek = []
      }
    }

    return {
      label: MONTH_LABEL_FORMATTER.format(monthStartDate),
      weeks,
    }
  })
}

function buildHoursSummary(hoursCostSummary: PresentedHoursCostSummary): PresentedHoursSummary {
  const employeesByAverageHours = [...hoursCostSummary.employees]
    .map((employee) => ({
      averageHoursPerWeek: employee.averageHoursPerWeek,
      employee: employee.employee,
    } satisfies PresentedHoursSummaryEmployee))
    .sort((left, right) => right.averageHoursPerWeek - left.averageHoursPerWeek || left.employee.name.localeCompare(right.employee.name))

  const bottomEmployees = [...employeesByAverageHours]
    .slice()
    .reverse()
    .slice(0, Math.min(2, employeesByAverageHours.length))
    .sort((left, right) => left.averageHoursPerWeek - right.averageHoursPerWeek || left.employee.name.localeCompare(right.employee.name))

  return {
    averageScheduledHoursPerWeek: hoursCostSummary.averageScheduledHoursPerWeek,
    bottomEmployees,
    topEmployees: employeesByAverageHours.slice(0, Math.min(2, employeesByAverageHours.length)),
  }
}

function buildHoursCostSummary(
  days: PresentedDay[],
  employeeById: Map<string, PresentedEmployee>,
  hourlyRateByEmployeeId: Map<string, number>,
  scheduleWeek: NormalizedSolverInput['scheduleWeek'],
): PresentedHoursCostSummary {
  const weekCount = countSchedulingWeeks(scheduleWeek)
  const weekStartDates = buildWeekStartDates(scheduleWeek.startDate, weekCount)
  const assignedIntervalsByEmployeeDate = new Map<string, TimeInterval[]>()
  const employeeMinutesByWeek = new Map<string, number>()
  const employeeLaborCostByWeek = new Map<string, number>()
  let totalMinutes = 0
  let totalLaborCost = 0

  days.forEach((day) => {
    const weekStartDate = getWeekStartDate(day.date)
    day.assignments.forEach((assignment) => {
      const shiftInterval = buildShiftInterval(assignment.startTime, assignment.endTime)
      assignment.employeeIds.forEach((employeeId) => {
        const hourlyRate = hourlyRateByEmployeeId.get(employeeId) ?? 0
        const durationMinutes = recordAssignedInterval({
          assignedIntervalsByEmployeeDate,
          date: day.date,
          employeeId,
          shiftInterval,
        })
        const laborCost = durationMinutes / 60 * hourlyRate
        const employeeWeekKey = `${employeeId}::${weekStartDate}`
        employeeMinutesByWeek.set(employeeWeekKey, (employeeMinutesByWeek.get(employeeWeekKey) ?? 0) + durationMinutes)
        employeeLaborCostByWeek.set(employeeWeekKey, (employeeLaborCostByWeek.get(employeeWeekKey) ?? 0) + laborCost)
        totalMinutes += durationMinutes
        totalLaborCost += laborCost
      })
    })
  })

  const employees = [...employeeById.values()]
    .map((employee) => {
      const weeks = weekStartDates.map((weekStartDate) => {
        const weekKey = `${employee.id}::${weekStartDate}`
        const weekEndDate = toIsoDate(addDays(parseIsoDate(weekStartDate), 6))
        return {
          laborCost: Number((employeeLaborCostByWeek.get(weekKey) ?? 0).toFixed(2)),
          scheduledHours: Number((((employeeMinutesByWeek.get(weekKey) ?? 0) / 60)).toFixed(1)),
          weekEndDate,
          weekLabel: formatWeekRangeLabel(weekStartDate, weekEndDate),
          weekStartDate,
        } satisfies PresentedHoursCostWeek
      })

      const employeeTotalMinutes = weekStartDates.reduce((sum, weekStartDate) => sum + (employeeMinutesByWeek.get(`${employee.id}::${weekStartDate}`) ?? 0), 0)
      const employeeTotalLaborCost = weekStartDates.reduce((sum, weekStartDate) => sum + (employeeLaborCostByWeek.get(`${employee.id}::${weekStartDate}`) ?? 0), 0)

      return {
        averageHoursPerWeek: Number((employeeTotalMinutes / weekCount / 60).toFixed(1)),
        averageLaborCostPerWeek: Number((employeeTotalLaborCost / weekCount).toFixed(2)),
        employee,
        totalLaborCost: Number(employeeTotalLaborCost.toFixed(2)),
        totalScheduledHours: Number((employeeTotalMinutes / 60).toFixed(1)),
        weeks,
      } satisfies PresentedHoursCostEmployee
    })
    .sort((left, right) => right.totalScheduledHours - left.totalScheduledHours || left.employee.name.localeCompare(right.employee.name))

  return {
    averageLaborCostPerWeek: Number((totalLaborCost / weekCount).toFixed(2)),
    averageScheduledHoursPerWeek: Number((totalMinutes / weekCount / 60).toFixed(1)),
    employees,
    totalLaborCost: Number(totalLaborCost.toFixed(2)),
    totalScheduledHours: Number((totalMinutes / 60).toFixed(1)),
  }
}

function buildShiftOccurrences(input: NormalizedSolverInput): ShiftOccurrence[] {
  const weekCount = countSchedulingWeeks(input.scheduleWeek)
  const scheduleStartDate = parseIsoDate(input.scheduleWeek.startDate)
  const sortedShiftRequirements = [...input.shiftRequirements].sort(compareShiftRequirements)

  return Array.from({ length: weekCount }, (_, weekIndex) => {
    const weekStartDate = toIsoDate(addDays(scheduleStartDate, weekIndex * 7))
    return sortedShiftRequirements.map((shiftRequirement) => {
      const date = toIsoDate(addDays(scheduleStartDate, weekIndex * 7 + WEEKDAY_ORDER.indexOf(shiftRequirement.dayOfWeek)))
      return {
        date,
        occurrenceKey: buildOccurrenceKey(shiftRequirement.id, date),
        shiftRequirement,
        weekStartDate,
      } satisfies ShiftOccurrence
    })
  }).flat()
}

function buildScheduleWindowDates(scheduleWeek: NormalizedSolverInput['scheduleWeek']): string[] {
  const dates: string[] = []
  for (let cursor = parseIsoDate(scheduleWeek.startDate); cursor <= parseIsoDate(scheduleWeek.endDate); cursor = addDays(cursor, 1)) {
    dates.push(toIsoDate(cursor))
  }
  return dates
}

function buildWeekStartDates(startDate: string, weekCount: number): string[] {
  const parsedStartDate = parseIsoDate(startDate)
  return Array.from({ length: weekCount }, (_, weekIndex) => toIsoDate(addDays(parsedStartDate, weekIndex * 7)))
}

function buildTouchedMonthStarts(startDate: string, endDate: string): Date[] {
  const monthStarts: Date[] = []
  let cursor = startOfMonth(parseIsoDate(startDate))
  const endMonth = startOfMonth(parseIsoDate(endDate))

  while (cursor <= endMonth) {
    monthStarts.push(new Date(cursor))
    cursor = cursor.getUTCMonth() === 11
      ? new Date(Date.UTC(cursor.getUTCFullYear() + 1, 0, 1))
      : new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
  }

  return monthStarts
}

function dedupeEmployees(employees: PresentedEmployee[]): PresentedEmployee[] {
  const seen = new Set<string>()
  return employees.filter((employee) => {
    if (seen.has(employee.id)) {
      return false
    }
    seen.add(employee.id)
    return true
  })
}

function buildEmployeeColor(seed: string): SchedulingEmployeeColor {
  const hash = hashValue(seed)
  const hue = hash % 360
  const saturation = 62 + (hash % 11)
  const lightness = 24 + (hash % 8)
  return {
    background: `hsla(${hue} ${saturation}% ${lightness}% / 0.32)`,
    border: `hsl(${hue} ${Math.min(saturation + 12, 92)}% ${Math.min(lightness + 26, 72)}%)`,
    text: `hsl(${hue} 100% 94%)`,
  }
}

function hashValue(value: string): number {
  let hash = 0
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  }
  return hash
}

function compareShiftRequirements(
  left: NormalizedSolverInput['shiftRequirements'][number],
  right: NormalizedSolverInput['shiftRequirements'][number],
): number {
  const dayDifference = WEEKDAY_ORDER.indexOf(left.dayOfWeek) - WEEKDAY_ORDER.indexOf(right.dayOfWeek)
  if (dayDifference !== 0) {
    return dayDifference
  }
  if (left.startTime !== right.startTime) {
    return left.startTime.localeCompare(right.startTime)
  }
  return left.label.localeCompare(right.label)
}

function compareLaneMeta(
  left: Pick<PresentedShiftLane, 'label' | 'roleLabel' | 'timeLabel'>,
  right: Pick<PresentedShiftLane, 'label' | 'roleLabel' | 'timeLabel'>,
): number {
  if (left.timeLabel !== right.timeLabel) {
    return left.timeLabel.localeCompare(right.timeLabel)
  }
  if ((left.roleLabel ?? '') !== (right.roleLabel ?? '')) {
    return (left.roleLabel ?? '').localeCompare(right.roleLabel ?? '')
  }
  return left.label.localeCompare(right.label)
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

function formatDateLabel(date: string): string {
  return WEEKDAY_LABEL_FORMATTER.format(parseIsoDate(date))
}

function formatDayTitle(date: string): string {
  return DAY_TITLE_FORMATTER.format(parseIsoDate(date))
}

function formatClockLabel(value: string): string {
  const [hourText, minuteText] = value.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const normalizedHour = hour % 12 === 0 ? 12 : hour % 12
  const meridiem = hour >= 12 ? 'PM' : 'AM'
  return `${normalizedHour}:${String(minute).padStart(2, '0')} ${meridiem}`
}

function formatWeekRangeLabel(startDate: string, endDate: string): string {
  return `${WEEK_RANGE_LABEL_FORMATTER.format(parseIsoDate(startDate))} - ${WEEK_RANGE_LABEL_FORMATTER.format(parseIsoDate(endDate))}`
}

function buildShiftInterval(startTime: string, endTime: string): TimeInterval {
  const startMinute = parseTimeMinutes(startTime)
  let endMinute = parseTimeMinutes(endTime)
  if (endMinute <= startMinute) {
    endMinute += 24 * 60
  }

  return { endMinute, startMinute }
}

function recordAssignedInterval(input: {
  assignedIntervalsByEmployeeDate: Map<string, TimeInterval[]>
  date: string
  employeeId: string
  shiftInterval: TimeInterval
}): number {
  const key = `${input.employeeId}::${input.date}`
  const existingIntervals = input.assignedIntervalsByEmployeeDate.get(key) ?? []
  const beforeMinutes = sumIntervalMinutes(existingIntervals)
  const nextIntervals = mergeIntervals([...existingIntervals, input.shiftInterval])
  input.assignedIntervalsByEmployeeDate.set(key, nextIntervals)
  return sumIntervalMinutes(nextIntervals) - beforeMinutes
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

function parseTimeMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map((part) => Number.parseInt(part, 10))
  return hours * 60 + minutes
}

function getWeekStartDate(date: string): string {
  const parsedDate = parseIsoDate(date)
  return toIsoDate(addDays(parsedDate, -parsedDate.getUTCDay()))
}

function parseIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`)
}

function startOfMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1))
}

function endOfMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0))
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}
