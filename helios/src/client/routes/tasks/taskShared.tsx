import { useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Pill } from '../../components/Pill.js'
import { nyShortDateTime } from '../../app/nyTime.js'

// --- shared types (mirror server/taskDagRepo.ts) ---------------------------

export type TaskStatus = 'pending' | 'in-progress' | 'blocked' | 'done'
export type TaskState = 'frontier' | 'active' | 'blocked' | 'waiting' | 'done'
export interface LifecycleEvidence {
  state: TaskState
  owner?: string
  claimedAt?: number
  expiresAt?: number
  reason?: string
  blockedAt?: number
  publicationCommit?: string
  completionDescription?: string
  waitingChildCount?: number
}

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
  taskId: string
  taskOid: string
  stateOid: string
  state: TaskState
  title: string
  description: string
  structuralParent?: string
  requirements: string[]
  directChildren: string[]
  lifecycleEvidence: LifecycleEvidence
  issueNumber?: number
  status: TaskStatus
  type: 'epic' | 'task' | 'leaf'
  author?: string
  dependents: string[]
  isFrontier: boolean
  isActive: boolean
  isBlocked: boolean
  isReady: boolean
  dependenciesMet: boolean
  rootTaskId: string
  epicIssueNumber?: number
  epicTitle?: string
  githubUrl?: string
}

export interface EpicMeta {
  repository: string
  githubRepository?: string
  taskId: string
  taskOid: string
  stateOid: string
  issueNumber?: number
  title: string
  githubUrl?: string
}

export interface FrontierGroup {
  epic: EpicMeta | null
  counts: { total: number; ready: number; active: number; blocked: number; waiting: number; done: number }
  tasks: TaskNode[]
}

export interface FrontierView {
  source: TaskDagSourceStatus
  summary: {
    totalFrontier: number
    ready: number
    active: number
    blocked: number
    waiting: number
    done: number
    epicCount: number
  }
  groups: FrontierGroup[]
}

export interface EpicSummary {
  repository: string
  githubRepository?: string
  taskId: string
  taskOid: string
  stateOid: string
  issueNumber?: number
  title: string
  githubUrl?: string
  statusCounts: Record<string, number>
  frontierCount: number
  readyCount: number
  activeCount: number
  blockedCount: number
  waitingCount: number
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
  requirements: TaskNode[]
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

export function StaleDataWarning({ error }: { error: Error | null }) {
  if (!error) return null
  return (
    <p role="status" className="task-source-warning">
      Latest refresh failed; showing the last successful task snapshot. {error.message}
    </p>
  )
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
  const key = JSON.stringify(deps)
  const [dataState, setDataState] = useState<{ key: string; value: T } | null>(null)
  const [errorState, setErrorState] = useState<{ key: string; value: Error } | null>(null)
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null)
  const loaderRef = useRef(loader)
  const runRef = useRef<() => void>(() => undefined)
  loaderRef.current = loader

