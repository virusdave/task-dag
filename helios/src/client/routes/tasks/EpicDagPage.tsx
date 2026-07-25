import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import dagre from 'dagre'
import { Pill } from '../../components/Pill.js'
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
  pending: '#6b7280',
}
const STATUS_FILL: Record<string, string> = {
  ready: '#bbf7d0',
  done: '#dcfce7',
  'in-progress': '#fef3c7',
  blocked: '#fee2e2',
  pending: '#f3f4f6',
}

export function EpicDagPage() {
  const { id = '', repository = '' } = useParams<{ id: string; repository: string }>()
  const [view, setView] = useState<'list' | 'graph'>('list')
  const [selected, setSelected] = useState<TaskNode | null>(null)

  const { data, error, loading, refreshing, refresh } = usePolledData<DagResult>(
    () => fetchTaskJson<DagResult>(`/api/tasks/repositories/${repository}/epics/${id}/dag`),
    [id, repository],
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

      <div className="task-summary-row">
        {([
          ['ready', 'Ready', '#22c55e'],
          ['in-progress', 'In progress', STATUS_COLOR['in-progress']],
          ['blocked', 'Blocked', STATUS_COLOR.blocked],
          ['waiting', 'Waiting', STATUS_COLOR.pending],
          ['done', 'Done', STATUS_COLOR.done],
        ] as const).map(([status, label, color]) => (
          <div
            key={status}
            className="task-summary-stat"
            style={{ borderColor: color }}
          >
            <span className="task-summary-value">{taskData.summary.statusCounts[status] ?? 0}</span>
            <span className="task-summary-label">{label}</span>
          </div>
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
        {data.epic.issueNumber != null ? (
          <Link
            to={`/tasks/frontier?repository=${data.epic.repository}&issue=${data.epic.issueNumber}&status=ready`}
            className="task-link-button"
          >
            View ready tasks
          </Link>
        ) : (
          <Link to="/tasks/frontier" className="task-link-button">
            Task queue
          </Link>
        )}
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
        <DagListView data={taskData} />
      ) : (
        <DagGraphView data={taskData} selected={selected} onSelect={setSelected} />
      )}
      <DataStatus source={sourceFromError(error) ?? data.source} onRefresh={refresh} refreshing={refreshing} />

    </section>
  )
}

function DagListView({ data }: { data: DagResult }) {
  // Order by breakdown depth so parents precede children.
  const bySha = useMemo(() => new Map(data.nodes.map((n) => [n.sha, n])), [data.nodes])
  const ordered = useMemo(() => {
    const roots = data.nodes.filter((n) => !n.parentTask || !bySha.has(n.parentTask))
    const out: { node: TaskNode; depth: number }[] = []
    const seen = new Set<string>()
    const visit = (n: TaskNode, depth: number) => {
      if (seen.has(n.sha)) return
      seen.add(n.sha)
      out.push({ node: n, depth })
      for (const childSha of n.breakdownChildren) {
        const child = bySha.get(childSha)
        if (child) visit(child, depth + 1)
      }
    }
    roots.forEach((r) => visit(r, 0))
    // Any nodes not reached (cycles / detached) appended at depth 0.
    data.nodes.forEach((n) => {
      if (!seen.has(n.sha)) visit(n, 0)
    })
    return out
  }, [data.nodes, bySha])

  return (
    <div className="task-group-body">
      {ordered.map(({ node, depth }) => (
        <div
          key={`${node.repository}:${node.sha}`}
          style={{ marginLeft: `${Math.min(depth, 4) * 1.25}rem` }}
        >
          <TaskCard task={node} />
        </div>
      ))}
    </div>
  )
}

function DagGraphView({
  data,
  selected,
  onSelect,
}: {
  data: DagResult
  selected: TaskNode | null
  onSelect: (n: TaskNode | null) => void
}) {
  const layout = useMemo(() => layoutDag(data), [data])
  const selectedPanelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selected) selectedPanelRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
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
            const s = layout.nodes.find((n) => n.node.sha === edge.source)
            const t = layout.nodes.find((n) => n.node.sha === edge.target)
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
            const isSel = selected?.sha === ln.node.sha
            const visualStatus = graphStatusKey(ln.node)
            return (
              <g
                key={ln.node.sha}
                transform={`translate(${ln.x - ln.width / 2}, ${ln.y - ln.height / 2})`}
                onClick={() => onSelect(ln.node)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(ln.node)
                  }
                }}
                role="button"
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
            <button type="button" className="task-link-button" onClick={() => onSelect(null)}>
              Clear
            </button>
          </div>
          <div style={{ marginTop: '0.5rem' }}>
            <TaskCard task={selected} />
          </div>
        </div>
      )}
      <div className="inline-row wrap-row" style={{ marginTop: '0.75rem', gap: '0.5rem' }}>
        <Pill tone="success">Ready</Pill>
        <Pill tone="success">Done</Pill>
        <Pill tone="warning">In progress</Pill>
        <Pill tone="danger">Blocked</Pill>
        <Pill tone="muted">Waiting</Pill>
      </div>
    </>
  )
}

export function graphStatusKey(task: Pick<TaskNode, 'status' | 'isReady'>): string {
  return task.isReady ? 'ready' : task.status
}

export function withoutEpicNodes(data: DagResult): DagResult {
  const nodes = data.nodes.filter((node) => node.type !== 'epic')
  const ids = new Set(nodes.map((node) => node.sha))
  const statusCounts = Object.fromEntries(
    [
      ['ready', nodes.filter((node) => node.isReady).length],
      ['waiting', nodes.filter((node) => node.status === 'pending' && !node.isReady).length],
      ...['done', 'in-progress', 'blocked'].map((status) => [status, nodes.filter((node) => node.status === status).length] as const),
    ],
  )
  return { ...data, nodes, edges: data.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)), summary: { totalTasks: nodes.length, statusCounts } }
}

function layoutDag(data: DagResult): { nodes: LayoutNode[] } {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80 })
  g.setDefaultEdgeLabel(() => ({}))
  data.nodes.forEach((n) => g.setNode(n.sha, { width: 190, height: 64 }))
  data.edges.forEach((e) => {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target)
  })
  dagre.layout(g)
  return {
    nodes: data.nodes.map((node) => {
      const n = g.node(node.sha)
      return { x: n.x, y: n.y, width: n.width, height: n.height, node }
    }),
  }
}
