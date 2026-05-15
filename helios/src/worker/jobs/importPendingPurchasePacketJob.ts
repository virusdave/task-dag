import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import type { CatalogPendingPurchasesImportJobPayload } from '../../shared/contracts/domain/jobs.js'
import { withTransaction } from '../../server/db/tx.js'
import {
  getPendingPurchaseImportFileName,
  importPendingPurchasePacket,
  readPendingPurchasePacketFromFile,
} from '../../server/pendingPurchases/pendingPurchasePacketImport.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

export async function runCatalogPendingPurchasesImportJob(
  context: JobHandlerContext,
  payload: CatalogPendingPurchasesImportJobPayload,
): Promise<void> {
  if (!isAbsolute(payload.filePath)) {
    throw new Error('Pending-purchase packet import path must be absolute.')
  }

  const normalizedFilePath = resolve(payload.filePath)
  const packet = await readPendingPurchasePacketFromFile(normalizedFilePath)
  const requestId = randomUUID()

  await withTransaction(async (db) => {
    const result = await importPendingPurchasePacket(db, {
      createdByUserId: payload.requestedByUserId ?? null,
      importFileName: getPendingPurchaseImportFileName(normalizedFilePath),
      jobId: context.id,
      packet,
      requestId,
      source: 'import',
      sourcePath: normalizedFilePath,
    })

    await db.query(
      `
        update job_queue
        set payload_json = jsonb_set(payload_json, '{pendingPurchasePacketId}', to_jsonb($2::bigint), true),
            updated_at = now()
        where id = $1
      `,
      [context.id, result.packetId],
    )
  })
}
