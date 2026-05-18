/**
 * gitMirror — keep a local clone of a remote git repository in sync,
 * with periodic `git fetch` + atomic checkout to the latest origin/HEAD.
 *
 * Used by the parser-config loader to track the `helios-parser-configs`
 * repo at runtime. Pure shell-out to `git`; no libgit2 / isomorphic-git
 * dependency.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface MirrorOptions {
  /** SSH or HTTPS URL of the remote (e.g.
   *  `git@github-helios-parser-configs:FreshlyBakedNYC/helios-parser-configs.git`). */
  url: string
  /** Absolute path the mirror should live at. Parent dirs are created. */
  localDir: string
  /** Default branch on origin. Defaults to "master". */
  defaultBranch?: string
  /** Logger; defaults to a no-op. */
  log?: MirrorLogger
}

export interface MirrorLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void
  warn: (msg: string, meta?: Record<string, unknown>) => void
  error: (msg: string, meta?: Record<string, unknown>) => void
}

export interface FetchResult {
  /** Resolved commit sha after the fetch + checkout completed. */
  sha: string
  /** Sha that was checked out before this call (may equal `sha` if no
   *  new commits landed). */
  previousSha: string | null
  /** True when the local working tree was updated (sha changed). */
  changed: boolean
}

const NOOP_LOGGER: MirrorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * Ensure the mirror directory exists and is checked out at the latest
 * origin/`defaultBranch` commit. Clones on first call, fast-forwards
 * on subsequent calls. Always returns the post-condition sha.
 */
export async function syncMirror(opts: MirrorOptions): Promise<FetchResult> {
  const { url, localDir } = opts
  const branch = opts.defaultBranch ?? 'master'
  const log = opts.log ?? NOOP_LOGGER

  if (!isExistingClone(localDir)) {
    mkdirSync(dirname(localDir), { recursive: true })
    log.info('parser-configs: cloning', { url, localDir })
    runGit(['clone', '--quiet', '--single-branch', '--branch', branch, url, localDir], {
      cwd: dirname(localDir),
    })
    const sha = readSha(localDir)
    log.info('parser-configs: clone complete', { sha })
    return { sha, previousSha: null, changed: true }
  }

  const previousSha = readSha(localDir)
  runGit(['fetch', '--quiet', 'origin', branch], { cwd: localDir })

  // Hard-reset onto origin/<branch> so any accidental local edits are
  // overwritten. The clone is treated as cache, not a working tree.
  runGit(['reset', '--quiet', '--hard', `origin/${branch}`], { cwd: localDir })

  const sha = readSha(localDir)
  const changed = sha !== previousSha
  if (changed) {
    log.info('parser-configs: fast-forwarded', { previousSha, sha })
  }
  return { sha, previousSha, changed }
}

// ---------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------

function isExistingClone(dir: string): boolean {
  if (!existsSync(dir)) return false
  // Treat the directory as a clone iff it has a `.git` entry. Refusing
  // to "adopt" a random non-git directory keeps us from clobbering
  // unrelated files on a misconfigured path.
  try {
    return readdirSync(dir).includes('.git')
  } catch {
    return false
  }
}

function readSha(dir: string): string {
  const result = runGit(['rev-parse', 'HEAD'], { cwd: dir })
  return result.stdout.toString('utf8').trim()
}

interface RunOptions {
  cwd: string
}

function runGit(args: string[], opts: RunOptions): SpawnSyncReturns<Buffer> {
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (r.status !== 0) {
    const stderr = r.stderr?.toString('utf8') ?? ''
    const stdout = r.stdout?.toString('utf8') ?? ''
    const err = new Error(
      `git ${args.join(' ')} failed (status=${r.status})\nstderr:\n${stderr}\nstdout:\n${stdout}`,
    )
    ;(err as Error & { status: number | null }).status = r.status
    throw err
  }
  return r
}

/** Test seam — derive a useful subdir name from a remote URL. */
export function mirrorDirName(url: string): string {
  // e.g. git@github-foo:Owner/repo.git → repo
  const m = url.match(/[/:]([^/:]+?)(\.git)?$/)
  return m?.[1] ?? 'mirror'
}

export function defaultMirrorPath(rootDir: string, url: string): string {
  return join(rootDir, mirrorDirName(url))
}
