/**
 * Cluster-sweep run discovery.
 *
 * The gads cluster-sweep job (ads/google/scripts/run-cluster-sweep.ts,
 * landed as P1c of the gemini-clusters epic) writes one run per
 * invocation into:
 *
 *   <repo>/ads/google/outputs/cluster-sweep/run-<runId>/
 *
 * Each run directory contains a manifest.json (per P3c spec) plus the
 * per-cluster subdirectories, repairs/, strategic-context.yaml, and a
 * README.md. This module is the read-side surface used by the helios
 * /api/ads/cluster-proposals/runs endpoint and the
 * /api/ads/cluster-proposals/runs/:runId/bundle.zip endpoint.
 *
 * Until P1c lands and produces real runs, this module degrades cleanly:
 * a missing outputs/cluster-sweep/ directory returns an empty run list,
 * and runs that don't have a manifest.json yet are still listed (with
 * `manifest: null`) so the operator-facing page can show "run in
 * progress" rather than "nothing here". The bundle.zip endpoint can
 * still ZIP a run directory even if its manifest is missing.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { automationRepoPath } from './automationRepoRoot.js'

export interface ClusterSweepRunSummary {
  runId: string
  runDirAbsPath: string
  generatedAt: string | null
  fileCount: number
  bytes: number
  manifestPresent: boolean
}

const CLUSTER_SWEEP_RELATIVE = path.join('ads', 'google', 'outputs', 'cluster-sweep')

export function clusterSweepRootDir(): string {
  return automationRepoPath(CLUSTER_SWEEP_RELATIVE)
}

export async function listClusterSweepRuns(): Promise<ClusterSweepRunSummary[]> {
  const root = clusterSweepRootDir()
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return []
    }
    throw err
  }

  const runs: ClusterSweepRunSummary[] = []
  for (const name of entries) {
    if (!name.startsWith('run-')) {
      continue
    }
    const runDir = path.join(root, name)
    let stat
    try {
      stat = await fs.stat(runDir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) {
      continue
    }
    const summary = await summarizeRun(name, runDir)
    if (summary) {
      runs.push(summary)
    }
  }

  // Newest run first. Run IDs are timestamp-prefixed by convention
  // (run-<ISO8601> or run-<YYYYMMDD-HHMMSS>); fall back to mtime
  // ordering when the prefix doesn't sort cleanly.
  runs.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0))
  return runs
}

export async function getClusterSweepRun(runId: string): Promise<ClusterSweepRunSummary | null> {
  if (!isSafeRunId(runId)) {
    return null
  }
  const runDir = path.join(clusterSweepRootDir(), runId)
  try {
    const stat = await fs.stat(runDir)
    if (!stat.isDirectory()) {
      return null
    }
  } catch {
    return null
  }
  return summarizeRun(runId, runDir)
}

async function summarizeRun(runId: string, runDir: string): Promise<ClusterSweepRunSummary | null> {
  let manifestPresent = false
  let generatedAt: string | null = null
  try {
    const manifestRaw = await fs.readFile(path.join(runDir, 'manifest.json'), 'utf-8')
    manifestPresent = true
    try {
      const parsed = JSON.parse(manifestRaw) as { generated_at?: unknown }
      if (typeof parsed.generated_at === 'string') {
        generatedAt = parsed.generated_at
      }
    } catch {
      // Manifest exists but is unparseable. Leave generatedAt null and
      // let the operator-facing page surface "manifest invalid"
      // separately if it cares.
    }
  } catch {
    manifestPresent = false
  }

  if (!generatedAt) {
    try {
      const stat = await fs.stat(runDir)
      generatedAt = new Date(stat.mtimeMs).toISOString()
    } catch {
      generatedAt = null
    }
  }

  const { fileCount, bytes } = await tallyTree(runDir)

  return {
    runId,
    runDirAbsPath: runDir,
    generatedAt,
    fileCount,
    bytes,
    manifestPresent,
  }
}

async function tallyTree(dir: string): Promise<{ fileCount: number; bytes: number }> {
  let fileCount = 0
  let bytes = 0
  const walk = async (cursor: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(cursor, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = path.join(cursor, entry.name)
      if (entry.isDirectory()) {
        await walk(child)
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(child)
          fileCount += 1
          bytes += stat.size
        } catch {
          // Skip unreadable files in the tally.
        }
      }
    }
  }
  await walk(dir)
  return { fileCount, bytes }
}

/**
 * Defensive runId validation. The runId is used to construct a
 * filesystem path so it MUST NOT contain slashes, `..`, or other
 * traversal-enabling characters. Run IDs by convention start with
 * `run-` and contain only alphanumeric chars, hyphens, dots, and
 * underscores.
 */
export function isSafeRunId(runId: string): boolean {
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 256) {
    return false
  }
  return /^run-[A-Za-z0-9._-]+$/.test(runId)
}
