/**
 * Second read-only git mirror — `virusdave/top-level` (issue #60, child
 * epic #3 of the agent-waste review queue).
 *
 * The agent-waste pending-review backlog is exported by github-worker into
 * a small git file co-located with `docs/agent-runtime/advisories.yaml` in
 * `virusdave/top-level` (operator decisions D1/D2 — see
 * docs/helios/agent-waste-review/RESOLVED_DESIGN.md). Helios reads it
 * read-only. The production Helios deploy is an artifact tarball with
 * `.git` stripped, so — exactly like the task-DAG mirror — we maintain our
 * OWN lightweight bare mirror of top-level under the helios state dir and
 * refresh it on a timer. The backlog reader (agentWasteRepo backlog reader
 * leaf) reads the exported file out of whatever git dir this module
 * exposes.
 *
 * This is a SECOND, independent mirror alongside taskDagMirror.ts (which
 * mirrors `automation`); it uses the same proven pattern but its own
 * config, its own bare dir, and its own read-only deploy key.
 *
 * Loud-but-non-fatal (taskDagMirror semantics): a fetch failure keeps the
 * last-good mirror in place and is surfaced as a "stale"/"unavailable"
 * status rather than crashing the server. The consumer degrades to a
 * structured 503, never a raw 500.
 *
 * Config (env):
 *   HELIOS_TOP_LEVEL_REPO_URL        git URL to mirror (default: top-level)
 *   HELIOS_TOP_LEVEL_LOCAL_DIR       bare mirror dir (pins mirror mode)
 *   HELIOS_TOP_LEVEL_REFRESH_SECONDS refresh cadence (default 60)
 *   HELIOS_TOP_LEVEL_DEPLOY_KEY      ssh key with read access to top-level
 *   HELIOS_TOP_LEVEL_DISABLE         set truthy to disable entirely
 *
 * In local dev (no LOCAL_DIR configured) the module falls back to reading
 * an existing top-level checkout at TOP_LEVEL_REPO_PATH if it happens to be
 * a real git repo, so a developer with a normal checkout needs no extra
 * setup.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const execFileAsync = promisify(execFile)

const DEFAULT_REPO_URL = 'git@github.com:virusdave/top-level.git'
const DEFAULT_REFRESH_SECONDS = 60

/**
 * The default branch top-level backlog/advisory files live on. Canon's
 * default branch is `master` fleet-wide.
 */
export const TOP_LEVEL_DEFAULT_REF = 'master'

/**
 * Conventional agenix path for the top-level READ-ONLY deploy key on the
 * Helios prod host (vps-nixos-3), provisioned for the `helios` service user
 * by child epic #1 (D2). Same shape as the automation read key at
 * `/run/agenix/helios-github-automation-deploy-key` that taskDagMirror.ts
 * reads. We treat the presence of this file as the signal that we are
 * running in prod and should self-enable mirror mode even when no
 * HELIOS_TOP_LEVEL_* env vars are wired, so a helios-only deploy is
 * sufficient once the key is present.
 */
const CONVENTIONAL_DEPLOY_KEY = '/run/agenix/helios-github-top-level-deploy-key'

export interface TopLevelMirrorSourceStatus {
  /** True when a usable git dir is currently readable. */
  available: boolean
  /** Where the data comes from. */
  mode: 'mirror' | 'local-checkout' | 'none'
  /** Epoch ms of the last fetch attempt (mirror mode only). */
  lastAttemptAtMs: number | null
  /** Epoch ms of the last successful fetch (mirror mode only). */
  lastSuccessAtMs: number | null
  /** Last fetch error message, if the most recent attempt failed. */
  lastError: string | null
}

export interface TopLevelMirrorLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void
  warn: (msg: string, meta?: Record<string, unknown>) => void
  error: (msg: string, meta?: Record<string, unknown>) => void
}

interface MirrorConfig {
  repoUrl: string
  localDir: string
  refreshMs: number
  deployKey: string | null
}

let config: MirrorConfig | null = null
let log: TopLevelMirrorLogger | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null

const status: TopLevelMirrorSourceStatus = {
  available: false,
  mode: 'none',
  lastAttemptAtMs: null,
  lastSuccessAtMs: null,
  lastError: null,
}

function envStr(name: string): string | null {
  const v = (process.env[name] ?? '').trim()
  return v === '' ? null : v
}

function envBool(name: string): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Build the env for git subprocesses, routing through the read key. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (config?.deployKey) {
    env.GIT_SSH_COMMAND =
      `ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=accept-new ` +
      `-o IdentitiesOnly=yes -i ${config.deployKey}`
  }
  return env
}

