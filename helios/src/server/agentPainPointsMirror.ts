/**
 * Read-only git mirror of `virusdave/agent-pain-points` (issue #64, the
 * automation/Helios child of the agent-pain-points migration — parent
 * virusdave/top-level#40).
 *
 * The agent-waste pending-review backlog is exported by github-worker into
 * a small git file co-located with `docs/agent-runtime/advisories.yaml` in
 * `virusdave/agent-pain-points` — the dedicated advisories repo the
 * migration moved this storage into (it reverses Lever-D decision D1's
 * "storage in top-level"; see docs/helios/agent-waste-review/RESOLVED_DESIGN.md).
 * Helios reads it read-only. The production Helios deploy is an artifact
 * tarball with `.git` stripped, so — exactly like the task-DAG mirror — we
 * maintain our OWN lightweight bare mirror of agent-pain-points under the
 * helios state dir and refresh it on a timer. The backlog reader
 * (agentWasteBacklogReader.ts) reads the exported file out of whatever git
 * dir this module exposes.
 *
 * This is an independent read mirror alongside taskDagMirror.ts (which
 * mirrors `automation`); it uses the same proven pattern but its own
 * config, its own bare dir, and its own read-only deploy key. It replaces
 * the earlier top-level mirror that fed this backlog before the migration.
 *
 * IMPORTANT: this dir is a BARE MIRROR (read). The promote WRITE path uses
 * a SEPARATE working-tree clone dir + its own write key
 * (HELIOS_AGENT_PAIN_POINTS_WRITE_DIR in agentWaste/promoteAdvisory.ts).
 * Do not point both at the same dir (design §5 hazard: a bare mirror has no
 * worktree, a working-tree clone needs `.git`).
 *
 * Loud-but-non-fatal (taskDagMirror semantics): a fetch failure keeps the
 * last-good mirror in place and is surfaced as a "stale"/"unavailable"
 * status rather than crashing the server. The consumer degrades to a
 * structured 503, never a raw 500.
 *
 * Config (env):
 *   HELIOS_AGENT_PAIN_POINTS_REPO_URL        git URL to mirror (default: agent-pain-points)
 *   HELIOS_AGENT_PAIN_POINTS_MIRROR_DIR      bare mirror dir (pins mirror mode)
 *   HELIOS_AGENT_PAIN_POINTS_REFRESH_SECONDS refresh cadence (default 60)
 *   HELIOS_AGENT_PAIN_POINTS_DEPLOY_KEY      ssh key with read access to agent-pain-points
 *   HELIOS_AGENT_PAIN_POINTS_DISABLE         set truthy to disable entirely
 *
 * In local dev (no MIRROR_DIR configured) the module falls back to reading
 * an existing agent-pain-points checkout at AGENT_PAIN_POINTS_REPO_PATH if
 * it happens to be a real git repo, so a developer with a normal checkout
 * needs no extra setup.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const execFileAsync = promisify(execFile)

const DEFAULT_REPO_URL = 'git@github.com:virusdave/agent-pain-points.git'
const DEFAULT_REFRESH_SECONDS = 60

/**
 * The default branch agent-pain-points backlog/advisory files live on.
 * Canon's default branch is `master` fleet-wide, and the exporter + Helios
 * default/hardcode `master` (design §5 "master is a hidden contract").
 */
export const AGENT_PAIN_POINTS_DEFAULT_REF = 'master'

/**
 * Conventional agenix path for the agent-pain-points READ-ONLY deploy key
 * on the Helios prod host (vps-nixos-3), provisioned for the `helios`
 * service user by the nixos-sbc child epic. Same shape as the automation
 * read key at `/run/agenix/helios-github-automation-deploy-key` that
 * taskDagMirror.ts reads. We treat the presence of this file as the signal
 * that we are running in prod and should self-enable mirror mode even when
 * no HELIOS_AGENT_PAIN_POINTS_* env vars are wired, so a helios-only deploy
 * is sufficient once the key is present.
 */
const CONVENTIONAL_DEPLOY_KEY = '/run/agenix/helios-github-agent-pain-points-deploy-key'

