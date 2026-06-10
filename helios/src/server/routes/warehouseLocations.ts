import type { FastifyInstance } from 'fastify'

import {
  WarehouseLocationAssignRequestSchema,
  WarehouseLocationAssignResponseSchema,
  WarehouseLocationsStateResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import {
  assignWarehouseLocation,
  HttpError,
  loadWarehouseLocationsState,
} from '../warehouse/locations.js'

export async function registerWarehouseLocationsRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/warehouse-locations/state', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const state = await loadWarehouseLocationsState()
    return reply.send(WarehouseLocationsStateResponseSchema.parse(state))
  })

  server.post('/api/warehouse-locations/assign', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const body = WarehouseLocationAssignRequestSchema.parse(request.body ?? {})
    try {
      const result = await assignWarehouseLocation({
        locationCode: body.locationCode,
        source: body.source,
        scannedCode: body.scannedCode,
        inventoryItemId: body.inventoryItemId,
        allowReassign: body.allowReassign,
        requestedByUserId: user.id,
      })
      return reply.send(WarehouseLocationAssignResponseSchema.parse(result))
    } catch (error) {
      if (error instanceof HttpError) {
        return reply.status(error.status).send({ error: error.message })
      }
      throw error
    }
  })
}
