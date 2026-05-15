import {
  WEEKDAY_MASK_ALL,
  type ConfigWorkerScheduleWindow,
} from '../../../shared/contracts/index.js'

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function describeWeekdayMask(mask: number): string {
  if (mask === WEEKDAY_MASK_ALL) {
    return '7d/wk'
  }
  if (mask === 0) {
    return 'never'
  }
  const days: string[] = []
  for (let bit = 0; bit < 7; bit += 1) {
    if ((mask & (1 << bit)) !== 0) {
      days.push(WEEKDAY_LABELS[bit])
    }
  }
  return days.join(', ')
}

export function describeMinuteOfDay(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440
  const hour = Math.floor(normalized / 60)
  const minute = normalized % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function describeWindow(window: ConfigWorkerScheduleWindow): string {
  const wraps = window.windowStartMinute > window.windowEndMinute
  const arrow = wraps ? ' -> next-day' : ' -> '
  const range = `${describeMinuteOfDay(window.windowStartMinute)}${arrow}${describeMinuteOfDay(window.windowEndMinute)}`
  const cadence = `every ${window.intervalMinutes} min`
  const days = describeWeekdayMask(window.weekdayMask)
  const paused = window.paused ? ' (paused)' : ''
  return `${range}, ${cadence}, ${days}${paused}`
}
