/**
 * Task-DAG git mirror.
 *
 * The task DAG (epics, frontier tasks, claims, blocks) lives entirely in
 * `refs/heads/tasks/*` on the automation repo's origin, plus completion
 * links recorded as non-first parents of commits on `master`. The
 * production Helios deploy is an artifact tarball with `.git` stripped
 * (see helios-build-artifact / helios-prep), so the running tree has no
 * git metadata and the task refs are simply not present. Reading the DAG
 * out of `AUTOMATION_REPO_PATH` therefore fails on every call and the
 * /tasks pages 500.
 *
 * This module fixes that the same way parser-configs does: it maintains
 * its own lightweight mirror under the helios state dir and refreshes it
 * on a timer. The indexer (taskDagRepo.ts) reads from whatever git dir
 * this module exposes.
 *
 * Loud-but-non-fatal: a fetch failure keeps the last-good mirror in place
 * and is surfaced to the UI as a "stale"/"unavailable" status rather than
 * crashing the server.
 *
 * Config (env):
 *   HELIOS_TASK_DAG_REPO_URL        git URL to mirror (default: automation)
 *   HELIOS_TASK_DAG_LOCAL_DIR       bare mirror dir (enables mirror mode)
 *   HELIOS_TASK_DAG_REFRESH_SECONDS refresh cadence (default 60)
 *   HELIOS_TASK_DAG_DEPLOY_KEY      ssh key with read access to the repo
 *   HELIOS_TASK_DAG_DISABLE         set truthy to disable entirely
 *
 * In local dev (no LOCAL_DIR configured) the module falls back to reading
 * an existing git checkout at AUTOMATION_REPO_PATH if it happens to be a
 * real git repo with task refs, so a developer with a normal checkout
 * needs no extra setup.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const execFileAsync = promisify(execFile)

const DEFAULT_REPO_URL = 'git@github.com:FreshlyBakedNYC/automation.git'
const DEFAULT_REFRESH_SECONDS = 60

/**
 * Conventional agenix path for the automation read deploy key on the
 * Helios prod host (vps-nixos-3). helios-build-artifact already uses this
 * exact key+path to clone automation, and it is owned by / readable only
 * by the `helios` service user. We treat the presence of this file as the
 * signal that we are running in prod and should self-enable mirror mode
 * even when no HELIOS_TASK_DAG_* env vars are wired, so a helios-only
 * deploy (self-deploy-helios) is sufficient to fix /tasks.
 */
const CONVENTIONAL_DEPLOY_KEY = '/run/agenix/helios-github-automation-deploy-key'

