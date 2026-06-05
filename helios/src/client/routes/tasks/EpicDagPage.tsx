import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import dagre from 'dagre'
import { Pill } from '../../components/Pill.js'

interface TaskNode {
  sha: string
  shortSha: string
  title: string
  status: string
  type: string
  dependencies: string[]
}

interface TaskEdge {
  source: string
  target: string
  kind: 'breakdown' | 'dependency'
}

interface DagResult {
  nodes: TaskNode[]
  edges: TaskEdge[]
  summary: {
    totalTasks: number
    statusCounts: Record<string, number>
  }
}

interface LayoutNode {
  x: number
  y: number
  width: number
  height: number
  node: TaskNode
}

export function EpicDagPage() {
  const { id } = useParams<{ id: string }>()
  const [dag, setDag] = useState<DagResult | null>(null)
  const [selectedNode, setSelectedNode] = useState<TaskNode | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    async function loadDag() {
      if (!id) return

      try {
        const res = await fetch(`/api/tasks/epics/${id}/dag`)
        if (!res.ok) throw new Error('Failed to load epic DAG')

        const data = await res.json()
        setDag(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    loadDag()
    const interval = setInterval(loadDag, 300000) // Poll every 300s (DB-cost epic E1)
    return () => clearInterval(interval)
  }, [id])

  const layoutDag = (dagData: DagResult): LayoutNode[] => {
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'TB', nodesep: 80, ranksep: 100 })
    g.setDefaultEdgeLabel(() => ({}))

    // Add nodes
    dagData.nodes.forEach((node) => {
      g.setNode(node.sha, { width: 200, height: 80 })
    })

    // Add edges
    dagData.edges.forEach((edge) => {
      g.setEdge(edge.source, edge.target)
    })

    dagre.layout(g)

    // Extract layout positions
    return dagData.nodes.map((node) => {
      const n = g.node(node.sha)
      return {
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        node,
      }
    })
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'done':
        return '#22c55e'
      case 'in-progress':
        return '#f59e0b'
      case 'blocked':
        return '#ef4444'
      default:
        return '#6b7280'
    }
  }

  const getNodeFill = (status: string) => {
    switch (status) {
      case 'done':
        return '#dcfce7'
      case 'in-progress':
        return '#fef3c7'
      case 'blocked':
        return '#fee2e2'
      default:
        return '#f3f4f6'
    }
  }

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h2>Epic DAG</h2>
        </div>
        <p>Loading...</p>
      </section>
    )
  }

  if (error || !dag) {
    return (
      <section>
        <div className="page-header">
          <h2>Epic DAG</h2>
        </div>
        <p style={{ color: 'var(--color-danger)' }}>Error: {error || 'No data'}</p>
        <Link to="/tasks">← Back to Task Management</Link>
      </section>
    )
  }

  const layoutNodes = layoutDag(dag)
  const minX = Math.min(...layoutNodes.map((n) => n.x - n.width / 2))
  const minY = Math.min(...layoutNodes.map((n) => n.y - n.height / 2))
  const maxX = Math.max(...layoutNodes.map((n) => n.x + n.width / 2))
  const maxY = Math.max(...layoutNodes.map((n) => n.y + n.height / 2))

  const viewBox = `${minX - 50} ${minY - 50} ${maxX - minX + 100} ${maxY - minY + 100}`

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Epic DAG</p>
          <h2>Task Dependency Graph</h2>
          <p className="subtle-copy">Issue #{id}</p>
        </div>
      </div>

      <div className="review-grid" style={{ marginBottom: '2rem' }}>
        <article className="mini-card">
          <header>
            <strong>Summary</strong>
          </header>
          <div className="stacked-list compact-stack">
            <div className="mini-card-row">
              <span>Total Tasks</span>
              <strong>{dag.summary.totalTasks}</strong>
            </div>
            {Object.entries(dag.summary.statusCounts).map(([status, count]) => (
              <div className="mini-card-row" key={status}>
                <span style={{ textTransform: 'capitalize' }}>{status.replace('-', ' ')}</span>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Legend</strong>
          </header>
          <div className="stacked-list compact-stack">
            <div className="mini-card-row">
              <span>Solid arrow</span>
              <span>Breakdown (parent → child)</span>
            </div>
            <div className="mini-card-row">
              <span>Dashed arrow</span>
              <span>Dependency (prerequisite → dependent)</span>
            </div>
          </div>
          <div className="inline-row wrap-row" style={{ marginTop: '1rem', gap: '0.5rem' }}>
            <Pill tone="success">Done</Pill>
            <Pill tone="warning">In Progress</Pill>
            <Pill tone="danger">Blocked</Pill>
            <Pill tone="muted">Pending</Pill>
          </div>
        </article>
      </div>

      <div
        style={{
          background: '#fff',
          border: '1px solid var(--color-border)',
          borderRadius: '8px',
          padding: '1rem',
          overflow: 'auto',
          marginBottom: '2rem',
        }}
      >
        <svg ref={svgRef} viewBox={viewBox} style={{ width: '100%', height: '600px' }}>
          {/* Render edges */}
          <g>
            {dag.edges.map((edge, i) => {
              const sourceNode = layoutNodes.find((n) => n.node.sha === edge.source)
              const targetNode = layoutNodes.find((n) => n.node.sha === edge.target)

              if (!sourceNode || !targetNode) return null

              const x1 = sourceNode.x
              const y1 = sourceNode.y + sourceNode.height / 2
              const x2 = targetNode.x
              const y2 = targetNode.y - targetNode.height / 2

              return (
                <g key={i}>
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={edge.kind === 'breakdown' ? '#6b7280' : '#3b82f6'}
                    strokeWidth="2"
                    strokeDasharray={edge.kind === 'dependency' ? '5,5' : '0'}
                    markerEnd="url(#arrowhead)"
                  />
                </g>
              )
            })}
          </g>

          {/* Arrow marker */}
          <defs>
            <marker
              id="arrowhead"
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

          {/* Render nodes */}
          <g>
            {layoutNodes.map((layoutNode) => {
              const { x, y, width, height, node } = layoutNode
              const isSelected = selectedNode?.sha === node.sha

              return (
                <g
                  key={node.sha}
                  transform={`translate(${x - width / 2}, ${y - height / 2})`}
                  onClick={() => setSelectedNode(node)}
                  style={{ cursor: 'pointer' }}
                >
                  <rect
                    width={width}
                    height={height}
                    fill={getNodeFill(node.status)}
                    stroke={isSelected ? '#3b82f6' : getStatusColor(node.status)}
                    strokeWidth={isSelected ? 3 : 2}
                    rx="6"
                  />
                  <text
                    x={width / 2}
                    y={height / 2 - 10}
                    textAnchor="middle"
                    style={{ fontSize: '12px', fontWeight: 600, fill: '#111' }}
                  >
                    {node.title.length > 25 ? node.title.substring(0, 25) + '...' : node.title}
                  </text>
                  <text
                    x={width / 2}
                    y={height / 2 + 10}
                    textAnchor="middle"
                    style={{ fontSize: '10px', fill: '#6b7280' }}
                  >
                    {node.type} • {node.shortSha}
                  </text>
                  <text
                    x={width / 2}
                    y={height / 2 + 25}
                    textAnchor="middle"
                    style={{ fontSize: '10px', fill: getStatusColor(node.status), fontWeight: 500 }}
                  >
                    {node.status}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>
      </div>

      {selectedNode && (
        <article className="mini-card" style={{ marginBottom: '2rem' }}>
          <header>
            <strong>Selected Task</strong>
            <button
              onClick={() => setSelectedNode(null)}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontSize: '1.25rem',
                padding: '0',
              }}
            >
              ×
            </button>
          </header>
          <div>
            <h3 style={{ marginTop: '0.5rem' }}>{selectedNode.title}</h3>
            <div className="inline-row wrap-row" style={{ marginTop: '0.75rem', gap: '1rem' }}>
              <div>
                <span className="subtle-copy">Type:</span> {selectedNode.type}
              </div>
              <div>
                <span className="subtle-copy">Status:</span> {selectedNode.status}
              </div>
              <div>
                <span className="subtle-copy">Dependencies:</span> {selectedNode.dependencies.length}
              </div>
            </div>
            <div className="inline-row wrap-row module-card-links" style={{ marginTop: '1rem' }}>
              <Link to={`/tasks/task/${selectedNode.sha}`}>View Full Details</Link>
              <button
                onClick={() => navigator.clipboard.writeText(selectedNode.sha)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--color-link)',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: 'inherit',
                }}
              >
                Copy SHA
              </button>
            </div>
            <p className="subtle-copy" style={{ marginTop: '0.75rem', fontSize: '0.75rem', fontFamily: 'monospace' }}>
              {selectedNode.sha}
            </p>
          </div>
        </article>
      )}

      <div>
        <Link to="/tasks" style={{ fontSize: '0.875rem' }}>
          ← Back to Task Management
        </Link>
      </div>
    </section>
  )
}
