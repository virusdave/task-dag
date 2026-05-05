import { basename, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { closePool } from '../src/server/db/pool.js'
import { withTransaction } from '../src/server/db/tx.js'
import { importReviewPacket, readReviewPacketFromFile } from '../src/server/proposals/reviewPacketImport.js'

const reviewPacketPath = process.argv[2]
if (!reviewPacketPath) {
  throw new Error('Usage: npm run import:review -- /absolute/path/to/review.json')
}

const normalizedReviewPacketPath = resolve(reviewPacketPath)
const packet = await readReviewPacketFromFile(normalizedReviewPacketPath)
const requestId = randomUUID()

try {
  const importResult = await withTransaction(async (db) => {
    return importReviewPacket(db, {
      createdByUserId: null,
      importFileName: basename(normalizedReviewPacketPath),
      jobId: null,
      packet,
      requestId,
      sourcePath: normalizedReviewPacketPath,
    })
  })

  console.log(
    `Imported ${importResult.importedLineItemCount} line items across ${importResult.importedGroupCount} groups into batch #${importResult.proposalBatchId}. Audit event #${importResult.auditEventId}.`,
  )
} finally {
  await closePool()
}