export interface TaskDagSourceStatus {
  /** True when a usable git dir with task refs is currently readable. */
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

export interface TaskDagMirrorLogger {
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
let log: TaskDagMirrorLogger | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null

const status: TaskDagSourceStatus = {
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

/** Build the env for git subprocesses, routing through the task-DAG key. */
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
  return stdout.trim()
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
 * Resolve the git dir the indexer should read from, or null if no source
 * is available. In mirror mode this is the bare mirror; in dev it may be
 * a plain checkout.
 */
export function getTaskDagGitDir(): string | null {
  if (config && isBareRepo(config.localDir)) {
    return config.localDir
  }
  // Dev fallback: a real checkout at AUTOMATION_REPO_PATH with task refs.
  const repoPath = envStr('AUTOMATION_REPO_PATH')
  if (repoPath && (isWorkingRepo(repoPath) || isBareRepo(repoPath))) {
    return repoPath
  }
  return null
}

export function getTaskDagSourceStatus(): TaskDagSourceStatus {
  // Recompute availability lazily so dev-mode (no mirror config) still
  // reports correctly without a refresh loop.
  if (!config) {
    const dir = getTaskDagGitDir()
    return {
      ...status,
      available: dir != null,
      mode: dir != null ? 'local-checkout' : 'none',
    }
  }
  return { ...status, available: isBareRepo(config.localDir) }
}

/**
 * Decide whether to run in mirror mode and with what settings, or return
 * null to defer to a local checkout / unavailable. Mirror mode activates
 * when either an explicit local dir is pinned, or we detect the prod
 * deploy key and there is no usable local git checkout to read instead.
 */
function resolveMirrorConfig(): MirrorConfig | null {
  const refreshMs =
    (Number(envStr('HELIOS_TASK_DAG_REFRESH_SECONDS')) || DEFAULT_REFRESH_SECONDS) * 1000
  const repoUrl = envStr('HELIOS_TASK_DAG_REPO_URL') ?? DEFAULT_REPO_URL
  const explicitLocalDir = envStr('HELIOS_TASK_DAG_LOCAL_DIR')
  const deployKey =
    envStr('HELIOS_TASK_DAG_DEPLOY_KEY') ??
    (fs.existsSync(CONVENTIONAL_DEPLOY_KEY) ? CONVENTIONAL_DEPLOY_KEY : null)

  // Prefer reading a real local checkout when one exists and the operator
  // hasn't explicitly pinned a mirror dir (typical dev box).
  const repoPath = envStr('AUTOMATION_REPO_PATH')
  const hasLocalCheckout = repoPath != null && (isWorkingRepo(repoPath) || isBareRepo(repoPath))
  if (!explicitLocalDir && hasLocalCheckout) return null

  // Mirror mode needs somewhere to fetch from: an explicit dir override or
  // a usable deploy key (the prod signal).
  if (!explicitLocalDir && !deployKey) return null

  const home = (process.env.HOME ?? '').trim() !== '' ? (process.env.HOME as string) : os.tmpdir()
  const localDir =
    explicitLocalDir ?? path.join(home, '.cache', 'helios', 'task-dag', 'automation.git')
  return { repoUrl, localDir, refreshMs, deployKey }
}

/** Clone (if needed) and fetch task refs + master into the bare mirror. */
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
      log?.info('task-dag mirror: cloning', { repoUrl, localDir })
      // --mirror gives us all refs (tasks/* + master); blobless keeps it
      // cheap since we only need the commit graph + messages.
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
    log?.error('task-dag mirror: fetch failed', { err: status.lastError })
    // Re-throw so the initial bootstrap can log, but keep last-good state.
    throw err
  }
}

/** Force a refresh now (used by routes / manual triggers). Best-effort. */
export async function refreshTaskDagMirror(): Promise<void> {
  if (!config) return
  try {
    await fetchMirror()
  } catch {
    // status already records the error.
  }
}

/**
 * Initialise the task-DAG source. In mirror mode this performs an initial
 * fetch (loud-but-non-fatal) and arms a periodic refresh. In dev mode
 * (no LOCAL_DIR) it just records availability of any local checkout.
 */
export async function initTaskDagMirror(opts: { log?: TaskDagMirrorLogger } = {}): Promise<TaskDagSourceStatus> {
  log = opts.log ?? null

  if (envBool('HELIOS_TASK_DAG_DISABLE')) {
    status.mode = 'none'
    status.available = false
    log?.info('task-dag mirror: disabled via HELIOS_TASK_DAG_DISABLE')
    return getTaskDagSourceStatus()
  }

  config = resolveMirrorConfig()
  if (!config) {
    // No mirror configured. Fall back to a local checkout at
    // AUTOMATION_REPO_PATH if one exists (dev with a normal clone),
    // otherwise the /tasks pages report task data unavailable.
    const dir = getTaskDagGitDir()
    status.mode = dir != null ? 'local-checkout' : 'none'
    status.available = dir != null
    if (dir == null) {
      log?.warn(
        'task-dag mirror: no mirror config (no HELIOS_TASK_DAG_LOCAL_DIR, no deploy key) and no ' +
          'git repo at AUTOMATION_REPO_PATH; the /tasks pages will report task data unavailable',
      )
    }
    return getTaskDagSourceStatus()
  }
  status.mode = 'mirror'

  try {
    await fetchMirror()
    log?.info('task-dag mirror: initial fetch ok', {
      localDir: config.localDir,
      deployKey: config.deployKey ?? '(none)',
    })
  } catch (err) {
    log?.error('task-dag mirror: initial fetch failed (will retry)', {
      err: errMessage(err),
    })
  }

  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(() => {
    void refreshTaskDagMirror()
  }, config.refreshMs)
  // Don't keep the event loop alive solely for the refresh timer.
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref()

  return getTaskDagSourceStatus()
}
