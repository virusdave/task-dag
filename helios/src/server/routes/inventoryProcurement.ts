import type { FastifyInstance } from 'fastify'

import {
  InventoryProcurementRequestSchema,
  InventoryProcurementResponseSchema,
} from '../../shared/contracts/index.js'
import { requireMetricsGrant } from '../auth/requireSession.js'
import {
  INVENTORY_PROCUREMENT_DEFAULT_LEAD_DAYS,
  INVENTORY_PROCUREMENT_DEFAULT_WINDOW_DAYS,
  getInventoryProcurement,
} from '../inventoryProcurement/inventoryProcurementQueries.js'

export async function registerInventoryProcurementRoutes(
  server: FastifyInstance,
): Promise<void> {
  // GET /api/inventory-procurement?windowDays=&defaultLeadDays=&sites=
  // Single consolidated endpoint powering the /metrics → "Inventory"
  // (Reordering) tab's four procurement views. Gated on the
  // 'reordering' metric grant. See inventoryProcurementQueries.ts.
  server.get('/api/inventory-procurement', async (request, reply) => {
    const user = await requireMetricsGrant(request, reply, 'reordering')
    if (!user) return
    const parsed = InventoryProcurementRequestSchema.parse(request.query ?? {})
    const result = await getInventoryProcurement({
      windowDays: parsed.windowDays ?? INVENTORY_PROCUREMENT_DEFAULT_WINDOW_DAYS,
      defaultLeadDays: parsed.defaultLeadDays ?? INVENTORY_PROCUREMENT_DEFAULT_LEAD_DAYS,
      sites: parsed.sites,
    })
    return reply.send(InventoryProcurementResponseSchema.parse(result))
  })
}
