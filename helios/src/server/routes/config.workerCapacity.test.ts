import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_WORKER_CAPACITY_CONFIG } from '../../shared/contracts/index.js'

const mocks = vi.hoisted(() => ({
  appendAudit: vi.fn(),
  lockCapacity: vi.fn(),
  notifyQueue: vi.fn(),
  query: vi.fn(),
  requireSessionUser: vi.fn(),
}))

vi.mock('../auth/requireSession.js', () => ({ requireSessionUser: mocks.requireSessionUser }))
vi.mock('../audit/appendAuditEvent.js', () => ({ appendAuditEvent: mocks.appendAudit }))
vi.mock('../db/notify.js', () => ({ notifyJobQueueEnqueued: mocks.notifyQueue }))
vi.mock('../db/queries/workerCapacityQueries.js', () => ({ lockWorkerCapacityConfig: mocks.lockCapacity }))
vi.mock('../db/tx.js', () => ({
  withTransaction: vi.fn(async (run: (db: { query: typeof mocks.query }) => Promise<unknown>) => run({ query: mocks.query })),
}))

import { registerConfigRoutes } from './config.js'

const before = {
  config: DEFAULT_WORKER_CAPACITY_CONFIG,
  updatedAt: '2026-07-31T10:00:00.000Z',
  updatedBy: 'system-default',
}
const admin = { id: 17, email: 'admin@example.com', name: 'Admin', role: 'admin' }

describe('worker capacity config routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireSessionUser.mockResolvedValue(admin)
    mocks.lockCapacity.mockResolvedValue(before)
    mocks.query.mockResolvedValue({ rows: [{ updated_at: new Date('2026-07-31T10:01:00.000Z') }] })
    mocks.appendAudit.mockResolvedValue(1)
    mocks.notifyQueue.mockResolvedValue(undefined)
  })

  it('requires an admin and does not read capacity when authorization fails', async () => {
    mocks.requireSessionUser.mockResolvedValue(null)
    const server = Fastify()
    await registerConfigRoutes(server)

    await server.inject({ method: 'GET', url: '/api/config/workers/capacity' })

    expect(mocks.requireSessionUser).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'admin')
    expect(mocks.lockCapacity).not.toHaveBeenCalled()
    await server.close()
  })

  it('rejects invalid capacity before opening the update transaction', async () => {
    const server = Fastify()
    await registerConfigRoutes(server)

    const response = await server.inject({
      method: 'PUT', url: '/api/config/workers/capacity',
      payload: { ...DEFAULT_WORKER_CAPACITY_CONFIG, generalSlots: 33 },
    })

    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expect(mocks.lockCapacity).not.toHaveBeenCalled()
    await server.close()
  })

  it('leaves an unchanged config unaudited and does not wake workers', async () => {
    const server = Fastify()
    await registerConfigRoutes(server)

    const response = await server.inject({
      method: 'PUT', url: '/api/config/workers/capacity', payload: DEFAULT_WORKER_CAPACITY_CONFIG,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(before)
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.appendAudit).not.toHaveBeenCalled()
    expect(mocks.notifyQueue).not.toHaveBeenCalled()
    await server.close()
  })

  it('updates, audits, and wakes workers inside the changed transaction', async () => {
    const after = { ...DEFAULT_WORKER_CAPACITY_CONFIG, generalSlots: 2 }
    const server = Fastify()
    await registerConfigRoutes(server)

    const response = await server.inject({
      method: 'PUT', url: '/api/config/workers/capacity', payload: after,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ config: after, updatedAt: '2026-07-31T10:01:00.000Z', updatedBy: admin.email })
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('update app_settings'), expect.arrayContaining([expect.any(String), JSON.stringify(after), admin.email]))
    expect(mocks.appendAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorUserId: admin.id,
      eventType: 'config.workers.capacity_updated',
      payload: { before: before.config, after },
    }))
    expect(mocks.notifyQueue).toHaveBeenCalledOnce()
    expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(mocks.appendAudit.mock.invocationCallOrder[0]!)
    expect(mocks.appendAudit.mock.invocationCallOrder[0]).toBeLessThan(mocks.notifyQueue.mock.invocationCallOrder[0]!)
    await server.close()
  })

  it('does not notify or return success when the transactional audit fails', async () => {
    mocks.appendAudit.mockRejectedValue(new Error('audit unavailable'))
    const server = Fastify()
    await registerConfigRoutes(server)

    const response = await server.inject({
      method: 'PUT', url: '/api/config/workers/capacity',
      payload: { ...DEFAULT_WORKER_CAPACITY_CONFIG, generalSlots: 2 },
    })

    expect(response.statusCode).toBe(500)
    expect(mocks.notifyQueue).not.toHaveBeenCalled()
    await server.close()
  })
})
