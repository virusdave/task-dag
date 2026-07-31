/**
 * Read-only task-dag sources for Helios.
 *
 * Multi-repository mode reads the canonical registry at
 * `HELIOS_TASK_DAG_REPOS_FILE`, mirrors each entry below
 * `HELIOS_TASK_DAG_MIRROR_ROOT`. GitHub HTTPS mirrors use the configured
 * GitHub App. Local development may map registry names
 * to absolute checkouts with `HELIOS_TASK_DAG_LOCAL_PATHS_FILE` (two
 * whitespace-delimited fields per line). The registry is always required so
 * no environment can silently reduce task pages to automation-only data.
 */
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  prepareGithubAppGitCredentialDirectory,
  withGithubAppGitCredentials,
} from './githubAppGitCredentials.js'

const execFileAsync = promisify(execFile)
const DEFAULT_REFRESH_SECONDS = 60

export interface TaskDagRepositoryStatus {
  repository: string
  githubRepository?: string
  available: boolean
  mode: 'mirror' | 'local-checkout' | 'none'
  lastAttemptAtMs: number | null
  lastSuccessAtMs: number | null
  lastError: string | null
}

export interface TaskDagSourceStatus {
  available: boolean
  coverage: 'complete' | 'partial' | 'unavailable'
  repositories: TaskDagRepositoryStatus[]
  mode: 'mirror' | 'local-checkout' | 'none'
  lastAttemptAtMs: number | null
  lastSuccessAtMs: number | null
  lastError: string | null
}

export interface TaskDagSource {
  repository: string
  githubRepository?: string
  repoUrl: string
  gitDir: string | null
  status: TaskDagRepositoryStatus
}

export interface TaskDagMirrorLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void
  warn: (msg: string, meta?: Record<string, unknown>) => void
  error: (msg: string, meta?: Record<string, unknown>) => void
}

interface SourceConfig { repository: string; repoUrl: string; localPath?: string }
interface RuntimeSource extends SourceConfig {
  mirrorDir: string
  githubRepository?: string
  status: TaskDagRepositoryStatus
}

let sources: RuntimeSource[] | null = null
let log: TaskDagMirrorLogger | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null
let refreshPromise: Promise<void> | null = null

