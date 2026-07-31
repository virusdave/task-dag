export const JOB_PRIORITY_LIVE_REQUESTED = 500
export const JOB_PRIORITY_URGENT = 1000

export const SCHEDULING_CANCELLATION_MARKER = '[scheduling-cancelled]'

export function schedulingCancellationError(message: string): string {
  return `${SCHEDULING_CANCELLATION_MARKER} ${message}`
}
