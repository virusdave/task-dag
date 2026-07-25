import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Pill } from '../../components/Pill.js'

// --- shared types (mirror server/taskDagRepo.ts) ---------------------------

export type TaskStatus = 'pending' | 'in-progress' | 'blocked' | 'done'

export interface TaskDagSourceStatus {
  available: boolean
  coverage: 'complete' | 'partial' | 'unavailable'
  repositories: Array<{
    repository: string
    available: boolean
    mode: 'mirror' | 'local-checkout' | 'none'
    lastError: string | null
  }>
  mode: 'mirror' | 'local-checkout' | 'none'
  lastAttemptAtMs: number | null
  lastSuccessAtMs: number | null
  lastError: string | null
}

export interface TaskNode {
  repository: string
  githubRepository?: string
  sha: string
  shortSha: string
  title: string
  issueNumber?: number
  status: TaskStatus
  type: 'epic' | 'task' | 'leaf'
  author?: string
  parentTask?: string
  dependencies: string[]
  dependents: string[]
  breakdownChildren: string[]
  refs: string[]
  isFrontier: boolean
  isActive: boolean
  isBlocked: boolean
  isReady: boolean
  dependenciesMet: boolean
  completedBy: string[]
  epicSha?: string
  epicIssueNumber?: number
  epicTitle?: string
  githubUrl?: string
}

export interface EpicMeta {
  repository: string
  githubRepository?: string
  sha: string
  shortSha: string
  issueNumber?: number
  title: string
  githubUrl?: string
}

export interface FrontierGroup {
  epic: EpicMeta | null
  counts: { total: number; ready: number; active: number; blocked: number; done: number }
  tasks: TaskNode[]
}

export interface FrontierView {
  source: TaskDagSourceStatus
  summary: {
    totalFrontier: number
    ready: number
    active: number
    blocked: number
    done: number
    epicCount: number
  }
  groups: FrontierGroup[]
}

export interface EpicSummary {
  repository: string
  githubRepository?: string
  issueNumber?: number
  epicRef: string
  sha: string
  shortSha: string
  title: string
  githubUrl?: string
  statusCounts: Record<string, number>
  frontierCount: number
  readyCount: number
  activeCount: number
  blockedCount: number
  completionPct: number
  totalTasks: number
}

export interface EpicsView {
  source: TaskDagSourceStatus
  epics: EpicSummary[]
}

export interface TaskEdge {
  source: string
  target: string
  kind: 'breakdown' | 'dependency'
}

export interface DagResult {
  source: TaskDagSourceStatus
  epic: EpicMeta
  nodes: TaskNode[]
  edges: TaskEdge[]
  summary: { totalTasks: number; statusCounts: Record<string, number> }
}

export interface TaskDetail {
  source: TaskDagSourceStatus
  task: TaskNode
  parent: TaskNode | null
  dependencies: TaskNode[]
  dependents: TaskNode[]
  children: TaskNode[]
}

// --- data fetching ---------------------------------------------------------

export class TaskDataUnavailableError extends Error {
  source?: TaskDagSourceStatus
  constructor(message: string, source?: TaskDagSourceStatus) {
    super(message)
    this.name = 'TaskDataUnavailableError'
    this.source = source
  }
}

/** Extract the task-DAG source status carried on a 503 error, if present. */
export function sourceFromError(error: Error | null): TaskDagSourceStatus | undefined {
  return error instanceof TaskDataUnavailableError ? error.source : undefined
}

export async function fetchTaskJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (res.status === 503) {
    let source: TaskDagSourceStatus | undefined
    try {
      const body = (await res.json()) as { source?: TaskDagSourceStatus; message?: string }
      source = body.source
      throw new TaskDataUnavailableError(
        body.message ?? 'Task data is temporarily unavailable.',
        source,
      )
    } catch (err) {
      if (err instanceof TaskDataUnavailableError) throw err
      throw new TaskDataUnavailableError('Task data is temporarily unavailable.')
    }
  }
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return (await res.json()) as T
}

/**
 * Poll an async loader on an interval. Returns data, error, loading and a
 * manual refresh trigger. Keeps last-good data across refreshes.
 */
export function usePolledData<T>(
  loader: () => Promise<T>,
  deps: unknown[],
  intervalMs = 30_000,
): { data: T | null; error: Error | null; loading: boolean; refreshing: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [tick, setTick] = useState(0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!cancelled) setRefreshing(true)
      try {
        const result = await loaderRef.current()
        if (!cancelled) {
          setData(result)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err : new Error('Unknown error'))
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }
    run()
    const id = setInterval(run, intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, intervalMs])

  return { data, error, loading, refreshing, refresh: () => setTick((t) => t + 1) }
}

