import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import dagre from 'dagre'
import {
  fetchTaskJson,
  usePolledData,
  SourceBanner,
  DataStatus,
  sourceFromError,
  TaskUnavailable,
  TaskCard,
  statusLabel,
  githubIssueUrl,
  type DagResult,
  type TaskNode,
} from './taskShared.js'

interface LayoutNode {
  x: number
  y: number
  width: number
  height: number
  node: TaskNode
}

const STATUS_COLOR: Record<string, string> = {
  ready: '#16a34a',
  done: '#22c55e',
  'in-progress': '#f59e0b',
  blocked: '#ef4444',
  waiting: '#6b7280',
}
const STATUS_FILL: Record<string, string> = {
  ready: '#bbf7d0',
  done: '#dcfce7',
  'in-progress': '#fef3c7',
  blocked: '#fee2e2',
  waiting: '#f3f4f6',
}

export type TaskPlanStatus = 'all' | 'ready' | 'in-progress' | 'blocked' | 'waiting' | 'done'
const TASK_PLAN_STATUSES = new Set<TaskPlanStatus>(['all', 'ready', 'in-progress', 'blocked', 'waiting', 'done'])

export function EpicDagPage() {
  const { taskId = '', repository = '' } = useParams<{ taskId: string; repository: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const [view, setView] = useState<'list' | 'graph'>('list')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const rawStatus = searchParams.get('status')
  const status = parseTaskPlanStatus(rawStatus)

  useEffect(() => {
    const normalized = canonicalTaskPlanSearch(searchParams)
    if (normalized == null) return
    setSearchParams(normalized, { replace: true })
  }, [rawStatus, searchParams, setSearchParams])

  const { data, error, loading, refreshing, refresh } = usePolledData<DagResult>(
    () => fetchTaskJson<DagResult>(`/api/tasks/repositories/${repository}/epics/${taskId}/dag`),
    [taskId, repository],
    30_000,
  )

  if (loading && !data) {
    return (
      <section data-helios-capture-target="task-plan" data-helios-capture-ready="false">
        <div className="page-header">
          <h2>Task plan</h2>
        </div>
        <p>Loading...</p>
      </section>
    )
  }

  if ((error && !data) || !data) {
    return (
      <section data-helios-capture-target="task-plan" data-helios-capture-ready="true">
        <div className="page-header">
          <h2>Task plan</h2>
        </div>
        <SourceBanner source={sourceFromError(error)} onRefresh={refresh} refreshing={refreshing} />
        <TaskUnavailable error={error} onRetry={refresh} />
        <p className="subtle-copy" style={{ marginTop: '1rem' }}>
          <Link to="/tasks">Back to task management</Link>
        </p>
      </section>
    )
  }

  const taskData = withoutEpicNodes(data)
  const selected = selectedKey == null
    ? null
    : taskData.nodes.find((node) => taskNodeKey(node) === selectedKey) ?? null

  function selectStatus(next: TaskPlanStatus): void {
    if (next === status) return
    const updated = new URLSearchParams(searchParams)
    if (next === 'all') updated.delete('status')
    else updated.set('status', next)
    setSearchParams(updated)
  }

  return (
    <section className="task-page" data-helios-capture-target="task-plan" data-helios-capture-ready="true">
      <div className="page-header">
        <div>
          <p className="subtle-copy">{data.epic.repository}</p>
          <h2>Task plan</h2>
          <p>{data.epic.title}</p>
          {data.epic.issueNumber != null && (
            <p className="subtle-copy">
              <a
                href={data.epic.githubUrl ?? githubIssueUrl(data.epic.issueNumber, data.epic.githubRepository)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Issue #{data.epic.issueNumber}
              </a>{' '}
              · {taskData.summary.totalTasks} tasks
            </p>
          )}
        </div>
      </div>

      <SourceBanner source={sourceFromError(error) ?? data.source} onRefresh={refresh} refreshing={refreshing} />

      <div className="task-summary-row" role="group" aria-label="Filter tasks by status">
        {([
          ['all', 'All', taskData.summary.totalTasks],
          ['ready', 'Ready'],
          ['in-progress', 'In progress'],
          ['blocked', 'Blocked'],
          ['waiting', 'Waiting'],
          ['done', 'Done'],
        ] as const).map(([itemStatus, label, explicitCount]) => (
          <button
            type="button"
            key={itemStatus}
            className={`task-summary-stat${status === itemStatus ? ' task-summary-stat--active' : ''}`}
            aria-pressed={status === itemStatus}
            onClick={() => selectStatus(itemStatus)}
          >
            <span className="task-summary-value">{explicitCount ?? taskData.summary.statusCounts[itemStatus] ?? 0}</span>
            <span className="task-summary-label">{label}</span>
          </button>
        ))}
      </div>

      <div className="task-control-actions" style={{ marginBottom: '1rem' }} role="group" aria-label="Task plan view">
        <button
          type="button"
          className={`task-chip${view === 'list' ? ' task-chip--active' : ''}`}
          onClick={() => setView('list')}
          aria-pressed={view === 'list'}
        >
          List
        </button>
        <button
          type="button"
          className={`task-chip${view === 'graph' ? ' task-chip--active' : ''}`}
          onClick={() => setView('graph')}
          aria-pressed={view === 'graph'}
        >
          Dependency graph
        </button>
        <Link
          to={`/tasks/frontier?repository=${data.epic.repository}&rootTaskId=${data.epic.taskId}&status=ready`}
          className="task-link-button"
        >
          View ready tasks
        </Link>
        {data.epic.issueNumber != null && (
          <a
            href={data.epic.githubUrl ?? githubIssueUrl(data.epic.issueNumber, data.epic.githubRepository)}
            target="_blank"
            rel="noopener noreferrer"
            className="task-link-button"
          >
            GitHub issue
          </a>
        )}
        <Link to="/tasks" className="task-link-button">
          Task overview
        </Link>
      </div>

      {view === 'list' ? (
        <DagListView data={taskData} status={status} />
      ) : (
        <DagGraphView
          data={taskData}
          status={status}
          selected={selected}
          selectedMissing={selectedKey != null && selected == null}
          onSelect={(node) => setSelectedKey(node ? taskNodeKey(node) : null)}
        />
      )}
      <DataStatus source={sourceFromError(error) ?? data.source} onRefresh={refresh} refreshing={refreshing} />

    </section>
  )
}

function DagListView({ data, status }: { data: DagResult; status: TaskPlanStatus }) {
  // Order by breakdown depth so parents precede children.
  const bySha = useMemo(() => new Map(data.nodes.map((n) => [n.taskId, n])), [data.nodes])
  const ordered = useMemo(() => {
    const roots = data.nodes.filter((n) => !n.structuralParent || !bySha.has(n.structuralParent))
    const out: { node: TaskNode; depth: number }[] = []
    const seen = new Set<string>()
    const visit = (n: TaskNode, depth: number) => {
      if (seen.has(n.taskId)) return
      seen.add(n.taskId)
      out.push({ node: n, depth })
      for (const childSha of n.directChildren) {
        const child = bySha.get(childSha)
        if (child) visit(child, depth + 1)
      }
    }
    roots.forEach((r) => visit(r, 0))
    // Any nodes not reached (cycles / detached) appended at depth 0.
    data.nodes.forEach((n) => {
      if (!seen.has(n.taskId)) visit(n, 0)
    })
    return out
  }, [data.nodes, bySha])

  return (
    <div className="task-group-body">
      {ordered.filter(({ node }) => taskMatchesPlanStatus(node, status)).map(({ node, depth }) => (
        <div
          key={`${node.repository}:${node.taskId}`}
          style={{ marginLeft: `${Math.min(depth, 4) * 1.25}rem` }}
        >
          <TaskCard task={node} />
        </div>
      ))}
      {ordered.every(({ node }) => !taskMatchesPlanStatus(node, status)) && (
        <p className="subtle-copy">No {status === 'all' ? '' : `${status} `}tasks in this plan.</p>
      )}
    </div>
  )
}

function DagGraphView({
  data,
  status,
  selected,
  selectedMissing,
  onSelect,
}: {
  data: DagResult
  status: TaskPlanStatus
  selected: TaskNode | null
  selectedMissing: boolean
  onSelect: (n: TaskNode | null) => void
}) {
  const layout = useMemo(() => layoutDag(data), [data])
  const selectedPanelRef = useRef<HTMLDivElement>(null)
  const selectedIdentity = selected ? taskNodeKey(selected) : null
  useEffect(() => {
    if (selected) selectedPanelRef.current?.scrollIntoView({ block: 'nearest' })
    // Reposition only for an operator selection change, not every polling clone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdentity])
  if (layout.nodes.length === 0) {
    return (
      <article className="mini-card">
        <p className="subtle-copy">No nodes to graph.</p>
      </article>
    )
  }

  const minX = Math.min(...layout.nodes.map((n) => n.x - n.width / 2))
  const minY = Math.min(...layout.nodes.map((n) => n.y - n.height / 2))
  const maxX = Math.max(...layout.nodes.map((n) => n.x + n.width / 2))
  const maxY = Math.max(...layout.nodes.map((n) => n.y + n.height / 2))
  const viewBox = `${minX - 40} ${minY - 40} ${maxX - minX + 80} ${maxY - minY + 80}`
  // Render at natural size and let the wrapper scroll, rather than
  // squashing a large DAG into an unreadable thumbnail on small screens.
  const graphWidth = Math.max(720, maxX - minX + 80)
  const graphHeight = Math.max(420, maxY - minY + 80)

  return (
    <>
      <details className="task-graph-help">
        <summary>How to read this graph</summary>
        <p>
          Solid arrows show a task broken into smaller tasks. Dashed arrows show prerequisites;
          the arrow points to the task that must wait.
        </p>
      </details>
      <div className="task-graph-wrap">
        <svg
          viewBox={viewBox}
          width={graphWidth}
          height={graphHeight}
          style={{ maxWidth: 'none', display: 'block' }}
        >
          <defs>
            <marker
              id="arrow"
              markerWidth="10"
              markerHeight="10"
              refX="9"
              refY="3"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L0,6 L9,3 z" fill="#6b7280" />
            </marker>
          </defs>
          {data.edges.map((edge, i) => {
            const s = layout.nodes.find((n) => n.node.taskId === edge.source)
            const t = layout.nodes.find((n) => n.node.taskId === edge.target)
            if (!s || !t) return null
            return (
              <line
                key={i}
                x1={s.x}
                y1={s.y + s.height / 2}
                x2={t.x}
                y2={t.y - t.height / 2}
                stroke={edge.kind === 'breakdown' ? '#6b7280' : '#3b82f6'}
                strokeWidth="2"
                strokeDasharray={edge.kind === 'dependency' ? '5,5' : '0'}
                markerEnd="url(#arrow)"
              />
            )
          })}
          {layout.nodes.map((ln) => {
            const isSel = selected?.taskId === ln.node.taskId
            const visualStatus = graphStatusKey(ln.node)
            const highlighted = taskMatchesPlanStatus(ln.node, status)
            return (
              <g
                key={ln.node.taskId}
                transform={`translate(${ln.x - ln.width / 2}, ${ln.y - ln.height / 2})`}
                onClick={() => onSelect(ln.node)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(ln.node)
                  }
                }}
                role="button"
                className={highlighted ? undefined : 'task-graph-node--dimmed'}
                tabIndex={0}
                aria-label={`${ln.node.title} (${statusLabel(ln.node)})`}
                style={{ cursor: 'pointer' }}
              >
                <rect
                  width={ln.width}
                  height={ln.height}
                  fill={STATUS_FILL[visualStatus] ?? '#f3f4f6'}
                  stroke={isSel ? '#3b82f6' : STATUS_COLOR[visualStatus] ?? '#6b7280'}
                  strokeWidth={isSel ? 3 : 2}
                  rx="6"
                />
                <text x={ln.width / 2} y={ln.height / 2 - 8} textAnchor="middle" style={{ fontSize: '11px', fontWeight: 600, fill: '#111' }}>
                  {ln.node.title.length > 26 ? ln.node.title.slice(0, 26) + '…' : ln.node.title}
                </text>
                <text x={ln.width / 2} y={ln.height / 2 + 10} textAnchor="middle" style={{ fontSize: '10px', fill: STATUS_COLOR[visualStatus] ?? '#6b7280' }}>
                  {statusLabel(ln.node)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      {selected && (
        <div ref={selectedPanelRef} style={{ marginTop: '1rem' }}>
          <div className="inline-row" style={{ justifyContent: 'space-between' }}>
            <strong>Selected task</strong>
            <span className="inline-row wrap-row task-selected-actions" style={{ gap: '0.75rem' }}>
              <Link className="task-link-button" to={`/tasks/${selected.repository}/task/${selected.taskId}`}>
                View full task details
              </Link>
              <button type="button" className="task-link-button" onClick={() => onSelect(null)}>
                Clear
              </button>
            </span>
          </div>
          <div style={{ marginTop: '0.5rem' }}>
            <TaskCard task={selected} />
          </div>
        </div>
      )}
      {selectedMissing && (
        <article className="mini-card" style={{ marginTop: '1rem' }}>
          <p>The selected task is no longer available in the current plan snapshot.</p>
          <button type="button" className="task-link-button" onClick={() => onSelect(null)}>Clear selection</button>
        </article>
      )}
    </>
  )
}

export function graphStatusKey(task: Pick<TaskNode, 'state' | 'isReady'>): string {
  if (task.state === 'frontier') return task.isReady ? 'ready' : 'waiting'
  if (task.state === 'active') return 'in-progress'
  return task.state
}

export function parseTaskPlanStatus(value: string | null): TaskPlanStatus {
  return value != null && TASK_PLAN_STATUSES.has(value as TaskPlanStatus) ? value as TaskPlanStatus : 'all'
}

export function canonicalTaskPlanSearch(searchParams: URLSearchParams): URLSearchParams | null {
  const rawStatus = searchParams.get('status')
  if (rawStatus == null) return null
  if (rawStatus !== '' && rawStatus !== 'all' && TASK_PLAN_STATUSES.has(rawStatus as TaskPlanStatus)) return null
  const normalized = new URLSearchParams(searchParams)
  normalized.delete('status')
  return normalized
}

export function taskMatchesPlanStatus(task: Pick<TaskNode, 'state' | 'isReady'>, status: TaskPlanStatus): boolean {
  return status === 'all' || graphStatusKey(task) === status
}

function taskNodeKey(task: Pick<TaskNode, 'repository' | 'taskId'>): string {
  return `${task.repository}:${task.taskId}`
}

export function withoutEpicNodes(data: DagResult): DagResult {
  const nodes = data.nodes.filter((node) => node.type !== 'epic')
  const ids = new Set(nodes.map((node) => node.taskId))
  const statusCounts = Object.fromEntries(
    ['ready', 'waiting', 'done', 'in-progress', 'blocked'].map((status) =>
      [status, nodes.filter((node) => graphStatusKey(node) === status).length] as const),
  )
  return { ...data, nodes, edges: data.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)), summary: { totalTasks: nodes.length, statusCounts } }
}

function layoutDag(data: DagResult): { nodes: LayoutNode[] } {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80 })
  g.setDefaultEdgeLabel(() => ({}))
  data.nodes.forEach((n) => g.setNode(n.taskId, { width: 190, height: 64 }))
  data.edges.forEach((e) => {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target)
  })
  dagre.layout(g)
  return {
    nodes: data.nodes.map((node) => {
      const n = g.node(node.taskId)
      return { x: n.x, y: n.y, width: n.width, height: n.height, node }
    }),
  }
}
