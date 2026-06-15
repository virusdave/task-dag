import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Pill } from '../../components/Pill.js'

// --- shared types (mirror server/taskDagRepo.ts) ---------------------------

export type TaskStatus = 'pending' | 'in-progress' | 'blocked' | 'done'

export interface TaskDagSourceStatus {
  available: boolean
  mode: 'mirror' | 'local-checkout' | 'none'
  lastAttemptAtMs: number | null
  lastSuccessAtMs: number | null
  lastError: string | null
}

export interface TaskNode {
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

const GITHUB_REPO = 'FreshlyBakedNYC/automation'

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
): { data: T | null; error: Error | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    let cancelled = false
    async function run() {
      try {
        const result = await loaderRef.current()
        if (!cancelled) {
          setData(result)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err : new Error('Unknown error'))
      } finally {
        if (!cancelled) setLoading(false)
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

  return { data, error, loading, refresh: () => setTick((t) => t + 1) }
}

// --- formatting / links ----------------------------------------------------

export function statusTone(status: TaskStatus): 'success' | 'warning' | 'danger' | 'muted' {
  if (status === 'done') return 'success'
  if (status === 'in-progress') return 'warning'
  if (status === 'blocked') return 'danger'
  return 'muted'
}

export function statusLabel(t: Pick<TaskNode, 'status' | 'isReady'>): string {
  if (t.status === 'pending' && t.isReady) return 'ready'
  return t.status
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

export function githubIssueUrl(issueNumber: number): string {
  return `https://github.com/${GITHUB_REPO}/issues/${issueNumber}`
}

export function githubCommitUrl(sha: string): string {
  return `https://github.com/${GITHUB_REPO}/commit/${sha}`
}

// --- shared components -----------------------------------------------------

export function SourceBanner({
  source,
  onRefresh,
}: {
  source: TaskDagSourceStatus | undefined
  onRefresh?: () => void
}) {
  if (!source) return null
  const stale = source.lastError != null && source.available
  return (
    <div className={`task-source-banner${stale ? ' task-source-banner--stale' : ''}`}>
      <span>
        {stale
          ? `Showing cached task DAG. Last refresh failed; last good refresh ${formatAge(
              source.lastSuccessAtMs,
            )}.`
          : `Task DAG refreshed ${formatAge(source.lastSuccessAtMs)}`}
      </span>
      {onRefresh && (
        <button type="button" className="task-link-button" onClick={onRefresh}>
          Refresh
        </button>
      )}
    </div>
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
        <strong>{isUnavailable ? 'Task DAG is temporarily unavailable' : 'Could not load task data'}</strong>
      </header>
      <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
        {isUnavailable
          ? 'Helios could not refresh its git mirror of the task DAG. This usually clears within a minute.'
          : (error?.message ?? 'Unknown error')}
      </p>
      <SourceDiagnostics source={source} />
      <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
        Task state lives in git refs; query it directly with{' '}
        <code>scripts/task-dag frontier</code>.
      </p>
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

export function CopyShaButton({ sha }: { sha: string }) {
  return <CopyButton value={sha} label="Copy SHA" />
}

/** The CLI command an operator would run next for a task, or null. */
export function nextCommandFor(task: Pick<TaskNode, 'shortSha' | 'isReady' | 'isActive' | 'isBlocked' | 'status'>): {
  command: string
  label: string
} | null {
  if (task.status === 'done') return null
  if (task.isReady) {
    return { command: `scripts/task-dag claim ${task.shortSha}`, label: 'Copy claim command' }
  }
  if (task.isActive) {
    return { command: `scripts/task-dag release ${task.shortSha}`, label: 'Copy release command' }
  }
  return null
}

export function StatusBadge({ task }: { task: Pick<TaskNode, 'status' | 'isReady'> }) {
  const label = statusLabel(task)
  const tone = label === 'ready' ? 'success' : statusTone(task.status)
  return <Pill tone={tone}>{label}</Pill>
}

/**
 * Compact, reusable task row used on the frontier, epic DAG and detail
 * pages. Links to the task detail page; surfaces the next useful actions
 * (open issue, copy sha) inline.
 */
export function TaskCard({ task, showEpic = false }: { task: TaskNode; showEpic?: boolean }) {
  const nextCmd = nextCommandFor(task)
  return (
    <article className="task-card">
      <div className="task-card-main">
        <Link to={`/tasks/task/${task.sha}`} className="task-card-title">
          {task.title}
        </Link>
        <div className="task-card-badges">
          <StatusBadge task={task} />
          {task.isActive && <Pill tone="warning">claimed</Pill>}
          {task.dependencies.length > 0 && (
            <Pill tone={task.dependenciesMet ? 'success' : 'muted'}>
              {`${task.dependencies.length} dep${task.dependencies.length === 1 ? '' : 's'}${
                task.dependenciesMet ? ' met' : ''
              }`}
            </Pill>
          )}
          {task.breakdownChildren.length > 0 && (
            <Pill tone="muted">{`${task.breakdownChildren.length} subtasks`}</Pill>
          )}
        </div>
      </div>
      <div className="task-card-meta">
        <code className="task-card-sha">{task.shortSha}</code>
        {showEpic && task.epicIssueNumber != null && (
          <Link to={`/tasks/epic/${task.epicIssueNumber}`} className="task-card-epic">
            {`#${task.epicIssueNumber} ${task.epicTitle ?? ''}`.trim()}
          </Link>
        )}
      </div>
      <div className="task-card-actions">
        {nextCmd && (
          <CopyButton value={nextCmd.command} label={nextCmd.label} copiedLabel="Copied command" />
        )}
        <Link to={`/tasks/task/${task.sha}`}>Inspect</Link>
        {task.epicIssueNumber != null && (
          <Link to={`/tasks/epic/${task.epicIssueNumber}`}>DAG</Link>
        )}
        {task.githubUrl ? (
          <a href={task.githubUrl} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        ) : task.issueNumber != null ? (
          <a href={githubIssueUrl(task.issueNumber)} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        ) : null}
        <CopyShaButton sha={task.sha} />
      </div>
    </article>
  )
}
