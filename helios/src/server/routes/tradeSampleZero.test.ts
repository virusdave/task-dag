import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { applyMock, previewMock, withSweedSessionMock } = vi.hoisted(() => ({
  applyMock: vi.fn(),
  previewMock: vi.fn(),
  withSweedSessionMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

vi.mock('../auth/requireSession.js', () => ({
  requireSessionUser: vi.fn().mockResolvedValue({ id: 17, role: 'editor' }),
}))
vi.mock('../../worker/sweed/session.js', () => ({ withSweedSession: withSweedSessionMock }))
vi.mock('../catalog/tradeSampleZeroService.js', async (original) => ({
  ...await original<typeof import('../catalog/tradeSampleZeroService.js')>(),
  previewTradeSampleZero: previewMock,
  applyTradeSampleZero: applyMock,
}))

import { registerTradeSampleZeroRoutes } from './tradeSampleZero.js'
import { TradeSampleZeroBusyError } from '../catalog/tradeSampleZeroService.js'

const applyPayload = { siteDealerId: 210249, digest: 'a'.repeat(64), items: [], confirmation: 'ZERO TRADE SAMPLES' }

describe('trade sample zero routes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('runs an editor preview inside a Sweed session', async () => {
    previewMock.mockResolvedValue({ siteDealerId: 210249, digest: 'a'.repeat(64), items: [] })
    const server = Fastify()
    await registerTradeSampleZeroRoutes(server)
    const response = await server.inject({ method: 'POST', url: '/api/catalog/inventory/trade-samples/preview-zero', payload: { siteDealerId: 210249 } })
    expect(response.statusCode).toBe(200)
    expect(withSweedSessionMock).toHaveBeenCalledOnce()
    expect(previewMock).toHaveBeenCalledWith(210249)
    await server.close()
  })

  it('returns an apply response and maps lock conflict to 409', async () => {
    applyMock.mockResolvedValueOnce({ counts: { completed: 0, failedUnknown: 0, notAppliedStale: 0, notAppliedAuditFailure: 0 }, outcomes: [] })
      .mockRejectedValueOnce(new TradeSampleZeroBusyError('busy'))
    const server = Fastify()
    await registerTradeSampleZeroRoutes(server)
    expect((await server.inject({ method: 'POST', url: '/api/catalog/inventory/trade-samples/apply-zero', payload: applyPayload })).statusCode).toBe(200)
    const conflict = await server.inject({ method: 'POST', url: '/api/catalog/inventory/trade-samples/apply-zero', payload: applyPayload })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toEqual({ error: 'busy' })
    await server.close()
  })

  it('does not expose unexpected preview or apply errors', async () => {
    previewMock.mockRejectedValueOnce(new Error('secret Sweed body'))
    applyMock.mockRejectedValueOnce(new Error('secret RPC body'))
    const server = Fastify({ logger: false })
    await registerTradeSampleZeroRoutes(server)
    const preview = await server.inject({ method: 'POST', url: '/api/catalog/inventory/trade-samples/preview-zero', payload: { siteDealerId: 210249 } })
    const apply = await server.inject({ method: 'POST', url: '/api/catalog/inventory/trade-samples/apply-zero', payload: applyPayload })
    expect(preview.statusCode).toBe(503)
    expect(apply.statusCode).toBe(502)
    expect(`${preview.body}${apply.body}`).not.toContain('secret')
    await server.close()
  })
})
