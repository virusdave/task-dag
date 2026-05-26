import type { QueryResult, QueryResultRow } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Queryable } from '../../server/db/pool.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// In-memory shim that records every (productId, enqueueReason) the helper
// has tried to insert. The test toggles `existingProductIds` to simulate
// the 5-minute dedupe predicate hitting a pre-existing row.
const dbState = {
  nextQueueRowId: 1,
  nextJobId: 100,
  existingProductIds: new Set<number>(),
  insertCalls: [] as Array<{ productId: number; enqueueReason: string; priority: number; alarmClass: string | null; notes: string | null }>,
  auditEvents: [] as Array<{ eventType: string; payload: unknown; actorType: string }>,
  jobEnqueueCalls: [] as Array<{ dedupeKey: string | null; jobType: string; payload: unknown }>,
}

function buildFakeDb(): Queryable {
  return {
    async query<TResult extends QueryResultRow>(text: string, params?: unknown[]) {
      const trimmed = text.trim()
      if (trimmed.startsWith('insert into pending_litalerts_refresh_queue')) {
        const productId = params![0] as number
        const enqueueReason = params![1] as string
        const priority = params![2] as number
        const alarmClass = (params![4] as string | null) ?? null
        const notes = (params![5] as string | null) ?? null
        dbState.insertCalls.push({ productId, enqueueReason, priority, alarmClass, notes })
        if (dbState.existingProductIds.has(productId)) {
          return {
            command: 'INSERT',
            fields: [],
            oid: 0,
            rowCount: 0,
            rows: [] as unknown as TResult[],
          } as QueryResult<TResult>
        }
        const queueRowId = dbState.nextQueueRowId
        dbState.nextQueueRowId += 1
        return {
          command: 'INSERT',
          fields: [],
          oid: 0,
          rowCount: 1,
          rows: [{ id: queueRowId }] as unknown as TResult[],
        } as QueryResult<TResult>
      }
      throw new Error(`Unexpected query in test: ${trimmed.slice(0, 80)}`)
    },
  }
}

vi.mock('../../server/db/tx.js', () => ({
  withTransaction: async <T>(run: (db: Queryable) => Promise<T>): Promise<T> => {
    return run(buildFakeDb())
  },
}))

vi.mock('../../server/jobs/enqueueJob.js', () => ({
  enqueueJob: vi.fn(async (_db: Queryable, input: { dedupeKey: string | null; jobType: string; payload: unknown }) => {
    dbState.jobEnqueueCalls.push({
      dedupeKey: input.dedupeKey ?? null,
      jobType: input.jobType,
      payload: input.payload,
    })
    const jobId = dbState.nextJobId
    dbState.nextJobId += 1
    return jobId
  }),
  // Mirror the real module's priority band constants so call sites
  // that import them alongside `enqueueJob` resolve at test time.
  JOB_PRIORITY_BEST_EFFORT: 0,
  JOB_PRIORITY_INTERACTIVE: 100,
  JOB_PRIORITY_URGENT: 1000,
  JOB_PRIORITY_BACKGROUND: 0,
  JOB_PRIORITY_HIGH: 100,
}))

vi.mock('../../server/audit/appendAuditEvent.js', () => ({
  appendAuditEvent: vi.fn(async (_db: Queryable, input: { eventType: string; payload: unknown; actorType: string }) => {
    dbState.auditEvents.push({
      eventType: input.eventType,
      payload: input.payload,
      actorType: input.actorType,
    })
    return 1
  }),
}))

import { enqueueMarketRefreshForProducts } from './enqueueMarketRefresh.js'

beforeEach(() => {
  dbState.nextQueueRowId = 1
  dbState.nextJobId = 100
  dbState.existingProductIds.clear()
  dbState.insertCalls.length = 0
  dbState.auditEvents.length = 0
  dbState.jobEnqueueCalls.length = 0
})

