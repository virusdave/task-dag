import { useState, useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { Pill } from '../../components/Pill.js'

interface TaskNode {
  sha: string
  shortSha: string
  title: string
  issueNumber?: number
  status: string
  type: string
  author?: string
  dependencies: string[]
  isFrontier: boolean
  isActive: boolean
}

export function TaskFrontierPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [tasks, setTasks] = useState<TaskNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const issueFilter = searchParams.get('issue') || ''
  const statusFilter = searchParams.get('status') || ''

  useEffect(() => {
    async function loadTasks() {
      try {
        const params = new URLSearchParams()
        if (issueFilter) params.set('issue', issueFilter)
        if (statusFilter) params.set('status', statusFilter)

        const res = await fetch(`/api/tasks/frontier?${params}`)
        if (!res.ok) throw new Error('Failed to load frontier tasks')

        const data = await res.json()
        setTasks(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    loadTasks()
    const interval = setInterval(loadTasks, 60000) // 60s (DB-cost epic E1)
    return () => clearInterval(interval)
  }, [issueFilter, statusFilter])

  const getStatusTone = (status: string) => {
    if (status === 'done') return 'success'
    if (status === 'in-progress') return 'warning'
    if (status === 'blocked') return 'danger'
    return 'muted'
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Task Frontier</p>
          <h2>Available Leaf Tasks</h2>
          <p className="subtle-copy">
            Leaf-level tasks ready to be picked up by agents or developers.
          </p>
        </div>
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        <div className="inline-row wrap-row" style={{ gap: '1rem' }}>
          <div>
            <label htmlFor="issue-filter" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>
              Filter by Issue
            </label>
            <input
              id="issue-filter"
              type="text"
              placeholder="Issue #"
              value={issueFilter}
              onChange={(e) => {
                const params = new URLSearchParams(searchParams)
                if (e.target.value) {
                  params.set('issue', e.target.value)
                } else {
                  params.delete('issue')
                }
                setSearchParams(params)
              }}
              style={{ padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--color-border)' }}
            />
          </div>

          <div>
            <label htmlFor="status-filter" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>
              Filter by Status
            </label>
            <select
              id="status-filter"
              value={statusFilter}
              onChange={(e) => {
                const params = new URLSearchParams(searchParams)
                if (e.target.value) {
                  params.set('status', e.target.value)
                } else {
                  params.delete('status')
                }
                setSearchParams(params)
              }}
              style={{ padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--color-border)' }}
            >
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="in-progress">In Progress</option>
              <option value="blocked">Blocked</option>
            </select>
          </div>

          {(issueFilter || statusFilter) && (
            <button
              onClick={() => setSearchParams(new URLSearchParams())}
              style={{
                padding: '0.5rem 1rem',
                alignSelf: 'flex-end',
                borderRadius: '4px',
                border: '1px solid var(--color-border)',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              Clear Filters
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : error ? (
        <p style={{ color: 'var(--color-danger)' }}>Error: {error}</p>
      ) : tasks.length === 0 ? (
        <article className="mini-card">
          <p className="subtle-copy">No frontier tasks found{(issueFilter || statusFilter) && ' with current filters'}.</p>
          <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
            Frontier tasks are leaf-level tasks ready to be implemented.
          </p>
        </article>
      ) : (
        <div className="stacked-list">
          {tasks.map((task) => (
            <article className="mini-card" key={task.sha}>
              <header>
                <div>
                  <strong>{task.title}</strong>
                  {task.issueNumber && (
                    <p className="subtle-copy" style={{ marginTop: '0.25rem', fontSize: '0.875rem' }}>
                      Issue #{task.issueNumber}
                    </p>
                  )}
                </div>
                <div className="inline-row" style={{ gap: '0.5rem' }}>
                  {task.isActive && <Pill tone="warning">Active</Pill>}
                  <Pill tone={getStatusTone(task.status)}>{task.status}</Pill>
                </div>
              </header>

              <div className="inline-row wrap-row" style={{ marginTop: '0.75rem', gap: '1rem' }}>
                <div>
                  <span className="subtle-copy" style={{ fontSize: '0.875rem' }}>Type:</span>{' '}
                  <span style={{ fontSize: '0.875rem' }}>{task.type}</span>
                </div>
                {task.author && (
                  <div>
                    <span className="subtle-copy" style={{ fontSize: '0.875rem' }}>Author:</span>{' '}
                    <span style={{ fontSize: '0.875rem' }}>{task.author}</span>
                  </div>
                )}
                <div>
                  <span className="subtle-copy" style={{ fontSize: '0.875rem' }}>Dependencies:</span>{' '}
                  <span style={{ fontSize: '0.875rem' }}>{task.dependencies.length}</span>
                </div>
              </div>

              <div className="inline-row wrap-row module-card-links" style={{ marginTop: '1rem' }}>
                <Link to={`/tasks/task/${task.sha}`}>View Details</Link>
                <button
                  onClick={() => navigator.clipboard.writeText(task.sha)}
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
                {task.shortSha}
              </p>
            </article>
          ))}
        </div>
      )}

      <div style={{ marginTop: '2rem' }}>
        <Link to="/tasks" style={{ fontSize: '0.875rem' }}>
          ← Back to Task Management
        </Link>
      </div>
    </section>
  )
}
