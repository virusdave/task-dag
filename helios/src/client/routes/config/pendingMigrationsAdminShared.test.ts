import { describe, expect, it } from 'vitest'

import type {
  AdminPendingMigrationRow,
  JobStatusResponse,
} from '../../../shared/contracts/index.js'
import {
  applyButtonView,
  applyStatusLine,
  attemptStateLabel,
  attemptStateTone,
  eligibilityLabel,
  eligibilityTone,
  initialRowApplyState,
  isRowInFlight,
  resumableJobId,
  type RowApplyState,
} from './pendingMigrationsAdminShared.js'

function row(overrides: Partial<AdminPendingMigrationRow> = {}): AdminPendingMigrationRow {
  return {
    migrationId: '097_litalerts_parse_feedback',
    label: 'litalerts parse feedback',
    sentinelState: 'pending',
    eligible: true,
    ineligibleReason: null,
    blessing: { ref: 'oracle-ref', note: null, transactionMode: 'transactional' },
    artifactDigestMatch: true,
    lastAttempt: null,
    ...overrides,
  }
}

function jobStatus(
  status: JobStatusResponse['job']['status'],
  extra: { lastError?: string | null; progressMessage?: string } = {},
): JobStatusResponse {
  return {
    job: {
      attemptCount: 1,
      createdAt: '2026-07-08T00:00:00.000Z',
      executionPool: 'system',
      finishedAt: null,
      jobId: 42,
      jobType: 'db.migration.apply',
      lastError: extra.lastError ?? null,
      module: 'config',
      priority: 1000,
      priorityBand: 'urgent',
      requestedByLabel: null,
      requestedByUserId: 7,
      runAt: '2026-07-08T00:00:00.000Z',
      scope: null,
      startedAt: null,
      status,
    },
    linkedRecords: {
      llmRunId: null,
      pendingPurchaseApplyRequestId: null,
      pendingPurchasePacketId: null,
      proposalBatchId: null,
      undoEventId: null,
      writeOperationId: null,
    },
    progressLog: [],
    progress: extra.progressMessage
      ? {
          phase: 'apply',
          phaseIndex: 1,
          phaseCount: 1,
          completed: null,
          total: null,
          message: extra.progressMessage,
        }
      : null,
    sweedAuthEvents: [],
  }
}

const idle: RowApplyState = initialRowApplyState()

describe('applyButtonView', () => {
  it('enables Apply Now for an eligible, idle row', () => {
    const view = applyButtonView(row(), idle)
    expect(view.enabled).toBe(true)
    expect(view.label).toBe('Apply Now')
    expect(view.disabledReason).toBeNull()
  })

  it('disables with the server reason for an ineligible row', () => {
    const view = applyButtonView(
      row({ eligible: false, ineligibleReason: 'no blessing recorded' }),
      idle,
    )
    expect(view.enabled).toBe(false)
    expect(view.disabledReason).toBe('no blessing recorded')
  })

  it('shows Enqueuing… while submitting', () => {
    const view = applyButtonView(row(), { ...idle, phase: 'submitting' })
    expect(view.enabled).toBe(false)
    expect(view.label).toBe('Enqueuing…')
  })

  it('disables while an apply is in flight (client polling)', () => {
    const view = applyButtonView(row(), { ...idle, phase: 'polling', jobId: 42 })
    expect(view.enabled).toBe(false)
    expect(view.label).toBe('Applying…')
  })

  it('disables when the server last attempt is still running (e.g. after reload)', () => {
    const view = applyButtonView(
      row({
        lastAttempt: {
          jobId: 42,
          state: 'running',
          error: null,
          startedAt: '2026-07-08T00:00:00.000Z',
          finishedAt: null,
          requestedBy: 7,
        },
      }),
      idle,
    )
    expect(view.enabled).toBe(false)
    expect(view.label).toBe('Applying…')
  })
})

describe('isRowInFlight / resumableJobId', () => {
  it('treats a running server attempt as in flight and resumable', () => {
    const r = row({
      lastAttempt: {
        jobId: 99,
        state: 'running',
        error: null,
        startedAt: '2026-07-08T00:00:00.000Z',
        finishedAt: null,
        requestedBy: 7,
      },
    })
    expect(isRowInFlight(r, idle)).toBe(true)
    expect(resumableJobId(r)).toBe(99)
  })

  it('is not in flight when idle with a terminal (failed) last attempt', () => {
    const r = row({
      lastAttempt: {
        jobId: 99,
        state: 'failed',
        error: 'boom',
        startedAt: '2026-07-08T00:00:00.000Z',
        finishedAt: '2026-07-08T00:01:00.000Z',
        requestedBy: 7,
      },
    })
    expect(isRowInFlight(r, idle)).toBe(false)
    expect(resumableJobId(r)).toBeNull()
  })
})

describe('applyStatusLine', () => {
  it('reports success when the polled job succeeded', () => {
    const line = applyStatusLine(row(), { ...idle, phase: 'done', jobStatus: jobStatus('succeeded') })
    expect(line).toContain('Applied')
  })

  it('surfaces the job error on failure', () => {
    const line = applyStatusLine(row(), {
      ...idle,
      phase: 'polling',
      jobStatus: jobStatus('failed', { lastError: 'sentinel did not flip' }),
    })
    expect(line).toBe('sentinel did not flip')
  })

  it('prefers the live progress message while running', () => {
    const line = applyStatusLine(row(), {
      ...idle,
      phase: 'polling',
      jobStatus: jobStatus('running', { progressMessage: 'running psql -f 097…' }),
    })
    expect(line).toBe('running psql -f 097…')
  })

  it('falls back to the server last-attempt error when idle', () => {
    const line = applyStatusLine(
      row({
        lastAttempt: {
          jobId: 1,
          state: 'failed',
          error: 'prior failure',
          startedAt: '2026-07-08T00:00:00.000Z',
          finishedAt: '2026-07-08T00:01:00.000Z',
          requestedBy: 7,
        },
      }),
      idle,
    )
    expect(line).toBe('prior failure')
  })

  it('is null with nothing to show', () => {
    expect(applyStatusLine(row(), idle)).toBeNull()
  })
})

describe('pill helpers', () => {
  it('maps attempt states to tones', () => {
    expect(attemptStateTone('succeeded')).toBe('success')
    expect(attemptStateTone('already_applied')).toBe('success')
    expect(attemptStateTone('failed')).toBe('danger')
    expect(attemptStateTone('blocked_lock')).toBe('danger')
    expect(attemptStateTone('running')).toBe('warning')
  })

  it('humanizes attempt state labels', () => {
    expect(attemptStateLabel('already_applied')).toBe('already applied')
    expect(attemptStateLabel('blocked_lock')).toBe('blocked lock')
  })

  it('maps eligibility to tone + label', () => {
    expect(eligibilityTone(row())).toBe('success')
    expect(eligibilityLabel(row())).toBe('eligible')
    expect(eligibilityTone(row({ eligible: false }))).toBe('warning')
    expect(eligibilityLabel(row({ eligible: false }))).toBe('not eligible')
  })
})
