import type { QueryResult, QueryResultRow } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Queryable } from '../../server/db/pool.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
//
// The post-A4 enqueueMarketRefreshForProducts opens ONE transaction
// per call and inside it issues:
//   1. ONE bulk `insert into pending_litalerts_refresh_queue …
//      select … from jsonb_to_recordset($1::jsonb) … where not exists
//      … returning id, product_id`  — one row per product that was
//      NOT 5-minute-deduped.
//   2. ONE call to the bulk `enqueueJobs` plural helper (mocked
//      below) with one input per inserted queue row.
//   3. ONE `appendAuditEvent` per non-empty batch.
//
// The fake DB below decodes the jsonb_to_recordset payload, applies
// the per-product dedupe via `existingProductIds`, and returns the
// (id, product_id) rows the plural insert RETURNING clause would
// produce. `enqueueJobs` and `appendAuditEvent` are mocked module-
// level so the assertions can inspect what the helper passed them.

const dbState = {
  nextQueueRowId: 1,
  nextJobId: 100,
  existingProductIds: new Set<number>(),
  insertCalls: [] as Array<{
    productIds: number[]
    enqueueReason: string
    priority: number
    alarmClass: string | null
    notes: string | null
    insertedProductIds: number[]
  }>,
  auditEvents: [] as Array<{ eventType: string; payload: unknown; actorType: string }>,
  jobBatchCalls: [] as Array<{
    inputs: Array<{ dedupeKey: string | null; jobType: string; payload: unknown }>
    returnedJobIds: number[]
  }>,
}

function buildFakeDb(): Queryable {
  return {
    async query<TResult extends QueryResultRow>(text: string, params?: unknown[]) {
      const trimmed = text.trim()
      if (trimmed.startsWith('insert into pending_litalerts_refresh_queue')) {
        const jsonPayload = JSON.parse(params![0] as string) as Array<{ product_id: number }>
        const enqueueReason = params![1] as string
        const priority = params![2] as number
        const alarmClass = (params![4] as string | null) ?? null
        const notes = (params![5] as string | null) ?? null
        const productIds = jsonPayload.map((row) => row.product_id)
        const inserted: Array<{ id: number; product_id: number }> = []
        for (const productId of productIds) {
          if (dbState.existingProductIds.has(productId)) {
            continue
          }
          const id = dbState.nextQueueRowId
          dbState.nextQueueRowId += 1
          inserted.push({ id, product_id: productId })
        }
        dbState.insertCalls.push({
          productIds,
          enqueueReason,
          priority,
          alarmClass,
          notes,
          insertedProductIds: inserted.map((r) => r.product_id),
        })
        return {
          command: 'INSERT',
          fields: [],
          oid: 0,
          rowCount: inserted.length,
          rows: inserted as unknown as TResult[],
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
  enqueueJob: vi.fn(),
  enqueueJobs: vi.fn(
    async (
      _db: Queryable,
      inputs: Array<{ dedupeKey: string | null; jobType: string; payload: unknown }>,
    ) => {
      const ids: number[] = []
      for (const _input of inputs) {
        const jobId = dbState.nextJobId
        dbState.nextJobId += 1
        ids.push(jobId)
      }
      dbState.jobBatchCalls.push({ inputs, returnedJobIds: [...ids] })
      return ids
    },
  ),
  // Mirror the real module's priority band constants so call sites
  // that import them alongside the helpers resolve at test time.
  JOB_PRIORITY_BEST_EFFORT: 0,
  JOB_PRIORITY_BACKFILL: 10,
  JOB_PRIORITY_INTERACTIVE: 100,
  JOB_PRIORITY_LIVE_REQUESTED: 500,
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
  dbState.jobBatchCalls.length = 0
})

function allEnqueuedJobInputs(): Array<{
  dedupeKey: string | null
  jobType: string
  payload: unknown
}> {
  return dbState.jobBatchCalls.flatMap((call) => call.inputs)
}

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
      productIds: [501],
      enqueueReason: 'manual',
      priority: 50,
      alarmClass: null,
      insertedProductIds: [501],
    })
    const enqueuedInputs = allEnqueuedJobInputs()
    expect(enqueuedInputs).toHaveLength(1)
    expect(enqueuedInputs[0]).toMatchObject({
      dedupeKey: 'config.workers.litalerts_refresh.variant:1',
      jobType: 'config.workers.litalerts_refresh.variant',
    })
    expect(enqueuedInputs[0].payload).toMatchObject({
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
    // produced the skip for product 502 inside the bulk INSERT's
    // RETURNING clause.
    expect(dbState.insertCalls[0].productIds).toEqual([501, 502, 503])
    expect(dbState.insertCalls[0].insertedProductIds).toEqual([501, 503])
    const enqueuedProductIds = allEnqueuedJobInputs().map((input) => {
      const payload = input.payload as { productId: number }
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
      productIds: [701],
      enqueueReason: 'brand-alarm',
      priority: 0,
      alarmClass: 'brand_match',
      insertedProductIds: [701],
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
    // We still issued exactly one bulk INSERT (which returned zero
    // rows because all three products were inside the dedupe
    // window).
    expect(dbState.insertCalls).toHaveLength(1)
    expect(dbState.insertCalls[0].insertedProductIds).toEqual([])
    // No bulk job enqueue call should fire when there are no
    // inserted queue rows.
    expect(dbState.jobBatchCalls).toHaveLength(0)
  })

  it('issues exactly ONE bulk job-enqueue call per batch (no per-row enqueueJobs calls)', async () => {
    await enqueueMarketRefreshForProducts([1001, 1002, 1003, 1004], {
      trigger: { kind: 'rolling' },
    })
    expect(dbState.jobBatchCalls).toHaveLength(1)
    expect(dbState.jobBatchCalls[0].inputs).toHaveLength(4)
    expect(dbState.jobBatchCalls[0].returnedJobIds).toEqual([100, 101, 102, 103])
  })
})
