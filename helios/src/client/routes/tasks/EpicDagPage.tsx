import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import dagre from 'dagre'
import { Pill } from '../../components/Pill.js'
import {
  fetchTaskJson,
  usePolledData,
  SourceBanner,
  TaskUnavailable,
  TaskCard,
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
  done: '#22c55e',
  'in-progress': '#f59e0b',
  blocked: '#ef4444',
  pending: '#6b7280',
}
const STATUS_FILL: Record<string, string> = {
  done: '#dcfce7',
  'in-progress': '#fef3c7',
  blocked: '#fee2e2',
  pending: '#f3f4f6',
}

export function EpicDagPage() {
  const { id } = useParams<{ id: string }>()
  const [view, setView] = useState<'list' | 'graph'>('list')
  const [selected, setSelected] = useState<TaskNode | null>(null)

  const { data, error, loading, refresh } = usePolledData<DagResult>(
    () => fetchTaskJson<DagResult>(`/api/tasks/epics/${id}/dag`),
    [id],
    30_000,
  )

  if (loading && !data) {
    return (
      <section>
        <div className="page-header">
          <h2>Epic DAG</h2>
        </div>
        <p>Loading...</p>
      </section>
    )
  }

  if ((error && !data) || !data) {
    return (
      <section>
        <div className="page-header">
          <h2>Epic DAG</h2>
        </div>
        <TaskUnavailable error={error} onRetry={refresh} />
        <p className="subtle-copy" style={{ marginTop: '1rem' }}>
          <Link to="/tasks">Back to task management</Link>
        </p>
      </section>
    )
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Operations · Epic</p>
          <h2>{data.epic.title}</h2>
          {data.epic.issueNumber != null && (
            <p className="subtle-copy">
              <a
                href={data.epic.githubUrl ?? githubIssueUrl(data.epic.issueNumber)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Issue #{data.epic.issueNumber}
              </a>{' '}
              · {data.summary.totalTasks} tasks
            </p>
          )}
        </div>
      </div>

      <SourceBanner source={data.source} onRefresh={refresh} />

      <div className="task-summary-row">
        {(['done', 'in-progress', 'blocked', 'pending'] as const).map((s) => (
          <div
            key={s}
            className="task-summary-stat"
            style={{ borderColor: STATUS_COLOR[s] }}
          >
            <span className="task-summary-value">{data.summary.statusCounts[s] ?? 0}</span>
            <span className="task-summary-label">{s.replace('-', ' ')}</span>
          </div>
        ))}
      </div>

      <div className="task-control-actions" style={{ marginBottom: '1rem' }}>
        <button
          type="button"
          className={`task-chip${view === 'list' ? ' task-chip--active' : ''}`}
          onClick={() => setView('list')}
        >
          List
        </button>
        <button
          type="button"
          className={`task-chip${view === 'graph' ? ' task-chip--active' : ''}`}
          onClick={() => setView('graph')}
        >
          Graph
        </button>
        {data.epic.issueNumber != null ? (
          <Link
            to={`/tasks/frontier?issue=${data.epic.issueNumber}`}
            className="task-link-button"
          >
            Frontier for issue #{data.epic.issueNumber}
          </Link>
        ) : (
          <Link to="/tasks/frontier" className="task-link-button">
            All frontier
          </Link>
        )}
        {data.epic.issueNumber != null && (
          <a
            href={data.epic.githubUrl ?? githubIssueUrl(data.epic.issueNumber)}
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
        <DagListView data={data} />
      ) : (
        <DagGraphView data={data} selected={selected} onSelect={setSelected} />
      )}

      <p className="subtle-copy" style={{ marginTop: '1.5rem' }}>
        <Link to="/tasks">Back to task management</Link>
      </p>
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
          key={node.sha}
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
      <p className="subtle-copy" style={{ marginBottom: '0.5rem' }}>
        Scroll to pan. Tap a node to inspect it.
      </p>
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
                aria-label={`${ln.node.title} (${ln.node.type}, ${ln.node.status})`}
                style={{ cursor: 'pointer' }}
              >
                <rect
                  width={ln.width}
                  height={ln.height}
                  fill={STATUS_FILL[ln.node.status] ?? '#f3f4f6'}
                  stroke={isSel ? '#3b82f6' : STATUS_COLOR[ln.node.status] ?? '#6b7280'}
                  strokeWidth={isSel ? 3 : 2}
                  rx="6"
                />
                <text x={ln.width / 2} y={ln.height / 2 - 8} textAnchor="middle" style={{ fontSize: '11px', fontWeight: 600, fill: '#111' }}>
                  {ln.node.title.length > 26 ? ln.node.title.slice(0, 26) + '…' : ln.node.title}
                </text>
                <text x={ln.width / 2} y={ln.height / 2 + 10} textAnchor="middle" style={{ fontSize: '10px', fill: STATUS_COLOR[ln.node.status] ?? '#6b7280' }}>
                  {ln.node.type} · {ln.node.status}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
        Solid arrow = breakdown (parent → child); dashed = dependency (prerequisite → dependent).
      </p>
      {selected && (
        <div style={{ marginTop: '1rem' }}>
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
        <Pill tone="success">Done</Pill>
        <Pill tone="warning">In progress</Pill>
        <Pill tone="danger">Blocked</Pill>
        <Pill tone="muted">Pending</Pill>
      </div>
    </>
  )
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
