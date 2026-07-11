import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LowInventoryReadModel } from '../../shared/contracts/index.js'

const mockState = vi.hoisted(() => ({
  admin: false,
  appSetting: null as {
    key: string
    updatedAt: string
    updatedBy: string
    value: unknown
  } | null,
  metricsGranted: false,
  countMigrationApplied: false,
}))

const getAppSettingMock = vi.hoisted(() => vi.fn())
const upsertAppSettingMock = vi.hoisted(() => vi.fn())
const queryLowInventoryReadModelMock = vi.hoisted(() => vi.fn())
const captureLowInventoryCountMock = vi.hoisted(() => vi.fn())

vi.mock('../auth/requireSession.js', () => ({
  requireMetricsGrant: vi.fn(
    async (
      _request: unknown,
      reply: { status: (code: number) => { send: (body: unknown) => void } },
    ) => {
      if (mockState.metricsGranted) {
        return {
          active: true,
          email: 'viewer@example.com',
          id: 1,
          metricGrants: ['reordering'],
          name: 'Viewer',
          role: 'viewer',
        }
      }
      reply.status(403).send({ error: 'Metrics grant required.' })
      return null
    },
  ),
  requireSessionUser: vi.fn(
    async (
      _request: unknown,
      reply: { status: (code: number) => { send: (body: unknown) => void } },
    ) => {
      if (mockState.admin) {
        return {
          active: true,
          email: 'admin@example.com',
          id: 2,
          metricGrants: [],
          name: 'Admin',
          role: 'admin',
        }
      }
      reply.status(403).send({ error: 'Admin required.' })
      return null
    },
  ),
}))

vi.mock('../db/pool.js', () => ({
  getPool: vi.fn(() => ({ query: vi.fn() })),
}))

vi.mock('../db/pendingMigrations.js', () => ({
  isMigrationAppliedLive: vi.fn(async () => mockState.countMigrationApplied),
}))

vi.mock('../db/queries/appSettingsQueries.js', () => ({
  getAppSetting: getAppSettingMock,
  upsertAppSetting: upsertAppSettingMock,
}))

vi.mock('../lowInventory/lowInventoryQueries.js', () => ({
  queryLowInventoryReadModel: queryLowInventoryReadModelMock,
}))

vi.mock('../lowInventory/lowInventoryCounts.js', () => ({
  captureLowInventoryCount: captureLowInventoryCountMock,
  LowInventoryCountCaptureError: class extends Error {
    readonly statusCode = 404
  },
}))

import { registerLowInventoryRoutes } from './lowInventory.js'

function model(overrides: Partial<LowInventoryReadModel> = {}): LowInventoryReadModel {
  return {
    dealerId: 210705,
    locationGroups: [],
    snapshotObservedAt: '2026-07-10T14:00:00.000Z',
    threshold: 2,
    ...overrides,
  }
}

let server: FastifyInstance

beforeEach(async () => {
  mockState.admin = false
  mockState.appSetting = null
  mockState.metricsGranted = false
  mockState.countMigrationApplied = false
  getAppSettingMock.mockImplementation(async () => mockState.appSetting)
  upsertAppSettingMock.mockImplementation(
    async (_db: unknown, key: string, value: unknown, updatedBy: string) => ({
      key,
      value,
      updatedAt: '2026-07-10T15:00:00.000Z',
      updatedBy,
    }),
  )
  queryLowInventoryReadModelMock.mockImplementation(
    async (args: { dealerId: number; threshold: number }) =>
      model({ dealerId: args.dealerId, threshold: args.threshold }),
  )
  captureLowInventoryCountMock.mockResolvedValue({
    id: '20c4a7fe-ea9f-45ad-98d2-437d7378579d',
    requestId: 'd1dc2c24-bca5-4c44-ad05-07f254e3a554',
    dealerId: 210705,
    inventoryItemId: 'package-1',
    productId: 101,
    productSku: 'SKU-1',
    productName: 'Product',
    physicalQty: 1,
    classification: 'short',
    resolutionStatus: 'pending',
    actor: { userId: 2, email: 'admin@example.com', name: 'Admin' },
    capturedAt: '2026-07-11T14:00:00.000Z',
    sweedSnapshot: {
      currentQty: 2,
      holdQty: 0,
      availableQty: 2,
      stockLocation: 'FOR SALE - Midtown',
      internalTrackCode: 'PRE-A-1',
      metrcTag: 'TAG-1',
      observedAt: '2026-07-11T13:55:00.000Z',
    },
  })
  server = Fastify()
  server.setErrorHandler((error, _request, reply) =>
    reply.status(500).send({ error: error.message }),
  )
  await registerLowInventoryRoutes(server)
  await server.ready()
})

