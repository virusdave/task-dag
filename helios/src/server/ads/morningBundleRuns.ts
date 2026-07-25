/**
 * Morning-bundle ZIP discovery.
 *
 * The morning pipeline (`gads-run-morning`, baked into the system
 * closure) drops one ZIP per run into:
 *
 *   <repo>/ads/google/outputs/prod/bundle/run-<YYYY-MM-DD>-<shortid>.zip
 *
 * This module is the read-side surface for the Helios UI's
 * "Download latest morning ZIP" link and the runs index. The ZIPs
 * themselves are generated upstream by the pipeline -- we just list
 * what's on disk and stream the chosen file to the operator.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { configuredRepositoryPath } from './configuredRepositoryRoot.js'

export interface MorningBundleRunSummary {
  runId: string
  zipAbsPath: string
  generatedAt: string | null
  bytes: number
}

const BUNDLE_RELATIVE = path.join('ads', 'google', 'outputs', 'prod', 'bundle')

export function morningBundleRootDir(): string {
  return configuredRepositoryPath('automation', BUNDLE_RELATIVE)
}

export async function listMorningBundleRuns(): Promise<MorningBundleRunSummary[]> {
  const root = morningBundleRootDir()
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

  const runs: MorningBundleRunSummary[] = []
  for (const name of entries) {
    if (!name.startsWith('run-') || !name.endsWith('.zip')) {
      continue
    }
    const runId = name.slice(0, -'.zip'.length)
    if (!isSafeRunId(runId)) {
      continue
    }
    const zipPath = path.join(root, name)
    let stat
    try {
      stat = await fs.stat(zipPath)
    } catch {
      continue
    }
    if (!stat.isFile()) {
      continue
    }
    runs.push({
      runId,
      zipAbsPath: zipPath,
      generatedAt: new Date(stat.mtimeMs).toISOString(),
      bytes: stat.size,
    })
  }

  // Newest first. Run IDs sort sensibly by date prefix; fall back to
  // mtime if two share a date.
  runs.sort((a, b) => {
    if (a.runId === b.runId) return 0
    if (a.generatedAt && b.generatedAt && a.generatedAt !== b.generatedAt) {
      return a.generatedAt < b.generatedAt ? 1 : -1
    }
    return a.runId < b.runId ? 1 : -1
  })
  return runs
}

export async function getMorningBundleRun(runId: string): Promise<MorningBundleRunSummary | null> {
  if (!isSafeRunId(runId)) {
    return null
  }
  const zipPath = path.join(morningBundleRootDir(), `${runId}.zip`)
  let stat
  try {
    stat = await fs.stat(zipPath)
  } catch {
    return null
  }
  if (!stat.isFile()) {
    return null
  }
  return {
    runId,
    zipAbsPath: zipPath,
    generatedAt: new Date(stat.mtimeMs).toISOString(),
    bytes: stat.size,
  }
}

/**
 * Defensive runId validation. The runId is used to construct a
 * filesystem path so it MUST NOT contain slashes, `..`, or other
 * traversal-enabling characters. By convention morning-bundle run
 * IDs look like `run-2026-05-19-487446ad`.
 */
export function isSafeRunId(runId: string): boolean {
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 256) {
    return false
  }
  return /^run-[A-Za-z0-9._-]+$/.test(runId)
}
