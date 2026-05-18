/**
 * /api/ads/cluster-proposals/* routes.
 *
 * Surfaces the read-only side of the gemini-clusters epic
 * (docs/helios/gemini-clusters/EPIC_PLAN.md): list cluster-sweep runs
 * the gads cluster-sweep service (P1c) has written to disk, and serve
 * a bundle ZIP for any given run that the operator can download from
 * the Ads → Cluster proposals page in helios.
 *
 * The ZIP is generated on the fly by spawning the system `zip`
 * binary against the run directory and piping its stdout straight to
 * the response. This avoids pulling a node zip dependency into the
 * helios package and matches the rest of the gads/helios surface
 * which already shells out to external tooling for batch CSV builds.
 */

import { spawn } from 'node:child_process'
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
      return streamZipForRun(reply, run.runDirAbsPath, runId)
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
      return streamZipForRun(reply, latest.runDirAbsPath, latest.runId)
    },
  )
}

function streamZipForRun(reply: FastifyReply, runDir: string, runId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // `zip -r -q - .` writes a ZIP of the current directory to stdout
    // ('-' as the archive name) recursively (-r) and quietly (-q).
    // We `cwd` into the run dir so the entries inside the archive
    // are rooted at the run dir's children (manifest.json,
    // clusters/, repairs/, ...) without a redundant top-level
    // run-<id>/ prefix that an operator unzipping into a fresh
    // working directory would have to strip.
    const child = spawn('zip', ['-r', '-q', '-', '.'], {
      cwd: runDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const filename = `${runId}.bundle.zip`
    reply.raw.setHeader('Content-Type', 'application/zip')
    reply.raw.setHeader(
      'Content-Disposition',
      `attachment; filename="${path.basename(filename)}"`,
    )
    // Status must be set BEFORE we start piping stdout into reply.raw
    // because the headers are committed on the first write.
    reply.raw.statusCode = 200

    child.stdout.pipe(reply.raw, { end: false })

    let stderrBuf = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8')
    })

    child.on('error', (err) => {
      // spawn() itself failed (e.g. `zip` not on PATH). Headers may or
      // may not have been sent depending on timing; fastify will close
      // the socket cleanly either way.
      reject(err)
    })

    child.on('close', (code, signal) => {
      if (code === 0) {
        reply.raw.end()
        resolve()
        return
      }
      const reason =
        signal !== null
          ? `zip terminated by signal ${signal}`
          : `zip exited with code ${code}`
      // We've already committed the 200 + zip content-type, so the
      // best we can do on partial failure is close the socket to let
      // the client see a truncated body. Log the stderr so a future
      // operator can diagnose.
      reply.log.error({ runDir, runId, stderr: stderrBuf, reason }, 'cluster-bundle zip failed')
      reply.raw.end()
      resolve()
    })
  })
}
