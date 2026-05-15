import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, resolve } from 'node:path'

import type { ProposalImportReviewJsonJobPayload } from '../../shared/contracts/domain/jobs.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import { withTransaction } from '../../server/db/tx.js'
import { importReviewPacket, readReviewPacketFromFile } from '../../server/proposals/reviewPacketImport.js'

export async function runProposalImportReviewJsonJob(
  context: JobHandlerContext,
  payload: ProposalImportReviewJsonJobPayload,
): Promise<void> {
  if (!isAbsolute(payload.filePath)) {
    throw new Error('Review packet import path must be absolute.')
  }

  const normalizedFilePath = resolve(payload.filePath)
  const packet = await readReviewPacketFromFile(normalizedFilePath)
  const requestId = randomUUID()

  await withTransaction(async (db) => {
    const result = await importReviewPacket(db, {
      createdByUserId: payload.requestedByUserId ?? null,
      importFileName: basename(normalizedFilePath),
      jobId: context.id,
      packet,
      requestId,
      sourcePath: normalizedFilePath,
    })

    await db.query(
      `
        update job_queue
        set payload_json = jsonb_set(payload_json, '{proposalBatchId}', to_jsonb($2::bigint), true),
            updated_at = now()
        where id = $1
      `,
      [context.id, result.proposalBatchId],
    )
  })
}