afterEach(async () => {
  await server.close()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('low-inventory routes', () => {
  it('requires the reordering metrics grant before any read', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/low-inventory?dealerId=210705' })

    expect(response.statusCode).toBe(403)
    expect(getAppSettingMock).not.toHaveBeenCalled()
    expect(queryLowInventoryReadModelMock).not.toHaveBeenCalled()
  })

  it('isolates the read to one validated site and uses the default threshold', async () => {
    mockState.metricsGranted = true

    const response = await server.inject({ method: 'GET', url: '/api/low-inventory?dealerId=210249' })

    expect(response.statusCode).toBe(200)
    expect(queryLowInventoryReadModelMock).toHaveBeenCalledWith({ dealerId: 210249, threshold: 2 })
    expect(response.json()).toMatchObject({
      data: { dealerId: 210249, locationGroups: [], threshold: 2 },
      site: { dealerId: 210249, siteKey: 'bronx', siteLabel: 'Bronx' },
    })
  })

  it('rejects an unknown site before reading settings or inventory', async () => {
    mockState.metricsGranted = true

    const response = await server.inject({ method: 'GET', url: '/api/low-inventory?dealerId=999999' })

    expect(response.statusCode).toBe(400)
    expect(getAppSettingMock).not.toHaveBeenCalled()
    expect(queryLowInventoryReadModelMock).not.toHaveBeenCalled()
  })

  it('represents empty current data and stale snapshots explicitly', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T15:00:01.000Z'))
    mockState.metricsGranted = true
    queryLowInventoryReadModelMock.mockResolvedValue(
      model({ locationGroups: [], snapshotObservedAt: '2026-07-10T14:30:00.000Z' }),
    )

    const response = await server.inject({ method: 'GET', url: '/api/low-inventory?dealerId=210705' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: { locationGroups: [], snapshotObservedAt: '2026-07-10T14:30:00.000Z' },
      freshness: { isStale: true, staleAfterMinutes: 15 },
    })
  })

  it('surfaces read errors instead of returning an empty state', async () => {
    mockState.metricsGranted = true
    queryLowInventoryReadModelMock.mockRejectedValue(new Error('snapshot unavailable'))

    const response = await server.inject({ method: 'GET', url: '/api/low-inventory?dealerId=210705' })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ error: 'snapshot unavailable' })
  })

  it('applies a valid stored threshold and fails closed on malformed settings', async () => {
    mockState.metricsGranted = true
    mockState.appSetting = {
      key: 'low_inventory_config',
      updatedAt: '2026-07-10T14:00:00.000Z',
      updatedBy: 'admin@example.com',
      value: { threshold: 7 },
    }

    const validResponse = await server.inject({
      method: 'GET',
      url: '/api/low-inventory?dealerId=210705',
    })

    expect(validResponse.statusCode).toBe(200)
    expect(queryLowInventoryReadModelMock).toHaveBeenCalledWith({ dealerId: 210705, threshold: 7 })

    mockState.appSetting = { ...mockState.appSetting, value: { threshold: 101 } }
    const invalidResponse = await server.inject({
      method: 'GET',
      url: '/api/low-inventory?dealerId=210705',
    })

    expect(invalidResponse.statusCode).toBe(500)
    expect(queryLowInventoryReadModelMock).toHaveBeenCalledTimes(1)
  })

  it('allows only admins to update a bounded threshold', async () => {
    const denied = await server.inject({
      method: 'PUT',
      url: '/api/low-inventory/config',
      payload: { threshold: 3 },
    })
    expect(denied.statusCode).toBe(403)
    expect(upsertAppSettingMock).not.toHaveBeenCalled()

    mockState.admin = true
    const invalid = await server.inject({
      method: 'PUT',
      url: '/api/low-inventory/config',
      payload: { threshold: 0 },
    })
    expect(invalid.statusCode).toBe(400)
    expect(upsertAppSettingMock).not.toHaveBeenCalled()

    const saved = await server.inject({
      method: 'PUT',
      url: '/api/low-inventory/config',
      payload: { threshold: 3 },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toEqual({
      threshold: 3,
      updatedAt: '2026-07-10T15:00:00.000Z',
      updatedBy: 'admin@example.com',
    })
    expect(upsertAppSettingMock).toHaveBeenCalledWith(
      expect.anything(),
      'low_inventory_config',
      { threshold: 3 },
      'admin@example.com',
    )
  })

  it('requires editor authorization and an applied migration before capturing a count', async () => {
    const denied = await server.inject({
      method: 'POST',
      url: '/api/low-inventory/counts',
      payload: {
        dealerId: 210705,
        inventoryItemId: 'package-1',
        physicalQty: 1,
        requestId: 'd1dc2c24-bca5-4c44-ad05-07f254e3a554',
      },
    })
    expect(denied.statusCode).toBe(403)
    expect(captureLowInventoryCountMock).not.toHaveBeenCalled()

    mockState.admin = true
    const migrationPending = await server.inject({
      method: 'POST',
      url: '/api/low-inventory/counts',
      payload: {
        dealerId: 210705,
        inventoryItemId: 'package-1',
        physicalQty: 1,
        requestId: 'd1dc2c24-bca5-4c44-ad05-07f254e3a554',
      },
    })
    expect(migrationPending.statusCode).toBe(503)
    expect(captureLowInventoryCountMock).not.toHaveBeenCalled()

    mockState.countMigrationApplied = true
    const captured = await server.inject({
      method: 'POST',
      url: '/api/low-inventory/counts',
      payload: {
        dealerId: 210705,
        inventoryItemId: 'package-1',
        physicalQty: 1,
        requestId: 'd1dc2c24-bca5-4c44-ad05-07f254e3a554',
      },
    })
    expect(captured.statusCode).toBe(201)
    expect(captured.json()).toMatchObject({
      count: { classification: 'short', resolutionStatus: 'pending' },
      inventoryChanged: false,
      notificationSent: false,
    })
    expect(captureLowInventoryCountMock).toHaveBeenCalledWith(expect.objectContaining({
      dealerId: 210705,
      inventoryItemId: 'package-1',
      physicalQty: 1,
      requestId: 'd1dc2c24-bca5-4c44-ad05-07f254e3a554',
    }))
  })
})
