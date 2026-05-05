import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import type { FastifyInstance } from 'fastify'

import { MutationAcceptedResponseSchema, QueueReviewPacketImportRequestSchema } from '../../shared/contracts/index.js'
import { sha256 } from '../../shared/util/hash.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { withTransaction } from '../db/tx.js'
import { enqueueJob } from '../jobs/enqueueJob.js'

export async function registerProposalImportRoutes(server: FastifyInstance): Promise<void> {
  server.post('/api/proposal-imports/review-json', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) {
      return
    }

    const body = QueueReviewPacketImportRequestSchema.parse(request.body ?? {})
    if (!isAbsolute(body.filePath)) {
      throw new Error('Review packet import path must be absolute.')
    }

    const normalizedFilePath = resolve(body.filePath)
    const requestId = randomUUID()

    const mutationResult = await withTransaction(async (db) => {
      const jobId = await enqueueJob(db, {
        concurrencyKey: 'proposal-import:review-json',
        dedupeKey: `proposal.import.review_json:${sha256(normalizedFilePath)}`,
        jobType: 'proposal.import.review_json',
        module: 'catalog',
        payload: {
          filePath: normalizedFilePath,
          requestedByUserId: user.id,
        },
        requestedByUserId: user.id,
      })

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(jobId),
        entityType: 'job',
        eventType: 'proposal.batch.import_requested',
        module: 'catalog',
        payload: {
          filePath: normalizedFilePath,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
        },
        requestId,
        undoPayload: null,
      })

      return { auditEventId, jobId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: mutationResult.auditEventId,
        jobId: mutationResult.jobId,
        requestId,
      }),
    )
  })
}
