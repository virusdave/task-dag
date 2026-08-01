import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Role } from '../../shared/contracts/index.js'
import { hasAtLeastRole } from '../auth/permissions.js'

const mocks = vi.hoisted(() => ({
  assign: vi.fn(),
  invalidate: vi.fn(),
  loadState: vi.fn(),
  pageDave: vi.fn(),
  role: 'editor' as Role,
}))

vi.mock('../auth/requireSession.js', () => ({
  requireSessionUser: vi.fn(
    async (
      _request: unknown,
      reply: { status: (status: number) => { send: (body: unknown) => unknown } },
      minimumRole: Role = 'viewer',
    ) => {
      if (!hasAtLeastRole(mocks.role, minimumRole)) {
        reply.status(403).send({ error: 'You do not have permission to perform this action.' })
        return null
      }
      return { id: 17, role: mocks.role }
    },
  ),
}))
vi.mock('../catalog/maintenance.js', () => ({
  invalidateCatalogMaintenanceSurvey: mocks.invalidate,
}))
vi.mock('../warehouse/locations.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../warehouse/locations.js')>(),
  assignWarehouseLocation: mocks.assign,
  loadWarehouseLocationsState: mocks.loadState,
}))
vi.mock('../../worker/runtime/pageDave.js', () => ({ pageDave: mocks.pageDave }))

import { registerWarehouseLocationsRoutes } from './warehouseLocations.js'

const pkg = {
  assignedLocationCode: null,
  availableQty: 2,
  effectiveLocationCode: null,
  internalTrackCode: null,
  inventoryBarcode: '810000000000',
  inventoryItemId: '44',
  metrcTag: '1A4000000000000000000044',
  observedAt: '2026-08-01T00:00:00.000Z',
  productName: 'Test product',
  stockLocation: 'FOR SALE',
}

describe('warehouse locations role gates', () => {
  beforeEach(() => {
    mocks.role = 'editor'
    mocks.assign.mockReset()
    mocks.invalidate.mockReset()
    mocks.loadState.mockReset()
    mocks.pageDave.mockReset()
    mocks.loadState.mockResolvedValue({
      auditPackages: [pkg],
      meta: {
        dealerId: 210705,
        prefixes: [{ label: 'Edibles', prefix: 'EDI' }],
        siteLabel: 'Midtown',
        snapshotObservedAt: pkg.observedAt,
      },
      occupied: [],
    })
    mocks.assign.mockResolvedValue({
      conflicts: [],
      failures: [],
      locationCode: 'EDI-A-1',
      packages: [{ ...pkg, assignedLocationCode: 'EDI-A-1', effectiveLocationCode: 'EDI-A-1' }],
      status: 'assigned',
    })
  })

  it('allows an Editor to load and assign warehouse locations', async () => {
    const server = Fastify()
    await registerWarehouseLocationsRoutes(server)

    expect((await server.inject({ method: 'GET', url: '/api/warehouse-locations/state' })).statusCode).toBe(200)
    expect(
      (
        await server.inject({
          method: 'POST',
          payload: {
            inventoryItemId: pkg.inventoryItemId,
            locationCode: 'EDI-A-1',
            source: 'audit',
          },
          url: '/api/warehouse-locations/assign',
        })
      ).statusCode,
    ).toBe(200)
    expect(mocks.assign).toHaveBeenCalledWith(
      expect.objectContaining({ requestedByUserId: 17 }),
    )
    await server.close()
  })

  it('allows a Viewer to read but denies assignment', async () => {
    mocks.role = 'viewer'
    const server = Fastify()
    await registerWarehouseLocationsRoutes(server)

    expect((await server.inject({ method: 'GET', url: '/api/warehouse-locations/state' })).statusCode).toBe(200)
    expect(
      (
        await server.inject({
          method: 'POST',
          payload: {
            inventoryItemId: pkg.inventoryItemId,
            locationCode: 'EDI-A-1',
            source: 'audit',
          },
          url: '/api/warehouse-locations/assign',
        })
      ).statusCode,
    ).toBe(403)
    expect(mocks.assign).not.toHaveBeenCalled()
    await server.close()
  })
})
