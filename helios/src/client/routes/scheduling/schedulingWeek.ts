import { countSchedulingWeeks, type SchedulingWeekWindow } from '../../../shared/contracts/index.js'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const MONTH_FORMATTER = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
})
const MONTH_YEAR_FORMATTER = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

export function buildScheduleWeekWindowFromStartDate(startDate: string, weekCount = 1): SchedulingWeekWindow | null {
  const parsedStartDate = parseDateInputValue(startDate)
  if (!parsedStartDate || parsedStartDate.getDay() !== 0 || !Number.isInteger(weekCount) || weekCount < 1) {
    return null
  }

  const endDate = new Date(parsedStartDate)
  endDate.setDate(endDate.getDate() + weekCount * 7 - 1)

  return {
    endDate: formatDateInputValue(endDate),
    startDate,
  }
}

export function formatScheduleWeekLabel(scheduleWeek: SchedulingWeekWindow | null | undefined): string {
  if (!scheduleWeek) {
    return 'No scheduling window selected'
  }

  const startDate = parseDateInputValue(scheduleWeek.startDate)
  const endDate = parseDateInputValue(scheduleWeek.endDate)
  if (!startDate || !endDate) {
    return `${scheduleWeek.startDate} - ${scheduleWeek.endDate}`
  }

  const sameYear = startDate.getFullYear() === endDate.getFullYear()
  const startLabel = sameYear ? MONTH_FORMATTER.format(startDate) : MONTH_YEAR_FORMATTER.format(startDate)
  const endLabel = MONTH_YEAR_FORMATTER.format(endDate)
  const weekCount = countSchedulingWeeks(scheduleWeek)
  const weekLabel = `${weekCount} week${weekCount === 1 ? '' : 's'}`
  return `${startLabel} - ${endLabel} (${DAY_NAMES[startDate.getDay()]}-${DAY_NAMES[endDate.getDay()]}, ${weekLabel})`
}

export function getDefaultSchedulingWeekStartDate(referenceDate = new Date()): string {
  const startDate = new Date(referenceDate)
  startDate.setHours(12, 0, 0, 0)
  const daysUntilSunday = (7 - startDate.getDay()) % 7
  startDate.setDate(startDate.getDate() + daysUntilSunday)
  return formatDateInputValue(startDate)
}

function formatDateInputValue(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDateInputValue(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null
  }

  const parsed = new Date(`${value}T12:00:00`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
