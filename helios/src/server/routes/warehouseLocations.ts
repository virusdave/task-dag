import type { FastifyInstance } from 'fastify'

import {
  WarehouseLocationAssignRequestSchema,
  WarehouseLocationAssignResponseSchema,
  WarehouseLocationsStateResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { invalidateCatalogMaintenanceSurvey } from '../catalog/maintenance.js'
import {
  assignWarehouseLocation,
  HttpError,
  loadWarehouseLocationsState,
} from '../warehouse/locations.js'
import { pageDave } from '../../worker/runtime/pageDave.js'

/**
 * Page Dave about a warehouse-location assign failure. Fire-and-forget:
 * paging must never break the operator's request, so a paging error is
 * swallowed (logged only).
 *
 * Priority maps incident severity → ntfy priority (ntfy: 1=min … 5=max/urgent,
 * which is INVERTED from "P1 is most urgent" pager-speak):
 *   - P1 (most urgent) → ntfy 5: an unexpected exception or a 5xx Sweed/server
 *     failure — the write path is broken.
 *   - P2 (urgent)      → ntfy 4: a partial failure (some packages in a batch
 *     could not be written) — the floor state is now inconsistent.
 * User-correctable 4xx (bad input / no matching package) do NOT page.
 */
function pageDaveAboutAssignFailure(args: {
  ntfyPriority: 4 | 5
  title: string
  message: string
}): void {
  void pageDave(args.message, { priority: args.ntfyPriority, title: args.title }).catch((error) => {
    console.error('warehouse-locations: page-dave failed (assignment outcome stands)', error)
  })
}

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
    // Validate up front and return a clean 400 (rather than letting a thrown
    // ZodError escape to the generic 500 handler — a bad body is operator-
    // correctable input, not a server fault, so it must not page Dave either).
    const parsedBody = WarehouseLocationAssignRequestSchema.safeParse(request.body ?? {})
    if (!parsedBody.success) {
      return reply
        .status(400)
        .send({ error: parsedBody.error.issues[0]?.message ?? 'Invalid assignment request.' })
    }
    const body = parsedBody.data
    const targetLabel = body.inventoryItemId
      ? `package ${body.inventoryItemId}`
      : `scan "${body.scannedCode ?? '?'}"`
    try {
      const result = await assignWarehouseLocation({
        locationCode: body.locationCode,
        source: body.source,
        scannedCode: body.scannedCode,
        inventoryItemId: body.inventoryItemId,
        allowReassign: body.allowReassign,
        requestedByUserId: user.id,
      })
      // Partial failure: some matched packages assigned, others could not be
      // written. The request still returns 200 (successes are real), but the
      // floor is now inconsistent — page Dave at P2 so it isn't lost silently.
      if (result.failures.length > 0) {
        const first = result.failures[0]!
        pageDaveAboutAssignFailure({
          ntfyPriority: 4,
          title: 'Warehouse shelf assign: partial failure',
          message:
            `${result.failures.length} package(s) could NOT be assigned to ${body.locationCode} ` +
            `(${body.source}, ${targetLabel}). ${result.packages.length} succeeded. ` +
            `First failure: ${first.productName ?? first.inventoryItemId} — ${first.reason}.`,
        })
      }
      // A shelf set from the Images & Barcodes page changes a lot's
      // warehouseLocationCode, which is baked into that page's cached survey.
      // Drop the cache so a reload within the TTL shows the new shelf. Gated to
      // `images-page` only: the high-frequency warehouse packing flow would
      // otherwise thrash this (expensive) survey cache for no benefit — those
      // shelves surface on the next natural survey rebuild anyway. Best-effort.
      if (body.source === 'images-page' && result.packages.length > 0) {
        void invalidateCatalogMaintenanceSurvey().catch((error) => {
          console.error(
            'warehouse-locations: failed to invalidate catalog maintenance survey cache',
            error,
          )
        })
      }
      return reply.send(WarehouseLocationAssignResponseSchema.parse(result))
    } catch (error) {
      if (error instanceof HttpError) {
        // 5xx is a broken write path (Sweed rejected every package, server
        // fault) — page Dave at P1. User-correctable 4xx (bad input, nothing
        // matched the scan) is shown to the operator and does NOT page.
        if (error.status >= 500) {
          pageDaveAboutAssignFailure({
            ntfyPriority: 5,
            title: 'Warehouse shelf assign: write failed',
            message:
              `Assign to ${body.locationCode} failed (${body.source}, ${targetLabel}, ` +
              `HTTP ${error.status}): ${error.message}`,
          })
        }
        return reply.status(error.status).send({ error: error.message })
      }
      // Unexpected exception — the route is about to 500. Page Dave at P1.
      pageDaveAboutAssignFailure({
        ntfyPriority: 5,
        title: 'Warehouse shelf assign: unexpected error',
        message:
          `Unexpected error assigning ${body.locationCode} (${body.source}, ${targetLabel}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      })
      throw error
    }
  })
}