async function runGit(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: gitEnv(),
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}

function isBareRepo(dir: string): boolean {
  // A `git clone --mirror` target is a bare repo: HEAD + objects/ + refs/
  // live directly in the dir.
  return fs.existsSync(path.join(dir, 'HEAD')) && fs.existsSync(path.join(dir, 'objects'))
}

function isWorkingRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'))
}

/**
 * Resolve the git dir the backlog reader should read from, or null if no
 * source is available. In mirror mode this is the bare mirror; in dev it
 * may be a plain checkout.
 */
export function getTopLevelMirrorDir(): string | null {
  if (config && isBareRepo(config.localDir)) {
    return config.localDir
  }
  // Dev fallback: a real checkout at TOP_LEVEL_REPO_PATH.
  const repoPath = envStr('TOP_LEVEL_REPO_PATH')
  if (repoPath && (isWorkingRepo(repoPath) || isBareRepo(repoPath))) {
    return repoPath
  }
  return null
}

export function getTopLevelMirrorSourceStatus(): TopLevelMirrorSourceStatus {
  // Recompute availability lazily so dev-mode (no mirror config) still
  // reports correctly without a refresh loop.
  if (!config) {
    const dir = getTopLevelMirrorDir()
    return {
      ...status,
      available: dir != null,
      mode: dir != null ? 'local-checkout' : 'none',
    }
  }
  return { ...status, available: isBareRepo(config.localDir) }
}

/**
 * Read a file at `relPath` from the mirrored top-level default branch.
 * Returns the file contents, or null when the file does not exist on that
 * ref. Throws when no mirror dir is available or git otherwise fails, so
 * the caller can distinguish "source unreadable" (surface as unavailable)
 * from "file absent" (fail-safe empty).
 *
 * Works against both a bare mirror (no worktree) and a dev checkout by
 * addressing the blob through `git show <ref>:<relPath>`.
 */
export async function readTopLevelFile(relPath: string): Promise<string | null> {
  const dir = getTopLevelMirrorDir()
  if (dir == null) {
    throw new Error('top-level mirror is not available')
  }
  // Normalise to forward slashes; git object paths are always POSIX.
  const objPath = relPath.replace(/^\.?\/+/, '').split(path.sep).join('/')
  try {
    return await runGit(dir, ['show', `${TOP_LEVEL_DEFAULT_REF}:${objPath}`], 30_000)
  } catch (err) {
    // `git show` exits non-zero for a path that does not exist on the ref.
    // Distinguish that (return null → fail-safe empty) from a genuine
    // failure (re-throw → surface unavailable). Node's execFile appends
    // stderr to the error message, but inspect stderr explicitly too.
    const stderr =
      typeof (err as { stderr?: unknown }).stderr === 'string'
        ? ((err as { stderr: string }).stderr)
        : ''
    const msg = `${errMessage(err)}\n${stderr}`
    if (/does not exist|exists on disk, but not in|no such path|fatal: path/i.test(msg)) {
      return null
    }
    throw err
  }
}

/**
 * Decide whether to run in mirror mode and with what settings, or return
 * null to defer to a local checkout / unavailable. Mirror mode activates
 * when either an explicit local dir is pinned, or we detect the prod
 * deploy key and there is no usable local git checkout to read instead.
 */
function resolveMirrorConfig(): MirrorConfig | null {
  const refreshMs =
    (Number(envStr('HELIOS_TOP_LEVEL_REFRESH_SECONDS')) || DEFAULT_REFRESH_SECONDS) * 1000
  const repoUrl = envStr('HELIOS_TOP_LEVEL_REPO_URL') ?? DEFAULT_REPO_URL
  const explicitLocalDir = envStr('HELIOS_TOP_LEVEL_LOCAL_DIR')
  const deployKey =
    envStr('HELIOS_TOP_LEVEL_DEPLOY_KEY') ??
    (fs.existsSync(CONVENTIONAL_DEPLOY_KEY) ? CONVENTIONAL_DEPLOY_KEY : null)

  // Prefer reading a real local checkout when one exists and the operator
  // hasn't explicitly pinned a mirror dir (typical dev box).
  const repoPath = envStr('TOP_LEVEL_REPO_PATH')
  const hasLocalCheckout = repoPath != null && (isWorkingRepo(repoPath) || isBareRepo(repoPath))
  if (!explicitLocalDir && hasLocalCheckout) return null

  // Mirror mode needs somewhere to fetch from: an explicit dir override or
  // a usable deploy key (the prod signal).
  if (!explicitLocalDir && !deployKey) return null

  const home = (process.env.HOME ?? '').trim() !== '' ? (process.env.HOME as string) : os.tmpdir()
  const localDir =
    explicitLocalDir ?? path.join(home, '.cache', 'helios', 'top-level', 'top-level.git')
  return { repoUrl, localDir, refreshMs, deployKey }
}