  useEffect(() => {
    let cancelled = false
    let running = false
    let rerun = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function run() {
      if (running) {
        rerun = true
        return
      }
      running = true
      if (timer) clearTimeout(timer)
      if (!cancelled) setRefreshingKey(key)
      try {
        const result = await loaderRef.current()
        if (!cancelled) {
          setDataState({ key, value: result })
          setErrorState(null)
        }
      } catch (err) {
        if (!cancelled) {
          setErrorState({ key, value: err instanceof Error ? err : new Error('Unknown error') })
        }
      } finally {
        running = false
        if (!cancelled) {
          setRefreshingKey(null)
          if (rerun) {
            rerun = false
            void run()
          } else {
            timer = setTimeout(run, intervalMs)
          }
        }
      }
    }
    runRef.current = () => { void run() }
    void run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [key, intervalMs])

  const data = dataState?.key === key ? dataState.value : null
  const error = errorState?.key === key ? errorState.value : null
  return {
    data,
    error,
    loading: data === null && error === null,
    refreshing: refreshingKey === key,
    refresh: () => runRef.current(),
  }
}

// --- formatting / links ----------------------------------------------------

export function statusTone(status: TaskStatus): 'success' | 'warning' | 'danger' | 'muted' {
  if (status === 'done') return 'success'
  if (status === 'in-progress') return 'warning'
  if (status === 'blocked') return 'danger'
  return 'muted'
}

export function statusLabel(t: Pick<TaskNode, 'state' | 'isReady'>): string {
  if (t.state === 'frontier') return t.isReady ? 'Ready' : 'Waiting'
  if (t.state === 'active') return 'In progress'
  if (t.state === 'blocked') return 'Blocked'
  if (t.state === 'done') return 'Done'
  return 'Waiting'
}

function statusLabelTone(label: string): 'success' | 'warning' | 'danger' | 'muted' {
  if (label === 'Ready' || label === 'Done') return 'success'
  if (label === 'In progress') return 'warning'
  if (label === 'Blocked') return 'danger'
  return 'muted'
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

export function StatusBadge({ task }: { task: Pick<TaskNode, 'status' | 'state' | 'isReady'> }) {
  const label = statusLabel(task)
  const tone = statusLabelTone(label)
  return <Pill tone={tone}>{label}</Pill>
}

type TaskCardTray = 'status' | 'requirements' | 'children'

/**
 * Compact, reusable task row for queue, plan, and relationship views.
 */
export function TaskCard({ task, showEpic = false }: { task: TaskNode; showEpic?: boolean }) {
  return <TaskCardBody key={`${task.repository}:${task.taskId}`} task={task} showEpic={showEpic} />
}

function TaskCardBody({ task, showEpic }: { task: TaskNode; showEpic: boolean }) {
  const [tray, setTray] = useState<TaskCardTray | null>(null)
  const [detailState, setDetailState] = useState<{ snapshot: string; detail: TaskDetail } | null>(null)
  const [detailErrorState, setDetailErrorState] = useState<{ snapshot: string; message: string } | null>(null)
  const [detailLoadingSnapshot, setDetailLoadingSnapshot] = useState<string | null>(null)
  const requestIdRef = useRef(0)
  const buttonRefs = useRef<Record<TaskCardTray, HTMLButtonElement | null>>({
    status: null,
    requirements: null,
    children: null,
  })
  const taskVersionRef = useRef({ task, version: 0 })
  if (taskVersionRef.current.task !== task) {
    taskVersionRef.current = { task, version: taskVersionRef.current.version + 1 }
  }
  const trayId = `task-card-tray-${useId().replaceAll(':', '')}`
  const trayHeadingId = `${trayId}-heading`
  const snapshot = `${task.repository}:${task.taskId}:${taskVersionRef.current.version}`
  const detail = detailState?.snapshot === snapshot ? detailState.detail : null
  const detailError = detailErrorState?.snapshot === snapshot ? detailErrorState.message : null
  const detailLoading = detailLoadingSnapshot === snapshot

  async function loadDetail(): Promise<void> {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const requestedSnapshot = snapshot
    setDetailLoadingSnapshot(requestedSnapshot)
    setDetailErrorState(null)
    try {
      const result = await fetchTaskJson<TaskDetail>(
        `/api/tasks/repositories/${encodeURIComponent(task.repository)}/tasks/${encodeURIComponent(task.taskId)}`,
      )
      if (requestIdRef.current === requestId) {
        setDetailState({ snapshot: requestedSnapshot, detail: result })
      }
    } catch (error) {
      if (requestIdRef.current === requestId) {
        setDetailErrorState({
          snapshot: requestedSnapshot,
          message: error instanceof Error ? error.message : 'Task details are temporarily unavailable.',
        })
      }
    } finally {
      if (requestIdRef.current === requestId) setDetailLoadingSnapshot(null)
    }
  }

  useEffect(() => {
    if (tray && tray !== 'status' && !detail && !detailLoading && !detailError) void loadDetail()
    // loadDetail deliberately captures the exact current task snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tray, snapshot, detail, detailLoading, detailError])

  function toggleTray(next: TaskCardTray): void {
    if (tray === next) {
      setTray(null)
      return
    }
    setTray(next)
  }

  function closeTray(restoreFocus: boolean): void {
    const previous = tray
    setTray(null)
    if (restoreFocus && previous) buttonRefs.current[previous]?.focus()
  }

  const status = statusLabel(task)
  const tone = statusLabelTone(status)
  return (
    <article
      className="task-card"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && tray) {
          event.preventDefault()
          event.stopPropagation()
          closeTray(true)
        }
      }}
    >
      <div className="task-card-main">
        <Link to={`/tasks/${task.repository}/task/${task.taskId}`} className="task-card-title">
          {task.title}
        </Link>
        <div className="task-card-badges">
          <button
            ref={(node) => { buttonRefs.current.status = node }}
            type="button"
            className={`task-disclosure-button pill pill-${tone}`}
            aria-expanded={tray === 'status'}
            aria-controls={trayId}
            onClick={() => toggleTray('status')}
          >
            {status}
          </button>
          {task.requirements.length > 0 && (
            <button
              ref={(node) => { buttonRefs.current.requirements = node }}
              type="button"
              className={`task-disclosure-button pill pill-${task.dependenciesMet ? 'success' : 'muted'}`}
              aria-expanded={tray === 'requirements'}
              aria-controls={trayId}
              onClick={() => toggleTray('requirements')}
            >
              {`${task.requirements.length} prerequisite${task.requirements.length === 1 ? '' : 's'}`}
            </button>
          )}
          {task.directChildren.length > 0 && (
            <button
              ref={(node) => { buttonRefs.current.children = node }}
              type="button"
              className="task-disclosure-button pill pill-muted"
              aria-expanded={tray === 'children'}
              aria-controls={trayId}
              onClick={() => toggleTray('children')}
            >
              {`${task.directChildren.length} subtask${task.directChildren.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
      {tray && (
        <TaskCardDisclosure
          id={trayId}
          headingId={trayHeadingId}
          task={task}
          tray={tray}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          onRetry={() => { void loadDetail() }}
          onClose={() => closeTray(true)}
        />
      )}
      <div className="task-card-meta">
        <span>{task.repository}</span>
        {showEpic && (
          <Link to={`/tasks/${task.repository}/epic/${task.rootTaskId}`} className="task-card-epic">
            {task.epicIssueNumber != null ? `#${task.epicIssueNumber} ${task.epicTitle ?? ''}`.trim() : (task.epicTitle ?? 'Task plan')}
          </Link>
        )}
      </div>
      <div className="task-card-actions">
        <Link to={`/tasks/${task.repository}/epic/${task.rootTaskId}`}>Task plan</Link>
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

function TaskCardDisclosure({
  id,
  headingId,
  task,
  tray,
  detail,
  loading,
  error,
  onRetry,
  onClose,
}: {
  id: string
  headingId: string
  task: TaskNode
  tray: TaskCardTray
  detail: TaskDetail | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onClose: () => void
}) {
  const title = tray === 'status' ? 'Current status' : tray === 'requirements' ? 'Prerequisites' : 'Subtasks'
  return (
    <section
      id={id}
      className="task-card-disclosure"
      aria-labelledby={headingId}
      aria-busy={tray !== 'status' && loading}
    >
      <div className="task-card-disclosure__header">
        <h4 id={headingId}>{title}</h4>
        <button type="button" className="task-link-button" onClick={onClose}>Close</button>
      </div>
      <div aria-live="polite">
        {tray === 'status' ? (
          <TaskStatusEvidence task={task} />
        ) : loading ? (
          <p role="status" className="subtle-copy">Loading {title.toLowerCase()}…</p>
        ) : error ? (
          <div role="alert">
            <p>{error.includes('404') ? 'This task is no longer available in the current snapshot.' : `Could not load ${title.toLowerCase()}: ${error}`}</p>
            <button type="button" className="task-link-button" onClick={onRetry}>Retry</button>
          </div>
        ) : detail ? (
          <TaskRelationshipList
            related={tray === 'requirements' ? detail.requirements : detail.children}
            expectedIds={tray === 'requirements' ? detail.task.requirements : detail.task.directChildren}
            emptyLabel={tray === 'requirements' ? 'No prerequisites.' : 'No subtasks.'}
            onRetry={onRetry}
          />
        ) : null}
      </div>
    </section>
  )
}

function TaskStatusEvidence({ task }: { task: TaskNode }) {
  const label = statusLabel(task)
  let explanation = 'This task is waiting. One or more current readiness conditions are not met.'
  if (label === 'Ready') explanation = 'This task is pickable now; all known prerequisites are satisfied.'
  if (label === 'In progress') explanation = task.lifecycleEvidence.owner
    ? `Claimed by ${task.lifecycleEvidence.owner}.`
    : 'A current claim marks this task as in progress.'
  if (label === 'Blocked') explanation = task.lifecycleEvidence.reason
    ? task.lifecycleEvidence.reason
    : 'A current block prevents this task from being picked up.'
  if (task.state === 'waiting' && task.lifecycleEvidence.waitingChildCount != null) {
    explanation = `Waiting for ${task.lifecycleEvidence.waitingChildCount} direct child task${task.lifecycleEvidence.waitingChildCount === 1 ? '' : 's'} to finish.`
  }
  if (label === 'Done') explanation = 'Durable completion evidence exists for this task.'
  const publicationCommit = task.lifecycleEvidence.publicationCommit
  return (
    <div>
      <p>{explanation}</p>
      {task.state === 'active' && (task.lifecycleEvidence.claimedAt != null || task.lifecycleEvidence.expiresAt != null) && (
        <ul className="task-card-disclosure__list">
          {task.lifecycleEvidence.claimedAt != null && <li>Claimed {nyShortDateTime(task.lifecycleEvidence.claimedAt * 1000)} NY</li>}
          {task.lifecycleEvidence.expiresAt != null && <li>Claim expires {nyShortDateTime(task.lifecycleEvidence.expiresAt * 1000)} NY</li>}
        </ul>
      )}
      {task.state === 'done' && task.lifecycleEvidence.completionDescription && (
        <p>{task.lifecycleEvidence.completionDescription}</p>
      )}
      {task.state === 'done' && publicationCommit && (
        <ul className="task-card-disclosure__list">
          <li>
            <a href={githubCommitUrl(publicationCommit, task.githubRepository)} target="_blank" rel="noopener noreferrer">
              Publication <code>{publicationCommit.slice(0, 10)}</code>
            </a>
          </li>
        </ul>
      )}
      <p className="subtle-copy">Coverage: current-evidence. This is not complete history.</p>
    </div>
  )
}

function TaskRelationshipList({
  related,
  expectedIds,
  emptyLabel,
  onRetry,
}: {
  related: TaskNode[]
  expectedIds: string[]
  emptyLabel: string
  onRetry: () => void
}) {
  const resolved = new Map(related.map((item) => [item.taskId, item]))
  const ordered = [...related].sort(compareTaskAttention)
  const unavailable = expectedIds.filter((sha) => !resolved.has(sha)).sort()
  if (ordered.length === 0 && unavailable.length === 0) return <p className="subtle-copy">{emptyLabel}</p>
  return (
    <ul className="task-card-disclosure__list">
      {ordered.map((item) => (
        <li key={`${item.repository}:${item.taskId}`}>
          <Link to={`/tasks/${item.repository}/task/${item.taskId}`}>{item.title}</Link>
          <span className="subtle-copy">{statusLabel(item)}</span>
        </li>
      ))}
      {unavailable.map((sha) => (
        <li key={sha}>
          <span>Unavailable relationship</span>
          <code>{sha}</code>
        </li>
      ))}
      {unavailable.length > 0 && (
        <li>
          <button type="button" className="task-link-button" onClick={onRetry}>Retry unavailable relationships</button>
        </li>
      )}
    </ul>
  )
}

function compareTaskAttention(left: TaskNode, right: TaskNode): number {
  const order = new Map([
    ['Blocked', 0],
    ['In progress', 1],
    ['Ready', 2],
    ['Waiting', 3],
    ['Done', 4],
  ])
  return (order.get(statusLabel(left)) ?? 5) - (order.get(statusLabel(right)) ?? 5)
    || left.title.localeCompare(right.title)
    || `${left.repository}:${left.taskId}`.localeCompare(`${right.repository}:${right.taskId}`)
}