function envStr(name: string): string | null {
  const value = (process.env[name] ?? '').trim()
  return value === '' ? null : value
}
function isRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git')) ||
    (fs.existsSync(path.join(dir, 'HEAD')) && fs.existsSync(path.join(dir, 'objects')))
}
export function publicTaskDagError(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (/no canonical v2 activation ref/.test(raw)) {
    return 'This repository has not activated task-dag v2.'
  }
  if (/helios_task_dag_bin|unrecognized subcommand|unknown (subcommand|command)|unexpected token.*json|runtime .* is not authorized by activation/.test(raw)) {
    return 'The configured Helios task-dag runtime is missing or incompatible with the activated v2 reader contract.'
  }
  if (/no canonical v2 transition journal|no grammatical task-dag v2 lifecycle refs|lifecycle namespaces|canonical task-dag .*disagrees|expected .*received|activation record has missing or unknown fields|task must have exactly one lifecycle ref|journal activation does not equal advertised activation/.test(raw)) {
    return 'The repository contains malformed or inconsistent activated task-dag v2 state.'
  }
  if (/github app request .* failed with http (401|403)/.test(raw)) {
    return 'GitHub rejected the Helios App credential. Verify the App key, installation, and repository read permission.'
  }
  if (/github app request .* failed with http 404/.test(raw)) {
    return 'The Helios GitHub App is not installed for this repository, or the repository no longer exists.'
  }
  if (/repository not found|not found.*repository|access denied/.test(raw)) {
    return 'The repository was not found or its read credential lacks access.'
  }
  if (/could not resolve|name or service not known|enotfound/.test(raw)) {
    return 'DNS resolution failed for the repository host.'
  }
  if (/timed out|etimedout|timeout/.test(raw)) return 'The repository operation timed out.'
  if (/connection refused|econnrefused/.test(raw)) return 'The repository host refused the connection.'
  if (/no space left|enospc/.test(raw)) return 'The task mirror filesystem is out of space.'
  if (/eacces|operation not permitted|permission denied/.test(raw)) {
    return 'The Helios service cannot read or write the configured task mirror path.'
  }
  if (/not a git repository|bad object|invalid object|corrupt/.test(raw)) {
    return 'The local task mirror is not a readable Git repository or contains corrupt refs.'
  }
  return 'The task repository operation failed. Check the Helios server log for the full error.'
}
function githubRepository(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port ||
      parsed.username || parsed.password || parsed.search || parsed.hash) return undefined
  const match = parsed.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/)
  return match ? `${match[1]}/${match[2]}` : undefined
}
function assertRepository(value: string, line: number): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid repository name on line ${line}`)
  }
}

/** Parse canonical repos.conf, including its optional repair enrollment fields. */
export function parseTaskDagReposConfig(text: string): SourceConfig[] {
  const result: SourceConfig[] = []
  const seen = new Set<string>()
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    if (fields.length !== 2 && fields.length !== 4) {
      throw new Error(`Malformed task repository config on line ${index + 1}: expected 2 or 4 fields`)
    }
    const [repository, repoUrl, repairMode, repairBranch] = fields
    assertRepository(repository, index + 1)
    if (seen.has(repository)) throw new Error(`Duplicate repository '${repository}' on line ${index + 1}`)
    if (!repoUrl || repoUrl.startsWith('-')) throw new Error(`Invalid repository URL on line ${index + 1}`)
    if (repairMode && !['off', 'observe', 'enforce'].includes(repairMode)) {
      throw new Error(`Invalid repair mode on line ${index + 1}`)
    }
    if (repairBranch) {
      try {
        execFileSync('git', ['check-ref-format', '--branch', repairBranch], { stdio: 'ignore' })
      } catch {
        throw new Error(`Invalid repair branch on line ${index + 1}`)
      }
    }
    seen.add(repository)
    result.push({ repository, repoUrl })
  }
  if (result.length === 0) throw new Error('Task repository config is empty')
  return result
}

function resolveConfigs(): SourceConfig[] {
  const file = envStr('HELIOS_TASK_DAG_REPOS_FILE')
  if (!file) throw new Error('HELIOS_TASK_DAG_REPOS_FILE is required')
  const configs = parseTaskDagReposConfig(fs.readFileSync(file, 'utf8'))
  const localPathsFile = envStr('HELIOS_TASK_DAG_LOCAL_PATHS_FILE')
  if (!localPathsFile) return configs
  const paths = new Map<string, string>()
  for (const [index, raw] of fs.readFileSync(localPathsFile, 'utf8').split('\n').entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    if (fields.length !== 2 || !path.isAbsolute(fields[1])) throw new Error(`Malformed local task path on line ${index + 1}`)
    if (paths.has(fields[0])) throw new Error(`Duplicate local task path '${fields[0]}'`)
    paths.set(fields[0], fields[1])
  }
  for (const repository of paths.keys()) {
    if (!configs.some((config) => config.repository === repository)) throw new Error(`Unknown local task repository '${repository}'`)
  }
  return configs.map((config) => ({ ...config, localPath: paths.get(config.repository) }))
}

function buildSources(): RuntimeSource[] {
  const root = envStr('HELIOS_TASK_DAG_MIRROR_ROOT') ?? path.join(process.env.HOME || os.tmpdir(), '.cache', 'helios', 'task-dag')
  return resolveConfigs().map((source) => {
    const github = githubRepository(source.repoUrl)
    if (!source.localPath && !github) {
      throw new Error(`Task repository '${source.repository}' must use an exact https://github.com/<owner>/<repo>.git URL`)
    }
    return {
      ...source,
      mirrorDir: path.join(root, `${source.repository}.git`),
      githubRepository: github,
      status: {
        repository: source.repository,
        githubRepository: github,
        available: false,
        mode: 'none',
        lastAttemptAtMs: null,
        lastSuccessAtMs: null,
        lastError: null,
      },
    }
  })
}

function currentSources(): RuntimeSource[] {
  if (!sources) sources = buildSources()
  return sources
}

export function getTaskDagSources(): TaskDagSource[] {
  return currentSources().map((source) => {
    const local = source.localPath && isRepo(source.localPath) ? source.localPath : null
    const mirror = !source.localPath && source.mirrorDir && isRepo(source.mirrorDir) ? source.mirrorDir : null
    const gitDir = local ?? mirror
    const mode = local ? 'local-checkout' : mirror ? 'mirror' : 'none'
    return {
      repository: source.repository,
      githubRepository: source.githubRepository,
      repoUrl: source.repoUrl,
      gitDir,
      status: { ...source.status, available: gitDir != null, mode },
    }
  })
}

