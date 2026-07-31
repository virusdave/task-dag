import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  appendAudit: vi.fn(),
  enqueue: vi.fn(),
  getJobStatus: vi.fn(),
  poolQuery: vi.fn(),
  preview: vi.fn(),
  readInventory: vi.fn(),
  requireSessionUser: vi.fn().mockResolvedValue({ id: 17, role: 'editor' }),
  resolveDestination: vi.fn(),
  verify: vi.fn(() => true),
  withSession: vi.fn(async (run: () => Promise<unknown>) => run()),
}))
vi.mock('../auth/requireSession.js', () => ({ requireSessionUser: mocks.requireSessionUser }))
vi.mock('../../worker/sweed/session.js', () => ({ withSweedSession: mocks.withSession }))
vi.mock('../db/pool.js', () => ({ getPool: () => ({ query: mocks.poolQuery }) }))
vi.mock('../db/tx.js', () => ({ withTransaction: vi.fn(async (run: (db: object) => Promise<unknown>) => run({})) }))
vi.mock('../jobs/enqueueJob.js', () => ({ enqueueJobExactOnce: mocks.enqueue, JOB_PRIORITY_LIVE_REQUESTED: 500 }))
vi.mock('../db/queries/jobQueries.js', () => ({ getJobStatus: mocks.getJobStatus }))
vi.mock('../audit/appendAuditEvent.js', () => ({ appendAuditEvent: mocks.appendAudit }))
vi.mock('../catalog/tradeSampleZeroService.js', () => ({
  assertTargetContents: vi.fn(),
  previewTradeSampleZero: mocks.preview,
  readLiveInventory: mocks.readInventory,
  resolveTradeSampleDestination: mocks.resolveDestination,
  verifyTradeSampleZeroPreview: mocks.verify,
}))

import { registerTradeSampleZeroRoutes } from './tradeSampleZero.js'

const destination = { id: 88, name: 'NOT FOR SALE - Samples', stockTypeId: 7 }
const item = { currentQty: 2, availableQty: 2, externalTrackCode: 'TAG', inventoryItemId: '44', packageLabel: null,
  productId: 9, productName: 'Sample', productSku: null, sourceLocationId: 12, sourceLocationName: 'Back', sourceStockTypeId: 3 }
const preview = { siteDealerId: 210249, digest: 'a'.repeat(64), previewId: '123e4567-e89b-42d3-a456-426614174000',
  previewToken: 'signed.preview', destination, items: [item] }
const stageRequestId = `catalog.inventory.stage_trade_samples:210249:${preview.previewId}`
const stagePayload = { ...preview, previewToken: undefined, confirmation: 'STAGE TRADE SAMPLES', actorUserId: 17, requestId: stageRequestId }
delete stagePayload.previewToken
const stagedItem = { ...item, inventoryItemId: '99', sourceLocationId: destination.id, sourceLocationName: destination.name, sourceStockTypeId: destination.stockTypeId }
const stage = { operationId: stageRequestId, siteDealerId: 210249, destination, items: [stagedItem], complete: true,
  counts: { completed: 1, failedUnknown: 0, notAppliedStale: 0, notAppliedAuditFailure: 0 },
  outcomes: [{ inventoryItemId: '44', status: 'completed' }], message: 'Staged.' }
const jobStatus = {
  job: {
    attemptCount: 0, createdAt: '2026-07-31T06:00:00.000Z', executionPool: 'sweed', finishedAt: null,
    jobId: 91, jobType: 'catalog.inventory.stage_trade_samples', lastError: null, module: 'catalog', priority: 500,
    priorityBand: 'live_requested', requestedByLabel: 'Operator', requestedByUserId: 17,
    runAt: '2026-07-31T06:00:00.000Z', scope: { entityType: 'trade_sample_site', entityId: '210249' },
    startedAt: null, status: 'queued',
  },
  linkedRecords: { llmRunId: null, pendingPurchaseApplyRequestId: null, pendingPurchasePacketId: null,
    proposalBatchId: null, undoEventId: null, writeOperationId: null },
  progressLog: [], progress: null, sweedAuthEvents: [], tradeSampleZeroResult: null, tradeSampleStageResult: null,
}

