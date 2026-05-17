import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Resolves the broader automation repo root (the directory that
 * contains helios/, ads/, scripts/ etc.) regardless of whether helios
 * is running from src (under tsx) or from dist (built).
 *
 * Lookup order:
 *   1. AUTOMATION_REPO_ROOT env var (production override).
 *   2. Nearest ancestor directory named "helios" -> its parent.
 *
 * Throws if neither finds a usable directory; helios should surface
 * the error to the operator rather than guess.
 */
let cached: string | null = null

export function getAutomationRepoRoot(): string {
  if (cached) {
    return cached
  }
  const fromEnv = process.env.AUTOMATION_REPO_ROOT?.trim()
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) {
      throw new Error(`AUTOMATION_REPO_ROOT=${fromEnv} does not exist on disk.`)
    }
    cached = path.resolve(fromEnv)
    return cached
  }
  // Walk up from this module's path until we find a directory whose
  // basename is "helios"; the parent of that is the automation root.
  const here = path.dirname(fileURLToPath(import.meta.url))
  let cursor = here
  for (let i = 0; i < 20; i++) {
    if (path.basename(cursor) === 'helios') {
      cached = path.dirname(cursor)
      return cached
    }
    const next = path.dirname(cursor)
    if (next === cursor) {
      break
    }
    cursor = next
  }
  throw new Error(
    `Could not locate the automation repo root above ${here}. ` +
      `Set AUTOMATION_REPO_ROOT to point at the directory that contains helios/ and ads/.`,
  )
}

export function automationRepoPath(...segments: string[]): string {
  return path.join(getAutomationRepoRoot(), ...segments)
}
