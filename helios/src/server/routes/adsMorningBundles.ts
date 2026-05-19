/**
 * /api/ads/morning-bundles/* routes.
 *
 * Operator surface for the daily morning-bundle pipeline (the
 * `gads-run-analysis.service` unit). Backs three controls on the
 * Ads ingest page:
 *
 *   - "Run morning pipeline now" button  -> POST /run
 *   - "Download latest morning ZIP" link -> GET  /latest.zip
 *   - the runs list / per-run downloads  -> GET  /runs
 *                                          GET  /runs/:runId.zip
 *
 * The pipeline writes ZIPs to ads/google/outputs/prod/bundle/; this
 * module just discovers and streams them. The trigger goes through
 * a sudo-whitelisted nix-built wrapper, never python and never raw
 * systemctl. See morningBundleTrigger.ts for the trigger surface.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  MorningBundleRunsResponseSchema,
  MorningBundleRunTriggerResponseSchema,
} from '../../shared/contracts/index.js'
import {
  getMorningBundleRun,
  isSafeRunId,
  listMorningBundleRuns,
} from '../ads/morningBundleRuns.js'
import { triggerMorningBundle } from '../ads/morningBundleTrigger.js'
import { requireSessionUser } from '../auth/requireSession.js'

export async function registerAdsMorningBundlesRoutes(
  server: FastifyInstance,
): Promise<void> {
  server.get('/api/ads/morning-bundles/runs', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const runs = await listMorningBundleRuns()
    return reply.send(
      MorningBundleRunsResponseSchema.parse({
        runs: runs.map((r) => ({
          runId: r.runId,
          generatedAt: r.generatedAt,
          bytes: r.bytes,
        })),
      }),
    )
  })

  server.post('/api/ads/morning-bundles/run', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const result = await triggerMorningBundle()
    return reply.send(MorningBundleRunTriggerResponseSchema.parse(result))
  })

  server.get('/api/ads/morning-bundles/latest.zip', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const runs = await listMorningBundleRuns()
    const latest = runs[0]
    if (!latest) {
      return reply.status(404).send({ error: 'no morning-bundle runs yet' })
    }
    return streamZip(reply, latest.zipAbsPath, `${latest.runId}.zip`)
  })

  server.get(
    '/api/ads/morning-bundles/runs/:runId.zip',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'viewer')
      if (!user) {
        return
      }
      const { runId } = request.params as { runId: string }
      if (!isSafeRunId(runId)) {
        return reply.status(400).send({ error: 'invalid runId' })
      }
      const run = await getMorningBundleRun(runId)
      if (!run) {
        return reply.status(404).send({ error: 'run not found' })
      }
      return streamZip(reply, run.zipAbsPath, `${run.runId}.zip`)
    },
  )
}

function streamZip(reply: FastifyReply, zipPath: string, downloadName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stat: fs.Stats
    try {
      stat = fs.statSync(zipPath)
    } catch (err) {
      reject(err)
      return
    }

    reply.raw.setHeader('Content-Type', 'application/zip')
    reply.raw.setHeader('Content-Length', String(stat.size))
    reply.raw.setHeader(
      'Content-Disposition',
      `attachment; filename="${path.basename(downloadName)}"`,
    )
    reply.raw.statusCode = 200

    const stream = fs.createReadStream(zipPath)
    stream.on('error', (err) => {
      reply.log.error({ zipPath, err }, 'morning-bundle zip stream failed')
      reply.raw.end()
      resolve()
    })
    stream.on('end', () => {
      reply.raw.end()
      resolve()
    })
    stream.pipe(reply.raw, { end: false })
  })
}