/** Return an explicitly configured working checkout, never a mirror fallback. */
export function getTaskDagLocalPath(repository: string): string {
  const source = currentSources().find((candidate) => candidate.repository === repository)
  if (!source) throw new Error(`Task repository '${repository}' is not configured`)
  if (!source.localPath) {
    throw new Error(
      `Task repository '${repository}' has no working checkout in HELIOS_TASK_DAG_LOCAL_PATHS_FILE`,
    )
  }
  if (!isRepo(source.localPath)) {
    throw new Error(`The configured working checkout for task repository '${repository}' is not readable`)
  }
  return source.localPath
}

export function getTaskDagSourceStatus(): TaskDagSourceStatus {
  const repositories = getTaskDagSources().map((source) => source.status)
  const usable = repositories.filter((source) => source.available)
  const coverage = usable.length === 0 ? 'unavailable' : usable.length === repositories.length ? 'complete' : 'partial'
  const attempts = repositories.map((source) => source.lastAttemptAtMs).filter((value): value is number => value != null)
  const successes = repositories.map((source) => source.lastSuccessAtMs).filter((value): value is number => value != null)
  return {
    available: usable.length > 0,
    coverage,
    repositories,
    mode: usable.length ? usable[0].mode : 'none',
    lastAttemptAtMs: attempts.length ? Math.max(...attempts) : null,
    lastSuccessAtMs: successes.length ? Math.min(...successes) : null,
    lastError: repositories.some((source) => source.lastError) ? 'One or more repositories could not be refreshed' : null,
  }
}

function taskDagGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.GIT_SSH_COMMAND
  return env
}

async function withGitCredentials<T>(source: RuntimeSource, run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  return source.githubRepository
    ? withGithubAppGitCredentials(source.githubRepository, run)
    : run(taskDagGitEnv())
}

async function fetchSource(source: RuntimeSource): Promise<void> {
  if (source.localPath) {
    source.status.lastAttemptAtMs = Date.now()
    if (isRepo(source.localPath)) {
      source.status.lastSuccessAtMs = source.status.lastAttemptAtMs
      source.status.lastError = null
    } else {
      source.status.lastError = 'The configured local task repository is not a readable Git repository.'
      log?.error('configured local task repository is unavailable', { repository: source.repository })
    }
    return
  }
  const dir = source.mirrorDir as string
  source.status.lastAttemptAtMs = Date.now()
  let verifiedExistingMirror = false
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    if (isRepo(dir)) {
      try {
        const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
          cwd: dir,
          env: taskDagGitEnv(),
          timeout: 30_000,
        })
        verifiedExistingMirror = stdout.trim() === source.repoUrl
      } catch {
        verifiedExistingMirror = false
      }
      if (!verifiedExistingMirror) {
        log?.warn('task-dag mirror origin is missing or changed; replacing stale mirror', {
          repository: source.repository,
        })
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    if (!isRepo(dir)) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
      await withGitCredentials(source, (env) =>
        execFileAsync('git', ['clone', '--mirror', '--filter=blob:none', source.repoUrl, dir], { cwd: path.dirname(dir), env, timeout: 120_000 }))
    } else {
      await withGitCredentials(source, (env) =>
        execFileAsync('git', ['fetch', '--prune', '--filter=blob:none', 'origin', '+refs/heads/*:refs/heads/*'], { cwd: dir, env, timeout: 120_000 }))
    }
    source.status.lastSuccessAtMs = Date.now()
    source.status.lastError = null
  } catch (error) {
    if (!verifiedExistingMirror && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    source.status.lastError = publicTaskDagError(error)
    log?.error('task-dag mirror refresh failed', { repository: source.repository, error: source.status.lastError })
  }
}

export async function refreshTaskDagMirror(): Promise<void> {
  if (refreshPromise) return refreshPromise
  refreshPromise = Promise.all(currentSources().map(fetchSource)).then(() => undefined)
  try {
    await refreshPromise
  } finally {
    refreshPromise = null
  }
}

export async function initTaskDagMirror(opts: { log?: TaskDagMirrorLogger } = {}): Promise<TaskDagSourceStatus> {
  log = opts.log ?? null
  sources = buildSources()
  if (sources.some((source) => source.githubRepository && !source.localPath)) {
    prepareGithubAppGitCredentialDirectory()
  }
  await refreshTaskDagMirror()
  if (refreshTimer) clearInterval(refreshTimer)
  const seconds = Number(envStr('HELIOS_TASK_DAG_REFRESH_SECONDS')) || DEFAULT_REFRESH_SECONDS
  refreshTimer = setInterval(() => void refreshTaskDagMirror(), seconds * 1000)
  refreshTimer.unref()
  return getTaskDagSourceStatus()
}

export function __resetTaskDagMirrorForTests(): void {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
  refreshPromise = null
  sources = null
}
