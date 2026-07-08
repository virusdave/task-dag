// Pure presentation/logic helpers for the admin pending-migrations page
// (automation#62, leaf 7). Kept separate from the React component so the
// display + gating logic is unit-testable without a DOM render harness
// (mirrors agentWasteReviewShared.ts). The component owns fetch/poll state;
// this module is side-effect-free.

import type {
  AdminPendingMigrationAttemptState,
  AdminPendingMigrationRow,
  JobStatusResponse,
} from '../../../shared/contracts/index.js'
import type { PillProps } from '../../components/Pill.js'

// Per-row apply lifecycle as tracked in the browser while an admin drives an
// apply. `idle` before any click; `submitting` while the enqueue POST is in
// flight; `polling` while we poll GET /api/jobs/:jobId; `done`/`error` are the
// terminal client states (the authoritative record is the job + attempt row).
export type ApplyPhase = 'idle' | 'submitting' | 'polling' | 'done' | 'error'

export interface RowApplyState {
  phase: ApplyPhase
  // The enqueued (or in-flight, deduped) job id we are polling, if any.
  jobId: number | null
  // The most recent polled job status, if we have one.
  jobStatus: JobStatusResponse | null
  // A surfaced error string (enqueue failure or terminal job failure).
  error: string | null
}

export function initialRowApplyState(): RowApplyState {
  return { phase: 'idle', jobId: null, jobStatus: null, error: null }
}

// A migration is "in flight" (an apply is running now, so the button must be
// disabled and we should be polling) when either the client is mid-apply or
// the server's last attempt is still `running`. The latter covers a page
// reload while a worker apply is ongoing.
export function isRowInFlight(row: AdminPendingMigrationRow, apply: RowApplyState): boolean {
  if (apply.phase === 'submitting' || apply.phase === 'polling') {
    return true
  }
  return row.lastAttempt !== null && row.lastAttempt.state === 'running'
}

// The job id we should resume polling on load, if any: the last attempt is
// still running and carries a job id.
export function resumableJobId(row: AdminPendingMigrationRow): number | null {
  if (row.lastAttempt !== null && row.lastAttempt.state === 'running') {
    return row.lastAttempt.jobId
  }
  return null
}

export interface ApplyButtonView {
  enabled: boolean
  label: string
  // A short reason the button is disabled, for a title tooltip; null when enabled.
  disabledReason: string | null
}

// Decide whether "Apply Now" is clickable, its label, and (when disabled) why.
// The server re-validates everything on POST; this is purely UI affordance.
export function applyButtonView(
  row: AdminPendingMigrationRow,
  apply: RowApplyState,
): ApplyButtonView {
  if (apply.phase === 'submitting') {
    return { enabled: false, label: 'Enqueuing…', disabledReason: 'Enqueuing the apply job…' }
  }
  if (isRowInFlight(row, apply)) {
    return { enabled: false, label: 'Applying…', disabledReason: 'An apply is already in flight.' }
  }
  if (!row.eligible) {
    return {
      enabled: false,
      label: 'Apply Now',
      disabledReason:
        row.ineligibleReason ??
        'Not apply-eligible (needs an Oracle blessing + matching artifact digest).',
    }
  }
  return { enabled: true, label: 'Apply Now', disabledReason: null }
}

// A one-line status describing the current apply, or null when there is
// nothing to show yet. Prefers the live job progress message.
export function applyStatusLine(
  row: AdminPendingMigrationRow,
  apply: RowApplyState,
): string | null {
  if (apply.phase === 'submitting') {
    return 'Enqueuing the worker apply job…'
  }
  if (apply.error !== null) {
    return apply.error
  }
  if (apply.jobStatus !== null) {
    const { status, lastError } = apply.jobStatus.job
    if (status === 'succeeded') {
      return 'Applied — the sentinel now reports this migration as applied.'
    }
    if (status === 'failed' || status === 'dead_letter') {
      return lastError ?? 'Apply failed. Review the error and retry.'
    }
    return apply.jobStatus.progress?.message ?? `Apply job is ${status.replaceAll('_', ' ')}…`
  }
  // No client apply in progress; fall back to the server's last attempt.
  if (row.lastAttempt !== null) {
    if (row.lastAttempt.state === 'running') {
      return 'A worker apply is currently running.'
    }
    if (row.lastAttempt.error !== null) {
      return row.lastAttempt.error
    }
  }
  return null
}

export function attemptStateTone(state: AdminPendingMigrationAttemptState): PillProps['tone'] {
  switch (state) {
    case 'succeeded':
    case 'already_applied':
      return 'success'
    case 'failed':
    case 'blocked_lock':
    case 'abandoned':
      return 'danger'
    case 'running':
      return 'warning'
  }
  // Exhaustive: a new AdminPendingMigrationAttemptState must be handled
  // explicitly rather than silently rendering as a neutral tone.
  const unhandled: never = state
  throw new Error(`Unhandled attempt state: ${String(unhandled)}`)
}

export function attemptStateLabel(state: AdminPendingMigrationAttemptState): string {
  return state.replaceAll('_', ' ')
}

// Tone for the eligibility pill: eligible == success, ineligible == warning
// (it is a drift/gate condition, not a hard error).
export function eligibilityTone(row: AdminPendingMigrationRow): PillProps['tone'] {
  return row.eligible ? 'success' : 'warning'
}

export function eligibilityLabel(row: AdminPendingMigrationRow): string {
  return row.eligible ? 'eligible' : 'not eligible'
}
