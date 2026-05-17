import type { FastifyInstance } from 'fastify'

import {
  ADS_DRIVE_FOLDER_ID,
  AdsIngestRequestSchema,
  AdsIngestResponseSchema,
  AdsStatusResponseSchema,
} from '../../shared/contracts/index.js'
import { findLatestCsv } from '../ads/googleDriveClient.js'
import { loadGoogleDriveApiKey } from '../ads/googleDriveSecrets.js'
import { getAdsStatus, triggerAdsDrivePoll } from '../ads/adsDrivePoller.js'
import { runAdsIngest, type AdsIngestError } from '../ads/runAdsIngest.js'
import { requireSessionUser } from '../auth/requireSession.js'

export async function registerAdsRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/ads/status', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const status = await getAdsStatus()
    return reply.send(AdsStatusResponseSchema.parse(status))
  })

  server.post('/api/ads/ingest', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const body = AdsIngestRequestSchema.parse(request.body ?? {})

    // Resolve the file ID -- either operator-pasted or auto-discovered
    // as the newest CSV in the canonical Drive folder.
    let fileIdOrUrl = body.driveFileUrlOrId
    if (!fileIdOrUrl) {
      const apiKey = loadGoogleDriveApiKey()
      if (!apiKey) {
        return reply.status(400).send({
          error:
            'No file URL/ID provided and no Drive API key configured for auto-discovery. ' +
            'Either paste a file URL/ID or add ~/.secret/google-drive/api-key.',
        })
      }
      try {
        const latest = await findLatestCsv(ADS_DRIVE_FOLDER_ID, apiKey)
        if (!latest) {
          return reply.status(404).send({
            error: 'No CSV files found in the Drive folder.',
          })
        }
        fileIdOrUrl = latest.id
      } catch (err) {
        return reply.status(502).send({
          error: 'Drive folder listing failed.',
          detail: (err as Error).message,
        })
      }
    }

    try {
      const result = await runAdsIngest(fileIdOrUrl)
      // Kick the poller so its in-memory status reflects the result
      // (and the persisted state file gets updated by it too).
      void triggerAdsDrivePoll()
      return reply.send(AdsIngestResponseSchema.parse(result))
    } catch (err) {
      const e = err as AdsIngestError
      request.log.error({ stderr: e.stderr }, 'ads ingest failed')
      return reply.status(502).send({
        error: 'Ingestion failed.',
        detail: e.detail ?? (err as Error).message,
      })
    }
  })
}