/** Clone (if needed) and fetch all branches into the bare mirror. */
async function fetchMirror(): Promise<void> {
  if (!config) return
  const { repoUrl, localDir } = config
  status.lastAttemptAtMs = Date.now()

  try {
    if (!isBareRepo(localDir)) {
      // Fresh mirror. Remove any half-baked dir first, then clone.
      fs.mkdirSync(path.dirname(localDir), { recursive: true })
      if (fs.existsSync(localDir)) {
        fs.rmSync(localDir, { recursive: true, force: true })
      }
      log?.info('top-level mirror: cloning', { repoUrl, localDir })
      // --mirror gives us all refs; we only need to read a small text file
      // off the default branch, but blobless keeps the initial clone cheap
      // and fetches the blob on demand at `git show` time.
      await runGit(path.dirname(localDir), [
        'clone',
        '--mirror',
        '--filter=blob:none',
        repoUrl,
        localDir,
      ])
    } else {
      await runGit(localDir, [
        'fetch',
        '--prune',
        '--filter=blob:none',
        'origin',
        '+refs/heads/*:refs/heads/*',
      ])
    }
    status.lastSuccessAtMs = Date.now()
    status.lastError = null
    status.available = true
    status.mode = 'mirror'
  } catch (err) {
    status.lastError = errMessage(err)
    status.available = isBareRepo(localDir)
    log?.error('top-level mirror: fetch failed', { err: status.lastError })
    // Re-throw so the initial bootstrap can log, but keep last-good state.
    throw err
  }
}

/** Force a refresh now (used by routes / manual triggers). Best-effort. */
export async function refreshTopLevelMirror(): Promise<void> {
  if (!config) return
  try {
    await fetchMirror()
  } catch {
    // status already records the error.
  }
}

/**
 * Initialise the top-level mirror. In mirror mode this performs an initial
 * fetch (loud-but-non-fatal) and arms a periodic refresh. In dev mode
 * (no LOCAL_DIR) it just records availability of any local checkout.
 */
export async function initTopLevelMirror(
  opts: { log?: TopLevelMirrorLogger } = {},
): Promise<TopLevelMirrorSourceStatus> {
  log = opts.log ?? null

  if (envBool('HELIOS_TOP_LEVEL_DISABLE')) {
    status.mode = 'none'
    status.available = false
    log?.info('top-level mirror: disabled via HELIOS_TOP_LEVEL_DISABLE')
    return getTopLevelMirrorSourceStatus()
  }

  config = resolveMirrorConfig()
  if (!config) {
    // No mirror configured. Fall back to a local checkout at
    // TOP_LEVEL_REPO_PATH if one exists (dev with a normal clone),
    // otherwise the backlog reader reports the source unavailable.
    const dir = getTopLevelMirrorDir()
    status.mode = dir != null ? 'local-checkout' : 'none'
    status.available = dir != null
    if (dir == null) {
      log?.warn(
        'top-level mirror: no mirror config (no HELIOS_TOP_LEVEL_LOCAL_DIR, no deploy key) and no ' +
          'git repo at TOP_LEVEL_REPO_PATH; the agent-waste backlog will report unavailable',
      )
    }
    return getTopLevelMirrorSourceStatus()
  }
  status.mode = 'mirror'

  try {
    await fetchMirror()
    log?.info('top-level mirror: initial fetch ok', {
      localDir: config.localDir,
      deployKey: config.deployKey ?? '(none)',
    })
  } catch (err) {
    log?.error('top-level mirror: initial fetch failed (will retry)', {
      err: errMessage(err),
    })
  }

  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(() => {
    void refreshTopLevelMirror()
  }, config.refreshMs)
  // Don't keep the event loop alive solely for the refresh timer.
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref()

  return getTopLevelMirrorSourceStatus()
}

/** Test-only: reset module state between tests. */
export function __resetTopLevelMirrorForTests(): void {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
  config = null
  log = null
  status.available = false
  status.mode = 'none'
  status.lastAttemptAtMs = null
  status.lastSuccessAtMs = null
  status.lastError = null
}
