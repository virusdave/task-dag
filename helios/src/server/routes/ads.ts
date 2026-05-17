import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { promisify } from 'node:util'

import type { FastifyInstance } from 'fastify'

import {
  AdsIngestRequestSchema,
  AdsIngestResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'

const execFileP = promisify(execFile)

// Resolve repo root from this file's location. In dev/build:
//   helios/src/server/routes/ads.ts  -> ../../../../   == repo root
//   helios/dist/server/routes/ads.js -> ../../../../   == repo root
// So 4 levels up works for either layout.
const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '../../../..')
const INGEST_SCRIPT = path.join(REPO_ROOT, 'ads/google/scripts/ingest-drive-export.sh')

// Generous timeout: the full pipeline downloads from Drive, runs two
// Python steps over ~200 ads, and uploads HTML. Comfortably under 5 min
// in practice; cap at 5 min to keep the request from hanging forever.
const TIMEOUT_MS = 5 * 60 * 1000

export async function registerAdsRoutes(server: FastifyInstance): Promise<void> {
  server.post('/api/ads/ingest', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const body = AdsIngestRequestSchema.parse(request.body ?? {})

    let stdout = ''
    let stderr = ''
    try {
      const result = await execFileP(INGEST_SCRIPT, [body.driveFileUrlOrId], {
        timeout: TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      })
      stdout = result.stdout
      stderr = result.stderr
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
      request.log.error(
        { code: e.code, stderr: e.stderr, stdout: e.stdout },
        'ads ingest script failed',
      )
      return reply.status(502).send({
        error: 'Ingestion failed.',
        detail: (e.stderr || e.message || '').trim().slice(-4000),
      })
    }

    // The script prints a one-line JSON object on stdout; everything
    // else (progress, upload-to-mss banner) goes to stderr.
    const lastLine = stdout.trim().split(/\r?\n/).pop() ?? ''
    let parsed: unknown
    try {
      parsed = JSON.parse(lastLine)
    } catch {
      request.log.error({ stdout, stderr }, 'ads ingest script produced non-JSON stdout')
      return reply.status(502).send({
        error: 'Ingestion finished but produced no parseable result.',
        detail: stderr.trim().slice(-4000),
      })
    }
    return reply.send(AdsIngestResponseSchema.parse(parsed))
  })
}
