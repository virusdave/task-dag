/**
 * Read-only task-dag sources for Helios.
 *
 * Multi-repository mode reads the canonical registry at
 * `HELIOS_TASK_DAG_REPOS_FILE`, mirrors each entry below
 * `HELIOS_TASK_DAG_MIRROR_ROOT`, and uses the aliases/keys in
 * `HELIOS_TASK_DAG_SSH_CONFIG`. Local development may map registry names
 * to absolute checkouts with `HELIOS_TASK_DAG_LOCAL_PATHS_FILE` (two
 * whitespace-delimited fields per line). Production requires the registry
 * file so a missing deployment setting cannot silently reduce task pages to
 * automation-only data. Local development retains the legacy REPO_URL,
 * LOCAL_DIR, DEPLOY_KEY, and AUTOMATION_REPO_PATH settings.
 */
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const execFileAsync = promisify(execFile)
const DEFAULT_REPO_URL = 'git@github.com:FreshlyBakedNYC/automation.git'
const DEFAULT_REFRESH_SECONDS = 60
const CONVENTIONAL_DEPLOY_KEY = '/run/agenix/helios-github-automation-deploy-key'

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

interface SourceConfig { repository: string; repoUrl: string; localPath?: string; mirrorDir?: string }
interface RuntimeSource extends SourceConfig { githubRepository?: string; status: TaskDagRepositoryStatus }

let sources: RuntimeSource[] | null = null
let log: TaskDagMirrorLogger | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null
let refreshPromise: Promise<void> | null = null

function envStr(name: string): string | null {
  const value = (process.env[name] ?? '').trim()
  return value === '' ? null : value
}
function envBool(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase())
}
function isRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git')) ||
    (fs.existsSync(path.join(dir, 'HEAD')) && fs.existsSync(path.join(dir, 'objects')))
}
function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/(?:https?:\/\/)[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@').slice(0, 500)
}
function githubRepository(url: string): string | undefined {
  const match = url.match(/(?:github[^/:]*[/:])([^/\s]+\/[^/\s]+?)(?:\.git)?$/i)
  return match?.[1]
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
  if (file) {
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
  if (process.env.NODE_ENV === 'production') {
    throw new Error('HELIOS_TASK_DAG_REPOS_FILE is required in production')
  }
  const localPath = envStr('AUTOMATION_REPO_PATH') ?? undefined
  return [{
    repository: 'automation',
    repoUrl: envStr('HELIOS_TASK_DAG_REPO_URL') ?? DEFAULT_REPO_URL,
    localPath,
    mirrorDir: envStr('HELIOS_TASK_DAG_LOCAL_DIR') ?? undefined,
  }]
}

function buildSources(): RuntimeSource[] {
  const root = envStr('HELIOS_TASK_DAG_MIRROR_ROOT') ?? path.join(process.env.HOME || os.tmpdir(), '.cache', 'helios', 'task-dag')
  return resolveConfigs().map((source) => ({
    ...source,
    mirrorDir: source.mirrorDir ?? path.join(root, `${source.repository}.git`),
    githubRepository: githubRepository(source.repoUrl),
    status: {
      repository: source.repository,
      githubRepository: githubRepository(source.repoUrl),
      available: false,
      mode: 'none',
      lastAttemptAtMs: null,
      lastSuccessAtMs: null,
      lastError: null,
    },
  }))
}

function currentSources(): RuntimeSource[] {
  if (!sources) sources = buildSources()
  return sources
}

export function getTaskDagSources(): TaskDagSource[] {
  return currentSources().map((source) => {
    const local = source.localPath && isRepo(source.localPath) ? source.localPath : null
    const mirror = source.mirrorDir && isRepo(source.mirrorDir) ? source.mirrorDir : null
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

/** Automation compatibility accessor. */
export function getTaskDagGitDir(): string | null {
  return getTaskDagSources().find((source) => source.repository === 'automation')?.gitDir ?? null
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

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  const explicitKey = envStr('HELIOS_TASK_DAG_DEPLOY_KEY')
  const legacyKey = !envStr('HELIOS_TASK_DAG_REPOS_FILE') && fs.existsSync(CONVENTIONAL_DEPLOY_KEY)
    ? CONVENTIONAL_DEPLOY_KEY
    : null
  const key = explicitKey ?? legacyKey
  const sshConfig = envStr('HELIOS_TASK_DAG_SSH_CONFIG')
  if (key || sshConfig) {
    const configArg = sshConfig ? `-F ${sshConfig}` : '-F /dev/null'
    const keyArg = key ? ` -o IdentitiesOnly=yes -i ${key}` : ''
    env.GIT_SSH_COMMAND = `ssh ${configArg} -o BatchMode=yes -o StrictHostKeyChecking=accept-new${keyArg}`
  }
  return env
}

async function fetchSource(source: RuntimeSource): Promise<void> {
  if (source.localPath && isRepo(source.localPath)) return
  const dir = source.mirrorDir as string
  source.status.lastAttemptAtMs = Date.now()
  let verifiedExistingMirror = false
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    if (isRepo(dir)) {
      try {
        const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
          cwd: dir,
          env: gitEnv(),
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
      await execFileAsync('git', ['clone', '--mirror', '--filter=blob:none', source.repoUrl, dir], { cwd: path.dirname(dir), env: gitEnv(), timeout: 120_000 })
    } else {
      await execFileAsync('git', ['fetch', '--prune', '--filter=blob:none', 'origin', '+refs/heads/*:refs/heads/*'], { cwd: dir, env: gitEnv(), timeout: 120_000 })
    }
    source.status.lastSuccessAtMs = Date.now()
    source.status.lastError = null
  } catch (error) {
    if (!verifiedExistingMirror && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    source.status.lastError = safeError(error)
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
  if (envBool('HELIOS_TASK_DAG_DISABLE')) {
    sources = []
    return getTaskDagSourceStatus()
  }
  sources = buildSources()
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
