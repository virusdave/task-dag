import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Queryable } from '../db/pool.js'

vi.mock('../db/notify.js', () => ({ notifyJobQueueEnqueued: vi.fn(async () => undefined) }))

import { notifyJobQueueEnqueued } from '../db/notify.js'
import { enqueueJobExactActive } from './enqueueJob.js'

const input = {
  jobType: 'db.migration.apply' as const,
  module: 'config' as const,
  payload: {
    migrationId: '097_x', requestedByUserId: 7, confirmMigrationId: '097_x',
    authorization: { mode: 'oracle-approved' as const, artifactSha256: 'a'.repeat(64) },
  },
  dedupeKey: 'migration-apply:097_x',
}

const forcePayload = {
  ...input.payload,
  authorization: {
    mode: 'force-without-review' as const,
    artifactSha256: 'a'.repeat(64),
    action: 'FORCE WITHOUT REVIEW APPROVAL' as const,
    confirmationPhrase: 'FORCE WITHOUT REVIEW APPROVAL' as const,
    target: 'helios-production' as const,
    acknowledgedWithoutReview: true as const,
  },
}

function fake(activePayload: unknown | null): Queryable {
  return {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 1 }
      }
      if (text.includes('payload_json = $2::jsonb')) {
        const proposed = JSON.parse(String(values[1])) as unknown
        return activePayload === null
          ? { rows: [], rowCount: 0 }
          : {
              rows: [{
                id: 11,
                exact_payload: JSON.stringify(activePayload) === JSON.stringify(proposed),
              }],
              rowCount: 1,
            }
      }
      if (text.includes('insert into job_queue')) {
        activePayload = JSON.parse(String(values[7])) as unknown
        return { rows: [{ id: 13 }], rowCount: 1 }
      }
      throw new Error(`Unexpected query: ${text}`)
    }),
  } as unknown as Queryable
}

describe('enqueueJobExactActive', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dedupes the same exact active payload', async () => {
    const db = fake(input.payload)
    await expect(enqueueJobExactActive(db, input)).resolves.toEqual({
      inserted: false, jobId: 11, exactPayload: true,
    })
    expect(notifyJobQueueEnqueued).not.toHaveBeenCalled()
  })

  it.each([
    ['cross-mode', forcePayload],
    ['cross-digest', {
      ...input.payload,
      authorization: { mode: 'oracle-approved' as const, artifactSha256: 'b'.repeat(64) },
    }],
  ])('reports a concrete %s active payload as a conflict', async (_label, activePayload) => {
    const db = fake(activePayload)
    await expect(enqueueJobExactActive(db, input)).resolves.toEqual({
      inserted: false, jobId: 11, exactPayload: false,
    })
    expect(notifyJobQueueEnqueued).not.toHaveBeenCalled()
  })

  it('inserts and notifies when no active payload exists', async () => {
    const db = fake(null)
    await expect(enqueueJobExactActive(db, input)).resolves.toEqual({ inserted: true, jobId: 13 })
    expect(notifyJobQueueEnqueued).toHaveBeenCalledWith(db)
    expect(db.query).toHaveBeenCalledTimes(3)
  })
})
