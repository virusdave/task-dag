import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import {
  CatalogMaintenanceCacheRepairResponseSchema,
  CatalogMaintenanceSurveyResponseSchema,
  CatalogMaintenanceUpdateBarcodeRequestSchema,
  CatalogMaintenanceUpdateBarcodeResponseSchema,
  CatalogMaintenanceUploadResultSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import {
  enqueueCacheRepairJobs,
  HttpError,
  loadCatalogMaintenanceSurvey,
  updateVariantBarcode,
  uploadCatalogMaintenanceImage,
} from '../catalog/maintenance.js'

const RefreshQuerySchema = z.object({
  refresh: z.union([z.literal('1'), z.literal('true')]).optional(),
})

interface UploadFormFields {
  targetType: 'group' | 'variants'
  groupId: number
  productIds: number[]
  fileBytes: Uint8Array
  contentType: string
}

export async function registerCatalogMaintenanceRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/catalog/maintenance/survey', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const query = RefreshQuerySchema.parse(request.query)
    const response = await loadCatalogMaintenanceSurvey({ forceRefresh: query.refresh !== undefined })
    return reply.send(CatalogMaintenanceSurveyResponseSchema.parse(response))
  })

  server.post('/api/catalog/maintenance/cache-repair', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const response = await enqueueCacheRepairJobs(user.id)
    return reply.send(CatalogMaintenanceCacheRepairResponseSchema.parse(response))
  })

  server.post('/api/catalog/maintenance/barcode', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const body = CatalogMaintenanceUpdateBarcodeRequestSchema.parse(request.body ?? {})
    try {
      const result = await updateVariantBarcode({
        externalBarcode: body.externalBarcode,
        productId: body.productId,
        sweedGroupId: body.sweedGroupId,
        requestedByUserId: user.id,
      })
      return reply.send(
        CatalogMaintenanceUpdateBarcodeResponseSchema.parse({
          externalBarcode: result.externalBarcode,
          productId: result.productId,
          reanalysisJobId: result.reanalysisJobId,
        }),
      )
    } catch (error) {
      if (error instanceof HttpError) {
        return reply.status(error.status).send({ error: error.message })
      }
      throw error
    }
  })

  server.post('/api/catalog/maintenance/images', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: 'multipart/form-data required.' })
    }
    let fields: UploadFormFields
    try {
      fields = await collectUploadFields(request)
    } catch (error) {
      if (error instanceof HttpError) {
        return reply.status(error.status).send({ error: error.message })
      }
      throw error
    }
    try {
      const result = await uploadCatalogMaintenanceImage({
        contentType: fields.contentType,
        fileBytes: fields.fileBytes,
        groupId: fields.groupId,
        productIds: fields.productIds,
        targetType: fields.targetType,
        requestedByUserId: user.id,
      })
      return reply.send(
        CatalogMaintenanceUploadResultSchema.parse({
          affectedProductIds: result.affectedProductIds,
          blobUrl: result.blobUrl,
          groupId: fields.groupId,
          targetType: fields.targetType,
          uploadedBlobId: result.uploadedBlobId,
          reanalysisJobId: result.reanalysisJobId,
        }),
      )
    } catch (error) {
      if (error instanceof HttpError) {
        return reply.status(error.status).send({ error: error.message })
      }
      throw error
    }
  })
}

async function collectUploadFields(request: FastifyRequest): Promise<UploadFormFields> {
  let targetType: 'group' | 'variants' | null = null
  let groupId: number | null = null
  let productIds: number[] = []
  let fileBytes: Uint8Array | null = null
  let contentType: string | null = null

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (part.fieldname !== 'file') {
        await part.toBuffer()
        continue
      }
      const buffer = await part.toBuffer()
      fileBytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      contentType = part.mimetype
      continue
    }

    const value = typeof part.value === 'string' ? part.value : ''
    switch (part.fieldname) {
      case 'targetType':
        if (value === 'group' || value === 'variants') {
          targetType = value
        }
        break
      case 'groupId': {
        const parsed = Number(value)
        if (Number.isInteger(parsed)) {
          groupId = parsed
        }
        break
      }
      case 'productIds': {
        productIds = parseProductIds(value)
        break
      }
      default:
        break
    }
  }

  if (targetType === null) {
    throw new HttpError(400, 'targetType (group|variants) is required.')
  }
  if (groupId === null) {
    throw new HttpError(400, 'groupId is required.')
  }
  if (fileBytes === null || contentType === null) {
    throw new HttpError(400, 'file is required.')
  }
  if (targetType === 'variants' && productIds.length === 0) {
    throw new HttpError(400, 'productIds is required for variant uploads.')
  }

  return { contentType, fileBytes, groupId, productIds, targetType }
}

function parseProductIds(value: string): number[] {
  const trimmed = value.trim()
  if (trimmed.length === 0) return []
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed.map(toInt).filter((value): value is number => value !== null)
      }
    } catch {
      // fall through to comma split
    }
  }
  return trimmed
    .split(',')
    .map((piece) => toInt(piece.trim()))
    .filter((value): value is number => value !== null)
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) return parsed
  }
  return null
}
