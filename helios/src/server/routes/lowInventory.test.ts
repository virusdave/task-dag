import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LowInventoryReadModel } from '../../shared/contracts/index.js'

const mockState = vi.hoisted(() => ({
  admin: false,
  sessionRole: null as 'admin' | 'editor' | 'viewer' | null,
  appSetting: null as {
    key: string
    updatedAt: string
    updatedBy: string
    value: unknown
  } | null,
  metricsGranted: false,
}))

const getAppSettingMock = vi.hoisted(() => vi.fn())
const upsertAppSettingMock = vi.hoisted(() => vi.fn())
const queryLowInventoryReadModelMock = vi.hoisted(() => vi.fn())
const listLowInventoryCountAuditsMock = vi.hoisted(() => vi.fn())
const appendAuditEventMock = vi.hoisted(() => vi.fn())
const confirmLowInventoryTransferMock = vi.hoisted(() => vi.fn())
const getLowInventoryPackageSnapshotMock = vi.hoisted(() => vi.fn())

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
      const role = mockState.admin ? 'admin' : mockState.sessionRole
      if (role !== null) {
        return {
          active: true,
          email: 'admin@example.com',
          id: 2,
          metricGrants: mockState.metricsGranted ? ['reordering'] : [],
          name: 'Admin',
          role,
        }
      }
      reply.status(403).send({ error: 'Admin required.' })
      return null
    },
  ),
}))

vi.mock('../audit/appendAuditEvent.js', () => ({ appendAuditEvent: appendAuditEventMock }))

vi.mock('../db/pool.js', () => ({
  getPool: vi.fn(() => ({ query: vi.fn() })),
}))
vi.mock('../db/tx.js', () => ({
  withTransaction: (run: (db: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) =>
    run({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
}))

vi.mock('../db/queries/appSettingsQueries.js', () => ({
  getAppSetting: getAppSettingMock,
  upsertAppSetting: upsertAppSettingMock,
}))

vi.mock('../lowInventory/lowInventoryQueries.js', () => ({
  getLowInventoryPackageSnapshot: getLowInventoryPackageSnapshotMock,
  listLowInventoryCountAudits: listLowInventoryCountAuditsMock,
  queryLowInventoryReadModel: queryLowInventoryReadModelMock,
}))
vi.mock('../lowInventory/lowInventoryTransferService.js', () => ({
  LowInventoryTransferConflictError: class extends Error {},
  confirmLowInventoryTransfer: confirmLowInventoryTransferMock,
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
  mockState.sessionRole = null
  mockState.appSetting = null
  mockState.metricsGranted = false
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
  appendAuditEventMock.mockResolvedValue(41)
  getLowInventoryPackageSnapshotMock.mockResolvedValue({
    availableQty: 2,
    currentQty: 2,
    holdQty: 0,
    internalTrackCode: 'FLOWER-A-1',
    inventoryItemId: 'pkg-1',
    metrcTag: 'TAG-1',
    observedAt: new Date().toISOString(),
    productId: 123,
    productName: 'Product',
    stockLocation: 'FOR SALE - Midtown',
  })
  listLowInventoryCountAuditsMock.mockResolvedValue([])
  confirmLowInventoryTransferMock.mockResolvedValue({
    transferAuditId: 42, countAuditId: 41, movedQty: 1, notificationStatus: 'not_requested',
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

  it('records a validated immutable package-count snapshot', async () => {
    mockState.sessionRole = 'editor'
    mockState.metricsGranted = true
    const payload = {
      dealerId: 210705, productId: 123, inventoryItemId: 'pkg-1',
      snapshotObservedAt: '2026-07-10T14:00:00.000Z', physicalCount: 1,
    }
    const response = await server.inject({ method: 'POST', url: '/api/low-inventory/counts', payload })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ auditId: 41, notificationStatus: 'not_requested' })
    expect(appendAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorUserId: 2,
      eventType: 'low_inventory.package_count.recorded',
      payload: expect.objectContaining({ ...payload, classification: 'short', snapshotCurrentQty: 2 }),
    }))

    getLowInventoryPackageSnapshotMock.mockResolvedValueOnce(null)
    const invalid = await server.inject({
      method: 'POST', url: '/api/low-inventory/counts', payload,
    })
    expect(invalid.statusCode).toBe(409)

    getLowInventoryPackageSnapshotMock.mockResolvedValueOnce({
      availableQty: 2, currentQty: 2, holdQty: 0, internalTrackCode: 'FLOWER-A-1',
      inventoryItemId: 'pkg-1', metrcTag: 'TAG-1', observedAt: '2020-01-01T00:00:00.000Z',
      productId: 123, productName: 'Product', stockLocation: 'FOR SALE - Midtown',
    })
    const stale = await server.inject({
      method: 'POST', url: '/api/low-inventory/counts', payload,
    })
    expect(stale.statusCode).toBe(409)
  })

  it('lists bounded site audits and returns fail-closed transfer configuration defaults', async () => {
    mockState.sessionRole = 'viewer'
    mockState.metricsGranted = true
    const audits = await server.inject({ method: 'GET', url: '/api/low-inventory/audits?dealerId=210705&limit=20' })
    expect(audits.statusCode).toBe(200)
    expect(listLowInventoryCountAuditsMock).toHaveBeenCalledWith(expect.anything(), 210705, 20)

    const config = await server.inject({ method: 'GET', url: '/api/low-inventory/transfer-config?dealerId=210705' })
    expect(config.json()).toMatchObject({
      dealerId: 210705, destinationName: 'NOT FOR SALE - Hold for Dave inspection', transferEnabled: false,
    })
    const unbounded = await server.inject({ method: 'GET', url: '/api/low-inventory/audits?dealerId=210705&limit=101' })
    expect(unbounded.statusCode).toBe(400)
  })

  it('lets an admin configure one site and an editor explicitly confirm transfer', async () => {
    mockState.admin = true
    const config = await server.inject({ method: 'PUT', url: '/api/low-inventory/transfer-config', payload: {
      dealerId: 210705, destinationName: 'NOT FOR SALE - Inspection room', transferEnabled: true,
    } })
    expect(config.statusCode).toBe(200)
    expect(upsertAppSettingMock).toHaveBeenCalledWith(expect.anything(),
      'low_inventory_transfer_config:midtown', expect.objectContaining({ transferEnabled: true }),
      'admin@example.com')

    mockState.admin = false
    mockState.sessionRole = 'editor'
    mockState.metricsGranted = true
    mockState.appSetting = {
      key: 'low_inventory_transfer_config:midtown', updatedAt: '2026-07-10T15:00:00.000Z',
      updatedBy: 'admin@example.com', value: {
        dealerId: 210705, destinationName: 'NOT FOR SALE - Inspection room', transferEnabled: true,
      },
    }
    const transfer = await server.inject({ method: 'POST', url: '/api/low-inventory/transfers', payload: {
      dealerId: 210705,
      countAuditId: 41,
      confirmedConfigUpdatedAt: '2026-07-10T15:00:00.000Z',
      confirmedDestinationName: 'NOT FOR SALE - Inspection room',
    } })
    expect(transfer.statusCode).toBe(200)
    expect(transfer.json()).toMatchObject({ notificationStatus: 'not_requested', transferAuditId: 42 })
  })
})
