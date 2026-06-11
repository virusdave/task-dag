import type { FastifyInstance } from 'fastify'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  InventoryProcurementRequestSchema,
  InventoryProcurementResponseSchema,
  InventorySkuHistoryRequestSchema,
  InventorySkuHistoryResponseSchema,
} from '../../shared/contracts/index.js'
import { requireMetricsGrant } from '../auth/requireSession.js'
import {
  INVENTORY_PROCUREMENT_DEFAULT_LEAD_DAYS,
  INVENTORY_PROCUREMENT_DEFAULT_WINDOW_DAYS,
  getInventoryProcurement,
  getInventorySkuHistory,
} from '../inventoryProcurement/inventoryProcurementQueries.js'

const KNOWN_DEALER_IDS = new Set<number>(
  HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => d.dealerId),
)

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

  // GET /api/inventory-procurement/sku-history?dealerId=&productId=&days=
  // On-demand per-SKU daily sales series for the row insight panel's
  // sparkline. Fetched only when a buyer expands a row, so the main
  // payload stays lean. Same 'reordering' grant.
  server.get('/api/inventory-procurement/sku-history', async (request, reply) => {
    const user = await requireMetricsGrant(request, reply, 'reordering')
    if (!user) return
    const parsed = InventorySkuHistoryRequestSchema.parse(request.query ?? {})
    if (!KNOWN_DEALER_IDS.has(parsed.dealerId)) {
      return reply.status(400).send({ error: `Unknown dealerId ${parsed.dealerId}.` })
    }
    const result = await getInventorySkuHistory({
      dealerId: parsed.dealerId,
      productId: parsed.productId,
      days: parsed.days ?? 90,
    })
    return reply.send(InventorySkuHistoryResponseSchema.parse(result))
  })
}