// --- formatting / links ----------------------------------------------------

export function statusTone(status: TaskStatus): 'success' | 'warning' | 'danger' | 'muted' {
  if (status === 'done') return 'success'
  if (status === 'in-progress') return 'warning'
  if (status === 'blocked') return 'danger'
  return 'muted'
}

export function statusLabel(t: Pick<TaskNode, 'status' | 'isReady'>): string {
  if (t.status === 'pending' && t.isReady) return 'Ready'
  if (t.status === 'in-progress') return 'In progress'
  if (t.status === 'blocked') return 'Blocked'
  if (t.status === 'done') return 'Done'
  return 'Waiting'
}

export function formatAge(ms: number | null): string {
  if (ms == null) return 'never'
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function githubIssueUrl(issueNumber: number, repository?: string): string | undefined {
  return repository ? `https://github.com/${repository}/issues/${issueNumber}` : undefined
}

export function githubCommitUrl(sha: string, repository?: string): string | undefined {
  return repository ? `https://github.com/${repository}/commit/${sha}` : undefined
}

// --- shared components -----------------------------------------------------

export function TaskLocalNav() {
  const { pathname } = useLocation()
  return (
    <nav className="task-local-nav" aria-label="Task views">
      <Link to="/tasks" aria-current={pathname === '/tasks' ? 'page' : undefined}>Overview</Link>
      <Link to="/tasks/frontier" aria-current={pathname === '/tasks/frontier' ? 'page' : undefined}>Task queue</Link>
    </nav>
  )
}

const TASK_SOURCE_WARNING_STORAGE_KEY = 'helios.taskSourceWarning.dismissed.v1'

function taskSourceSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function taskSourceWarningSignature(source: TaskDagSourceStatus | undefined): string | null {
  if (!source || (source.coverage === 'complete' && source.lastError == null)) return null
  return JSON.stringify(source.repositories
    .filter((repository) => !repository.available || repository.lastError != null)
    .map((repository) => [repository.repository, repository.available, repository.lastError])
    .sort(([left], [right]) => String(left).localeCompare(String(right))))
}

export function SourceBanner({
  source,
  onRefresh,
  refreshing = false,
}: {
  source: TaskDagSourceStatus | undefined
  onRefresh?: () => void
  refreshing?: boolean
}) {
  const signature = taskSourceWarningSignature(source)
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(() => {
    try {
      return taskSourceSessionStorage()?.getItem(TASK_SOURCE_WARNING_STORAGE_KEY) ?? null
    } catch {
      return null
    }
  })
  if (!source || signature == null || dismissedSignature === signature) return null
  const degraded = source.repositories.filter(
    (repository) => !repository.available || repository.lastError != null,
  )
  const omitted = degraded.filter((repository) => !repository.available).length

  function dismissForTab(): void {
    if (signature == null) return
    try {
      taskSourceSessionStorage()?.setItem(TASK_SOURCE_WARNING_STORAGE_KEY, signature)
    } catch {
      // React state still dismisses this mounted warning when storage is unavailable.
    }
    setDismissedSignature(signature)
  }

  return (
    <section className="task-source-banner task-source-banner--stale" role="alert">
      <div className="task-source-banner__header">
        <strong>Task repository coverage warning</strong>
        <button type="button" className="task-source-banner__dismiss" onClick={dismissForTab}>
          Hide for this tab
        </button>
      </div>
      <p>
        {omitted > 0
          ? `${omitted} ${omitted === 1 ? 'repository is' : 'repositories are'} omitted from these results.`
          : `Task data may be stale. Last successful refresh ${formatAge(source.lastSuccessAtMs)}.`}
      </p>
      {degraded.length > 0 && (
        <ul className="task-source-banner__repositories">
          {degraded.map((repository) => (
            <li key={repository.repository}>
              <strong>{repository.repository}</strong>
              <code>{repository.lastError ?? 'No usable task mirror is available; no additional error was reported.'}</code>
            </li>
          ))}
        </ul>
      )}
      <details className="task-source-banner__help">
        <summary>How to fix or report this</summary>
        <p>
          Check <code>HELIOS_TASK_DAG_REPOS_FILE</code> and the Helios GitHub App installation and read permission.
          For local-checkout sources, also check <code>HELIOS_TASK_DAG_LOCAL_PATHS_FILE</code>;
          for mirrors, check <code>HELIOS_TASK_DAG_MIRROR_ROOT</code>. After correcting the source,
          wait for the server refresh cycle, then reload this page. If this is a regression, include
          the repository name and technical detail above in a{' '}
          <a href="https://github.com/FreshlyBakedNYC/automation/issues/new" target="_blank" rel="noreferrer">
            Helios bug report
          </a>.
        </p>
      </details>
      {onRefresh && (
        <button type="button" className="task-link-button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh data'}
        </button>
      )}
    </section>
  )
}

export function DataStatus({
  source,
  onRefresh,
  refreshing = false,
}: {
  source: TaskDagSourceStatus | undefined
  onRefresh: () => void
  refreshing?: boolean
}) {
  if (!source) return null
  return (
    <details className="task-data-status">
      <summary>Data status</summary>
      <p>Updated {formatAge(source.lastSuccessAtMs)} from {source.repositories.length} repositories.</p>
      <button type="button" className="task-link-button" onClick={onRefresh} disabled={refreshing}>
        {refreshing ? 'Refreshing…' : 'Refresh data'}
      </button>
    </details>
  )
}

/** Compact diagnostics line + collapsible raw error for an unavailable source. */
function SourceDiagnostics({ source }: { source: TaskDagSourceStatus | undefined }) {
  if (!source) return null
  return (
    <>
      <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
        Last attempt: {formatAge(source.lastAttemptAtMs)} · Last success:{' '}
        {formatAge(source.lastSuccessAtMs)}
      </p>
      {source.lastError && (
        <details style={{ marginTop: '0.5rem' }}>
          <summary className="subtle-copy">Technical detail</summary>
          <pre className="task-error-detail">{source.lastError}</pre>
        </details>
      )}
    </>
  )
}

export function TaskUnavailable({
  error,
  onRetry,
}: {
  error: Error | null
  onRetry?: () => void
}) {
  const isUnavailable = error instanceof TaskDataUnavailableError
  const source = sourceFromError(error)
  return (
    <article className="mini-card">
      <header>
        <strong>{isUnavailable ? 'Task data is unavailable' : 'Could not load task data'}</strong>
      </header>
      <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
        {isUnavailable
          ? 'Helios cannot read the task repositories right now.'
          : (error?.message ?? 'Unknown error')}
      </p>
      <SourceDiagnostics source={source} />
      {onRetry && (
        <div className="inline-row wrap-row module-card-links" style={{ marginTop: '1rem' }}>
          <button type="button" className="task-link-button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </article>
  )
}

/** Copy-to-clipboard button with transient "Copied" feedback. */
export function CopyButton({
  value,
  label,
  copiedLabel = 'Copied',
}: {
  value: string
  label: string
  copiedLabel?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="task-link-button"
      title={value}
      onClick={() => {
        void navigator.clipboard?.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? copiedLabel : label}
    </button>
  )
}

export function StatusBadge({ task }: { task: Pick<TaskNode, 'status' | 'isReady'> }) {
  const label = statusLabel(task)
  const tone = label === 'Ready' ? 'success' : statusTone(task.status)
  return <Pill tone={tone}>{label}</Pill>
}

/**
 * Compact, reusable task row for queue, plan, and relationship views.
 */
export function TaskCard({ task, showEpic = false }: { task: TaskNode; showEpic?: boolean }) {
  return (
    <article className="task-card">
      <div className="task-card-main">
        <Link to={`/tasks/${task.repository}/task/${task.sha}`} className="task-card-title">
          {task.title}
        </Link>
        <div className="task-card-badges">
          <StatusBadge task={task} />
          {task.dependencies.length > 0 && (
            <Pill tone={task.dependenciesMet ? 'success' : 'muted'}>
              {`${task.dependencies.length} prerequisite${task.dependencies.length === 1 ? '' : 's'}`}
            </Pill>
          )}
          {task.breakdownChildren.length > 0 && (
            <Pill tone="muted">{`${task.breakdownChildren.length} subtasks`}</Pill>
          )}
        </div>
      </div>
      <div className="task-card-meta">
        <span>{task.repository}</span>
        {showEpic && task.epicIssueNumber != null && (
          <Link to={`/tasks/${task.repository}/epic/${task.epicIssueNumber}`} className="task-card-epic">
            {`#${task.epicIssueNumber} ${task.epicTitle ?? ''}`.trim()}
          </Link>
        )}
      </div>
      <div className="task-card-actions">
        {task.epicIssueNumber != null && (
          <Link to={`/tasks/${task.repository}/epic/${task.epicIssueNumber}`}>Task plan</Link>
        )}
        {task.githubUrl ? (
          <a href={task.githubUrl} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        ) : task.issueNumber != null && task.githubRepository ? (
          <a href={githubIssueUrl(task.issueNumber, task.githubRepository)} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        ) : null}
      </div>
    </article>
  )
}