export interface AgentPainPointsMirrorSourceStatus {
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

export interface AgentPainPointsMirrorLogger {
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
let log: AgentPainPointsMirrorLogger | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null

const status: AgentPainPointsMirrorSourceStatus = {
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
export function getAgentPainPointsMirrorDir(): string | null {
  if (config && isBareRepo(config.localDir)) {
    return config.localDir
  }
  // Dev fallback: a real checkout at AGENT_PAIN_POINTS_REPO_PATH.
  const repoPath = envStr('AGENT_PAIN_POINTS_REPO_PATH')
  if (repoPath && (isWorkingRepo(repoPath) || isBareRepo(repoPath))) {
    return repoPath
  }
  return null
}

export function getAgentPainPointsMirrorSourceStatus(): AgentPainPointsMirrorSourceStatus {
  // Recompute availability lazily so dev-mode (no mirror config) still
  // reports correctly without a refresh loop.
  if (!config) {
    const dir = getAgentPainPointsMirrorDir()
    return {
      ...status,
      available: dir != null,
      mode: dir != null ? 'local-checkout' : 'none',
    }
  }
  return { ...status, available: isBareRepo(config.localDir) }
}

/**
 * Read a file at `relPath` from the mirrored agent-pain-points default
 * branch. Returns the file contents, or null when the file does not exist
 * on that ref. Throws when no mirror dir is available or git otherwise
 * fails, so the caller can distinguish "source unreadable" (surface as
 * unavailable) from "file absent" (fail-safe empty).
 *
 * Works against both a bare mirror (no worktree) and a dev checkout by
 * addressing the blob through `git show <ref>:<relPath>`.
 */
export async function readAgentPainPointsFile(relPath: string): Promise<string | null> {
  const dir = getAgentPainPointsMirrorDir()
  if (dir == null) {
    throw new Error('agent-pain-points mirror is not available')
  }
  // Normalise to forward slashes; git object paths are always POSIX.
  const objPath = relPath.replace(/^\.?\/+/, '').split(path.sep).join('/')
  try {
    return await runGit(dir, ['show', `${AGENT_PAIN_POINTS_DEFAULT_REF}:${objPath}`], 30_000)
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
    (Number(envStr('HELIOS_AGENT_PAIN_POINTS_REFRESH_SECONDS')) || DEFAULT_REFRESH_SECONDS) * 1000
  const repoUrl = envStr('HELIOS_AGENT_PAIN_POINTS_REPO_URL') ?? DEFAULT_REPO_URL
  const explicitLocalDir = envStr('HELIOS_AGENT_PAIN_POINTS_MIRROR_DIR')
  const deployKey =
    envStr('HELIOS_AGENT_PAIN_POINTS_DEPLOY_KEY') ??
    (fs.existsSync(CONVENTIONAL_DEPLOY_KEY) ? CONVENTIONAL_DEPLOY_KEY : null)

  // Prefer reading a real local checkout when one exists and the operator
  // hasn't explicitly pinned a mirror dir (typical dev box).
  const repoPath = envStr('AGENT_PAIN_POINTS_REPO_PATH')
  const hasLocalCheckout = repoPath != null && (isWorkingRepo(repoPath) || isBareRepo(repoPath))
  if (!explicitLocalDir && hasLocalCheckout) return null

  // Mirror mode needs somewhere to fetch from: an explicit dir override or
  // a usable deploy key (the prod signal).
  if (!explicitLocalDir && !deployKey) return null

  const home = (process.env.HOME ?? '').trim() !== '' ? (process.env.HOME as string) : os.tmpdir()
  const localDir =
    explicitLocalDir ??
    path.join(home, '.cache', 'helios', 'agent-pain-points', 'agent-pain-points.git')

  // Design §5 hazard: the read mirror is a BARE mirror (fetchMirror rm's and
  // re-clones its dir), while the promote path uses a WORKING-TREE clone. If
  // an operator points both at the same directory, arming the mirror would
  // DELETE the promote write clone. Refuse to run mirror mode in that case
  // (fail closed → the backlog reports unavailable, and the write clone is
  // never touched) rather than nuking a working tree.
  const writeDir = envStr('HELIOS_AGENT_PAIN_POINTS_WRITE_DIR')
  if (writeDir && path.resolve(writeDir) === path.resolve(localDir)) {
    log?.error(
      'agent-pain-points mirror: MIRROR_DIR equals WRITE_DIR; refusing to run the read mirror ' +
        '(it would delete the promote write clone). Point them at distinct directories.',
      { mirrorDir: localDir, writeDir },
    )
    return null
  }

  return { repoUrl, localDir, refreshMs, deployKey }
}

/** Clone (if needed) and fetch all branches into the bare mirror. */
async function fetchMirror(): Promise<void> {
  if (!config) return
  const { repoUrl, localDir } = config
  status.lastAttemptAtMs = Date.now()

  try {
    if (!isBareRepo(localDir)) {
      // Never destroy a WORKING-TREE checkout (has `.git`): that is the shape
      // of the promote write clone, and blowing it away would be a data-loss
      // footgun (design §5). The equal-dir case is already refused in
      // resolveMirrorConfig; this is defense-in-depth for any other path that
      // happens to be a working tree.
      if (isWorkingRepo(localDir)) {
        throw new Error(
          `agent-pain-points mirror dir ${localDir} is a working-tree checkout, not a bare ` +
            `mirror; refusing to delete it. Point HELIOS_AGENT_PAIN_POINTS_MIRROR_DIR at a ` +
            `dedicated bare-mirror directory.`,
        )
      }
      // Fresh mirror. Remove any half-baked dir first, then clone.
      fs.mkdirSync(path.dirname(localDir), { recursive: true })
      if (fs.existsSync(localDir)) {
        fs.rmSync(localDir, { recursive: true, force: true })
      }
      log?.info('agent-pain-points mirror: cloning', { repoUrl, localDir })
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
    log?.error('agent-pain-points mirror: fetch failed', { err: status.lastError })
    // Re-throw so the initial bootstrap can log, but keep last-good state.
    throw err
  }
}

/** Force a refresh now (used by routes / manual triggers). Best-effort. */
export async function refreshAgentPainPointsMirror(): Promise<void> {
  if (!config) return
  try {
    await fetchMirror()
  } catch {
    // status already records the error.
  }
}

/**
 * Initialise the agent-pain-points mirror. In mirror mode this performs an
 * initial fetch (loud-but-non-fatal) and arms a periodic refresh. In dev
 * mode (no MIRROR_DIR) it just records availability of any local checkout.
 */
export async function initAgentPainPointsMirror(
  opts: { log?: AgentPainPointsMirrorLogger } = {},
): Promise<AgentPainPointsMirrorSourceStatus> {
  log = opts.log ?? null

  if (envBool('HELIOS_AGENT_PAIN_POINTS_DISABLE')) {
    status.mode = 'none'
    status.available = false
    log?.info('agent-pain-points mirror: disabled via HELIOS_AGENT_PAIN_POINTS_DISABLE')
    return getAgentPainPointsMirrorSourceStatus()
  }

  config = resolveMirrorConfig()
  if (!config) {
    // No mirror configured. Fall back to a local checkout at
    // AGENT_PAIN_POINTS_REPO_PATH if one exists (dev with a normal clone),
    // otherwise the backlog reader reports the source unavailable.
    const dir = getAgentPainPointsMirrorDir()
    status.mode = dir != null ? 'local-checkout' : 'none'
    status.available = dir != null
    if (dir == null) {
      log?.warn(
        'agent-pain-points mirror: no mirror config (no HELIOS_AGENT_PAIN_POINTS_MIRROR_DIR, no ' +
          'deploy key) and no git repo at AGENT_PAIN_POINTS_REPO_PATH; the agent-waste backlog ' +
          'will report unavailable',
      )
    }
    return getAgentPainPointsMirrorSourceStatus()
  }
  status.mode = 'mirror'

  try {
    await fetchMirror()
    log?.info('agent-pain-points mirror: initial fetch ok', {
      localDir: config.localDir,
      deployKey: config.deployKey ?? '(none)',
    })
  } catch (err) {
    log?.error('agent-pain-points mirror: initial fetch failed (will retry)', {
      err: errMessage(err),
    })
  }

  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(() => {
    void refreshAgentPainPointsMirror()
  }, config.refreshMs)
  // Don't keep the event loop alive solely for the refresh timer.
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref()

  return getAgentPainPointsMirrorSourceStatus()
}

/** Test-only: reset module state between tests. */
export function __resetAgentPainPointsMirrorForTests(): void {
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
