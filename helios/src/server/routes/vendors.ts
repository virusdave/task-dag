import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  VendorCreateRequestSchema,
  VendorResponseSchema,
  VendorRouteParamsSchema,
  VendorsListResponseSchema,
  VendorUpdateRequestSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  createVendor,
  getVendorById,
  listVendors,
  updateVendor,
} from '../db/queries/vendorsQueries.js'
import { withTransaction } from '../db/tx.js'

export async function registerVendorRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/vendors', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    try {
      return reply.send(VendorsListResponseSchema.parse({ vendors: await listVendors(getPool()) }))
    } catch (error) {
      return surfaceVendorDbError(error, reply) ?? Promise.reject(error)
    }
  })

  server.post('/api/vendors', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const input = VendorCreateRequestSchema.parse(request.body ?? {})
    try {
      const vendor = await withTransaction(async (db) => {
        const vendorId = await createVendor(db, input)
        const created = await getVendorById(db, vendorId)
        if (!created) throw new Error('Vendor was not found after creation.')
        return created
      })
      return reply.status(201).send(VendorResponseSchema.parse({ vendor }))
    } catch (error) {
      return surfaceVendorDbError(error, reply) ?? Promise.reject(error)
    }
  })

  server.patch<{ Params: { vendorId: string } }>('/api/vendors/:vendorId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const { vendorId } = VendorRouteParamsSchema.parse(request.params)
    const input = VendorUpdateRequestSchema.parse(request.body ?? {})
    try {
      const vendor = await withTransaction(async (db) => {
        if (!(await updateVendor(db, vendorId, input))) return null
        return getVendorById(db, vendorId)
      })
      if (!vendor) return reply.status(404).send({ error: 'Vendor not found.' })
      return reply.send(VendorResponseSchema.parse({ vendor }))
    } catch (error) {
      return surfaceVendorDbError(error, reply) ?? Promise.reject(error)
    }
  })
}

function surfaceVendorDbError(error: unknown, reply: FastifyReply) {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null
  if (code === '23505') {
    return reply.status(409).send({
      error: 'That vendor name or primary brand assignment is already in use.',
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/relation .*vendors.* does not exist/i.test(message)) {
    return reply.status(503).send({
      error: 'Vendor tables are missing. Apply migration 104_vendor_brand_associations.sql.',
    })
  }
  return null
}
