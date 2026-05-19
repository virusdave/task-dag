/**
 * /api/ads/cluster-proposals/* routes.
 *
 * Surfaces the read-only side of the gemini-clusters epic
 * (docs/helios/gemini-clusters/EPIC_PLAN.md): list cluster-sweep runs
 * the gads cluster-sweep service (P1c) has written to disk, and serve
 * a bundle ZIP for any given run that the operator can download from
 * the Ads → Cluster proposals page in helios.
 *
 * The ZIP is generated on the fly in-process via `zipDirectoryToBuffer`
 * (see helios/src/server/ads/zipDirectory.ts). We deliberately don't
 * shell out to the system `zip` binary — it's not part of the helios
 * systemd unit's PATH and not declared as a dependency anywhere.
 */

import * as path from 'node:path'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  ClusterSweepRunsResponseSchema,
  ClusterSweepRunTriggerResponseSchema,
} from '../../shared/contracts/index.js'
import {
  getClusterSweepRun,
  isSafeRunId,
  listClusterSweepRuns,
} from '../ads/clusterSweepRuns.js'
import { triggerClusterSweep } from '../ads/clusterSweepTrigger.js'
import { zipDirectoryToBuffer } from '../ads/zipDirectory.js'
import { requireSessionUser } from '../auth/requireSession.js'

export async function registerAdsClusterProposalsRoutes(
  server: FastifyInstance,
): Promise<void> {
  server.get('/api/ads/cluster-proposals/runs', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const runs = await listClusterSweepRuns()
    return reply.send(
      ClusterSweepRunsResponseSchema.parse({
        runs: runs.map((r) => ({
          runId: r.runId,
          generatedAt: r.generatedAt,
          fileCount: r.fileCount,
          bytes: r.bytes,
          manifestPresent: r.manifestPresent,
        })),
      }),
    )
  })

  server.get(
    '/api/ads/cluster-proposals/runs/:runId/bundle.zip',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'viewer')
      if (!user) {
        return
      }
      const { runId } = request.params as { runId: string }
      if (!isSafeRunId(runId)) {
        return reply.status(400).send({ error: 'invalid runId' })
      }
      const run = await getClusterSweepRun(runId)
      if (!run) {
        return reply.status(404).send({ error: 'run not found' })
      }
      return sendZipForRun(reply, run.runDirAbsPath, runId)
    },
  )

  server.post('/api/ads/cluster-proposals/sweep/run', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const result = await triggerClusterSweep()
    return reply.send(ClusterSweepRunTriggerResponseSchema.parse(result))
  })

  // Latest-run convenience: same as above but resolves the latest run
  // server-side so the UI can offer a single "Download latest" link
  // that always points at the freshest sweep without the client
  // having to round-trip the runs index first.
  server.get(
    '/api/ads/cluster-proposals/latest/bundle.zip',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await requireSessionUser(request, reply, 'viewer')
      if (!user) {
        return
      }
      const runs = await listClusterSweepRuns()
      const latest = runs[0]
      if (!latest) {
        return reply.status(404).send({ error: 'no cluster-sweep runs yet' })
      }
      return sendZipForRun(reply, latest.runDirAbsPath, latest.runId)
    },
  )
}

async function sendZipForRun(
  reply: FastifyReply,
  runDir: string,
  runId: string,
): Promise<void> {
  const filename = `${runId}.bundle.zip`
  try {
    const buf = await zipDirectoryToBuffer(runDir)
    reply
      .header('Content-Type', 'application/zip')
      .header(
        'Content-Disposition',
        `attachment; filename="${path.basename(filename)}"`,
      )
      .header('Content-Length', buf.byteLength)
    return reply.send(buf)
  } catch (err) {
    reply.log.error({ runDir, runId, err }, 'cluster-bundle zip failed')
    return reply.status(500).send({ error: 'failed to build cluster bundle' })
  }
}