describe('trade sample routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireSessionUser.mockResolvedValue({ id: 17, role: 'editor' })
    mocks.verify.mockReturnValue(true)
    mocks.resolveDestination.mockResolvedValue(destination)
    mocks.readInventory.mockResolvedValue([])
    mocks.appendAudit.mockResolvedValue(1)
  })

  it('previews in a Sweed session and queues staging only with the signed reviewed payload', async () => {
    mocks.preview.mockResolvedValue(preview)
    mocks.enqueue.mockResolvedValue({ inserted: true, jobId: 42 })
    const server = Fastify()
    await registerTradeSampleZeroRoutes(server)
    expect((await server.inject({ method: 'POST', url: '/api/catalog/inventory/trade-samples/preview-zero', payload: { siteDealerId: 210249 } })).statusCode).toBe(200)
    const response = await server.inject({ method: 'POST', url: '/api/catalog/inventory/trade-samples/apply-zero', payload: { ...preview, confirmation: 'STAGE TRADE SAMPLES' } })
    expect(response.json()).toEqual({ jobId: 42 })
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      jobType: 'catalog.inventory.stage_trade_samples',
      dedupeKey: `catalog.inventory.stage_trade_samples:210249:${preview.previewId}`,
      payload: expect.objectContaining({ confirmation: 'STAGE TRADE SAMPLES', digest: preview.digest }),
      scope: { entityType: 'trade_sample_site', entityId: '210249' },
    }))
    expect(mocks.enqueue.mock.calls[0]?.[1].payload).not.toHaveProperty('previewToken')
    await server.close()
  })

  it('returns the latest indexed site-scoped staging job and validates the site', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 91 }] })
    mocks.getJobStatus.mockResolvedValueOnce(jobStatus)
    const server = Fastify()
    await registerTradeSampleZeroRoutes(server)

    const response = await server.inject({
      method: 'GET',
      url: '/api/catalog/inventory/trade-samples/recent-stage-job?siteDealerId=210249',
    })

    expect(response.json()).toEqual({ stageJob: jobStatus })
    expect(mocks.poolQuery).toHaveBeenCalledWith(expect.stringContaining("scope_entity_type = 'trade_sample_site'"), ['210249'])
    expect(String(mocks.poolQuery.mock.calls[0]?.[0])).toContain('order by created_at desc, id desc')
    expect(mocks.getJobStatus).toHaveBeenCalledWith(expect.anything(), 91)
    expect((await server.inject({
      method: 'GET',
      url: '/api/catalog/inventory/trade-samples/recent-stage-job?siteDealerId=999',
    })).statusCode).toBe(400)
    await server.close()
  })

  it('returns no recent staging job and requires a viewer session', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] })
    const server = Fastify()
    await registerTradeSampleZeroRoutes(server)
    expect((await server.inject({
      method: 'GET',
      url: '/api/catalog/inventory/trade-samples/recent-stage-job?siteDealerId=210249',
    })).json()).toEqual({ stageJob: null })
    expect(mocks.getJobStatus).not.toHaveBeenCalled()

    mocks.requireSessionUser.mockResolvedValueOnce(null)
    expect((await server.inject({
      method: 'GET',
      url: '/api/catalog/inventory/trade-samples/recent-stage-job?siteDealerId=210249',
    })).statusCode).toBe(200)
    expect(mocks.requireSessionUser).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'viewer')
    await server.close()
  })

  it('requires exact approval and a trusted successful stage result before fresh verification and zero enqueue', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ status: 'succeeded', job_payload_json: stagePayload, result_payload_json: stage }] })
      .mockResolvedValueOnce({ rows: [] })
    mocks.enqueue.mockResolvedValue({ inserted: true, jobId: 43 })
    const server = Fastify()
    await registerTradeSampleZeroRoutes(server)
    expect((await server.inject({ method: 'POST', url: '/api/catalog/inventory/trade-samples/stage-jobs/8/approve-zero', payload: { confirmation: 'close enough' } })).statusCode).toBe(400)
    const response = await server.inject({ method: 'POST', url: '/api/catalog/inventory/trade-samples/stage-jobs/8/approve-zero', payload: { confirmation: 'I VERIFIED ONLY TRADE SAMPLES' } })
    expect(response.json()).toEqual({ jobId: 43 })
    expect(mocks.resolveDestination).toHaveBeenCalledWith(210249)
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      jobType: 'catalog.inventory.zero_trade_samples',
      dedupeKey: 'catalog.inventory.zero_trade_samples:stage:8',
      payload: expect.objectContaining({ items: [expect.objectContaining({ inventoryItemId: '99', sourceLocationId: 88 })] }),
    }))
    expect(mocks.appendAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'trade_sample.zero.approved',
      payload: expect.objectContaining({ stageJobId: 8, zeroJobId: 43, siteDealerId: 210249 }),
    }))
    await server.close()
  })

  it('aborts approval before enqueue when the stage is untrusted or fresh exact-set verification fails', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ status: 'failed', job_payload_json: stagePayload, result_payload_json: stage }] })
      .mockResolvedValueOnce({ rows: [{ status: 'succeeded', job_payload_json: stagePayload, result_payload_json: stage }] })
      .mockResolvedValueOnce({ rows: [] })
    const server = Fastify()
    await registerTradeSampleZeroRoutes(server)
    const request = { method: 'POST' as const, url: '/api/catalog/inventory/trade-samples/stage-jobs/8/approve-zero', payload: { confirmation: 'I VERIFIED ONLY TRADE SAMPLES' } }
    expect((await server.inject(request)).statusCode).toBe(409)
    mocks.resolveDestination.mockRejectedValueOnce(new Error('extra package'))
    expect((await server.inject(request)).statusCode).toBe(409)
    expect(mocks.enqueue).not.toHaveBeenCalled()
    await server.close()
  })

  it('rejects a stage result that changes reviewed package metadata', async () => {
    const changedStage = { ...stage, items: [{ ...stagedItem, currentQty: 3, availableQty: 3 }] }
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ status: 'succeeded', job_payload_json: stagePayload, result_payload_json: changedStage }] })
    const server = Fastify()
    await registerTradeSampleZeroRoutes(server)

    const response = await server.inject({
      method: 'POST',
      url: '/api/catalog/inventory/trade-samples/stage-jobs/8/approve-zero',
      payload: { confirmation: 'I VERIFIED ONLY TRADE SAMPLES' },
    })

    expect(response.statusCode).toBe(409)
    expect(mocks.resolveDestination).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
    await server.close()
  })

  it('rejects duplicate staged package identities even under different destination IDs', async () => {
    const secondReviewedItem = { ...item, inventoryItemId: '45', externalTrackCode: 'TAG-2', productId: 10, productName: 'Second sample' }
    const twoItemPayload = { ...stagePayload, items: [item, secondReviewedItem] }
    const duplicateIdentityStage = {
      ...stage,
      items: [stagedItem, { ...stagedItem, inventoryItemId: '100' }],
      counts: { ...stage.counts, completed: 2 },
      outcomes: [
        { inventoryItemId: '44', status: 'completed' },
        { inventoryItemId: '45', status: 'completed' },
      ],
    }
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ status: 'succeeded', job_payload_json: twoItemPayload, result_payload_json: duplicateIdentityStage }] })
    const server = Fastify()
    await registerTradeSampleZeroRoutes(server)

    const response = await server.inject({
      method: 'POST',
      url: '/api/catalog/inventory/trade-samples/stage-jobs/8/approve-zero',
      payload: { confirmation: 'I VERIFIED ONLY TRADE SAMPLES' },
    })

    expect(response.statusCode).toBe(409)
    expect(mocks.resolveDestination).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
    await server.close()
  })

  it('accepts distinct reviewed rows that share a product and package tag', async () => {
    const sibling = { ...item, inventoryItemId: '45', currentQty: 4, availableQty: 4 }
    const siblingStaged = { ...stagedItem, inventoryItemId: '100', currentQty: 4, availableQty: 4 }
    const sameTagPayload = { ...stagePayload, items: [item, sibling] }
    const sameTagStage = {
      ...stage,
      items: [stagedItem, siblingStaged],
      counts: { ...stage.counts, completed: 2 },
      outcomes: [
        { inventoryItemId: '44', status: 'completed' },
        { inventoryItemId: '45', status: 'completed' },
      ],
    }
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ status: 'succeeded', job_payload_json: sameTagPayload, result_payload_json: sameTagStage }] })
      .mockResolvedValueOnce({ rows: [] })
    mocks.enqueue.mockResolvedValue({ inserted: true, jobId: 43 })
    const server = Fastify()
    await registerTradeSampleZeroRoutes(server)

    const response = await server.inject({
      method: 'POST',
      url: '/api/catalog/inventory/trade-samples/stage-jobs/8/approve-zero',
      payload: { confirmation: 'I VERIFIED ONLY TRADE SAMPLES' },
    })

    expect(response.statusCode).toBe(200)
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      payload: expect.objectContaining({ items: [stagedItem, siblingStaged] }),
    }))
    await server.close()
  })

  it('reconciles an exact prior approval before re-reading inventory', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ status: 'succeeded', job_payload_json: stagePayload, result_payload_json: stage }] })
      .mockResolvedValueOnce({ rows: [{ id: 43, exact_payload: true }] })
    const server = Fastify()
    await registerTradeSampleZeroRoutes(server)
    const response = await server.inject({
      method: 'POST',
      url: '/api/catalog/inventory/trade-samples/stage-jobs/8/approve-zero',
      payload: { confirmation: 'I VERIFIED ONLY TRADE SAMPLES' },
    })
    expect(response.json()).toEqual({ jobId: 43 })
    expect(mocks.resolveDestination).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
    expect(mocks.appendAudit).not.toHaveBeenCalled()
    await server.close()
  })
})