describe('enqueueMarketRefreshForProducts', () => {
  it('inserts a queue row and an enqueued job for a single product', async () => {
    const result = await enqueueMarketRefreshForProducts([501], {
      trigger: { kind: 'manual', reason: 'spot check' },
    })

    expect(result.enqueuedQueueRowIds).toEqual([1])
    expect(result.enqueuedJobIds).toEqual([100])
    expect(result.skippedCount).toBe(0)
    expect(dbState.insertCalls).toHaveLength(1)
    expect(dbState.insertCalls[0]).toMatchObject({
      productId: 501,
      enqueueReason: 'manual',
      priority: 50,
      alarmClass: null,
    })
    expect(dbState.jobEnqueueCalls).toHaveLength(1)
    expect(dbState.jobEnqueueCalls[0]).toMatchObject({
      dedupeKey: 'config.workers.litalerts_refresh.variant:1',
      jobType: 'config.workers.litalerts_refresh.variant',
    })
    expect(dbState.jobEnqueueCalls[0].payload).toMatchObject({
      productId: 501,
      queueRowId: 1,
      siteDealerId: null,
      sourceSnapshotId: null,
      trigger: 'manual',
    })
  })

  it('skips products already covered by the 5-minute dedupe window', async () => {
    dbState.existingProductIds.add(502)

    const result = await enqueueMarketRefreshForProducts([501, 502, 503], {
      trigger: { kind: 'rolling' },
    })

    expect(result.enqueuedQueueRowIds).toEqual([1, 2])
    expect(result.enqueuedJobIds).toEqual([100, 101])
    expect(result.skippedCount).toBe(1)
    // We attempted the insert for all three; the dedupe predicate
    // produced the skip for product 502.
    expect(dbState.insertCalls.map((call) => call.productId)).toEqual([501, 502, 503])
    // The skipped product must not get a job enqueued.
    const enqueuedProductIds = dbState.jobEnqueueCalls.map((call) => {
      const payload = call.payload as { productId: number }
      return payload.productId
    })
    expect(enqueuedProductIds).toEqual([501, 503])
  })

  it('uses priority 0 for alarm-class triggers and threads alarmClass through', async () => {
    const result = await enqueueMarketRefreshForProducts([701], {
      trigger: { kind: 'brand-alarm', brandName: 'Doobie Labs' },
      alarmClass: 'brand_match',
    })

    expect(result.enqueuedQueueRowIds).toEqual([1])
    expect(dbState.insertCalls[0]).toMatchObject({
      productId: 701,
      enqueueReason: 'brand-alarm',
      priority: 0,
      alarmClass: 'brand_match',
    })
  })

  it('fires exactly one audit event per batch with the trigger + ids', async () => {
    await enqueueMarketRefreshForProducts([801, 802, 803], {
      trigger: { kind: 'proposal-source', proposalLabel: '2026-05-16-10ff-brands' },
      requestedByUserId: 42,
    })

    expect(dbState.auditEvents).toHaveLength(1)
    expect(dbState.auditEvents[0]).toMatchObject({
      eventType: 'config.workers.litalerts_refresh.requested',
      actorType: 'user',
    })
    const payload = dbState.auditEvents[0].payload as {
      productIds: number[]
      enqueuedQueueRowIds: number[]
      enqueuedJobIds: number[]
      trigger: { kind: string; proposalLabel?: string }
      alarmClass: string | null
      priority: number
    }
    expect(payload.productIds).toEqual([801, 802, 803])
    expect(payload.enqueuedQueueRowIds).toEqual([1, 2, 3])
    expect(payload.enqueuedJobIds).toEqual([100, 101, 102])
    expect(payload.trigger).toEqual({
      kind: 'proposal-source',
      proposalLabel: '2026-05-16-10ff-brands',
    })
    expect(payload.alarmClass).toBeNull()
    expect(payload.priority).toBe(10)
  })

  it('skips the audit event entirely when every product was deduped', async () => {
    dbState.existingProductIds.add(901)
    dbState.existingProductIds.add(902)

    const result = await enqueueMarketRefreshForProducts([901, 902], {
      trigger: { kind: 'rolling' },
    })

    expect(result.enqueuedQueueRowIds).toEqual([])
    expect(result.skippedCount).toBe(2)
    expect(dbState.auditEvents).toHaveLength(0)
  })
})
