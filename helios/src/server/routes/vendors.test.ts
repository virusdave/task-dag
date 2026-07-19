import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireSessionUser: vi.fn(async () => ({ id: 1, role: 'editor' })),
  listVendors: vi.fn(),
  createVendor: vi.fn(async () => 7),
  getVendorById: vi.fn(),
  updateVendor: vi.fn(async () => true),
}))

vi.mock('../auth/requireSession.js', () => ({ requireSessionUser: mocks.requireSessionUser }))
vi.mock('../db/pool.js', () => ({ getPool: vi.fn(() => ({})) }))
vi.mock('../db/tx.js', () => ({ withTransaction: vi.fn(async (run: (db: object) => unknown) => run({})) }))
vi.mock('../db/queries/vendorsQueries.js', () => ({
  createVendor: mocks.createVendor,
  getVendorById: mocks.getVendorById,
  listVendors: mocks.listVendors,
  updateVendor: mocks.updateVendor,
}))

import { registerVendorRoutes } from './vendors.js'

const vendor = {
  id: 7,
  name: 'Acme',
  isMso: false,
  isMicro: true,
  codOnly: false,
  associations: [],
  observedDistributors: [],
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}

let server: FastifyInstance

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.requireSessionUser.mockResolvedValue({ id: 1, role: 'editor' })
  mocks.listVendors.mockResolvedValue([vendor])
  mocks.getVendorById.mockResolvedValue(vendor)
  server = Fastify()
  await registerVendorRoutes(server)
  await server.ready()
})

afterEach(async () => {
  await server.close()
})

describe('vendor route permissions and validation', () => {
  it('requires viewer access before listing vendor data', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/vendors' })

    expect(response.statusCode).toBe(200)
    expect(mocks.requireSessionUser).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'viewer')
    expect(response.json().vendors[0].name).toBe('Acme')
  })

  it('requires editor access and validates bounded create payloads', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/vendors',
      payload: { name: 'Acme 2', associations: [{ brandName: 'Brand 2' }] },
    })

    expect(response.statusCode).toBe(201)
    expect(mocks.requireSessionUser).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'editor')
    expect(mocks.createVendor).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      name: 'Acme 2', associations: [expect.objectContaining({ brandName: 'Brand 2' })],
    }))
  })

  it('stops before database access when permission is denied', async () => {
    mocks.requireSessionUser.mockImplementationOnce(async (_request, reply) => {
      reply.status(403).send({ error: 'forbidden' })
      return null
    })

    const response = await server.inject({ method: 'PATCH', url: '/api/vendors/7', payload: { isMso: true } })

    expect(response.statusCode).toBe(403)
    expect(mocks.updateVendor).not.toHaveBeenCalled()
  })
})
