import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Pill } from '../../components/Pill.js'

interface TaskNode {
  sha: string
  shortSha: string
  title: string
  issueNumber?: number
  status: string
  type: string
  author?: string
  parentTask?: string
  dependencies: string[]
  breakdownChildren: string[]
  refs: string[]
  isFrontier: boolean
  isActive: boolean
  completedBy: string[]
}

export function TaskDetailPage() {
  const { sha } = useParams<{ sha: string }>()
  const [task, setTask] = useState<TaskNode | null>(null)
  const [depTasks, setDepTasks] = useState<Record<string, TaskNode>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function loadTask() {
      if (!sha) return

      try {
        const res = await fetch(`/api/tasks/task/${sha}`)
        if (!res.ok) throw new Error('Failed to load task')

        const data = await res.json()
        setTask(data)

        // Load dependency tasks
        if (data.dependencies.length > 0) {
          const deps: Record<string, TaskNode> = {}
          await Promise.all(
            data.dependencies.map(async (depSha: string) => {
              try {
                const depRes = await fetch(`/api/tasks/task/${depSha}`)
                if (depRes.ok) {
                  deps[depSha] = await depRes.json()
                }
              } catch {
                // Ignore errors for individual dependencies
              }
            })
          )
          setDepTasks(deps)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    loadTask()
  }, [sha])

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h2>Task Details</h2>
        </div>
        <p>Loading...</p>
      </section>
    )
  }

  if (error || !task) {
    return (
      <section>
        <div className="page-header">
          <h2>Task Details</h2>
        </div>
        <p style={{ color: 'var(--color-danger)' }}>Error: {error || 'Task not found'}</p>
        <Link to="/tasks/frontier">← Back to Frontier</Link>
      </section>
    )
  }

  const getStatusTone = (status: string) => {
    if (status === 'done') return 'success'
    if (status === 'in-progress') return 'warning'
    if (status === 'blocked') return 'danger'
    return 'muted'
  }

  const allDepsMet = task.dependencies.every((depSha) => {
    const dep = depTasks[depSha]
    return dep && dep.status === 'done'
  })

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Task Details</p>
          <h2>{task.title}</h2>
          {task.issueNumber && (
            <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
              <a
                href={`https://github.com/FreshlyBakedNYC/automation/issues/${task.issueNumber}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Issue #{task.issueNumber}
              </a>
            </p>
          )}
        </div>
      </div>

      <div className="review-grid" style={{ marginBottom: '2rem' }}>
        <article className="mini-card">
          <header>
            <strong>Metadata</strong>
            <div className="inline-row" style={{ gap: '0.5rem' }}>
              {task.isFrontier && <Pill tone="muted">Frontier</Pill>}
              {task.isActive && <Pill tone="warning">Active</Pill>}
              <Pill tone={getStatusTone(task.status)}>{task.status}</Pill>
            </div>
          </header>
          <div className="stacked-list compact-stack">
            <div className="mini-card-row">
              <span>Type</span>
              <strong>{task.type}</strong>
            </div>
            {task.author && (
              <div className="mini-card-row">
                <span>Author</span>
                <strong>{task.author}</strong>
              </div>
            )}
            <div className="mini-card-row">
              <span>Dependencies</span>
              <strong>{task.dependencies.length}</strong>
            </div>
            <div className="mini-card-row">
              <span>Subtasks</span>
              <strong>{task.breakdownChildren.length}</strong>
            </div>
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Git References</strong>
          </header>
          <div className="stacked-list compact-stack">
            <div>
              <span className="subtle-copy" style={{ fontSize: '0.875rem' }}>SHA</span>
              <p style={{ fontFamily: 'monospace', fontSize: '0.875rem', marginTop: '0.25rem' }}>{task.sha}</p>
              <button
                onClick={() => navigator.clipboard.writeText(task.sha)}
                style={{
                  marginTop: '0.5rem',
                  padding: '0.25rem 0.5rem',
                  fontSize: '0.75rem',
                  background: 'var(--color-subtle-bg)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                Copy SHA
              </button>
            </div>
            {task.refs.length > 0 && (
              <div style={{ marginTop: '0.75rem' }}>
                <span className="subtle-copy" style={{ fontSize: '0.875rem' }}>Refs</span>
                {task.refs.map((ref) => (
                  <p key={ref} style={{ fontFamily: 'monospace', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {ref}
                  </p>
                ))}
              </div>
            )}
          </div>
        </article>
      </div>

      {task.dependencies.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          <h3 style={{ marginBottom: '1rem' }}>Dependencies {!allDepsMet && <span style={{ color: 'var(--color-danger)' }}>⚠</span>}</h3>
          <div className="stacked-list">
            {task.dependencies.map((depSha) => {
              const dep = depTasks[depSha]
              const completed = dep && dep.status === 'done'

              return (
                <article className="mini-card" key={depSha}>
                  <header>
                    <div>
                      <strong>{dep ? dep.title : 'Unknown Task'}</strong>
                      <p className="subtle-copy" style={{ marginTop: '0.25rem', fontSize: '0.75rem', fontFamily: 'monospace' }}>
                        {depSha.substring(0, 12)}
                      </p>
                    </div>
                    <Pill tone={completed ? 'success' : 'danger'}>{completed ? 'Completed' : 'Pending'}</Pill>
                  </header>
                  {dep && (
                    <div className="inline-row wrap-row module-card-links" style={{ marginTop: '0.75rem' }}>
                      <Link to={`/tasks/task/${depSha}`}>View Details</Link>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
          {!allDepsMet && (
            <p className="subtle-copy" style={{ marginTop: '1rem', color: 'var(--color-danger)' }}>
              ⚠ Not all dependencies are met. This task cannot be completed until dependencies are done.
            </p>
          )}
        </div>
      )}

      {task.breakdownChildren.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          <h3 style={{ marginBottom: '1rem' }}>Subtasks ({task.breakdownChildren.length})</h3>
          <p className="subtle-copy" style={{ marginBottom: '0.75rem' }}>
            Use CLI or API to load full subtask details.
          </p>
          <div style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
            {task.breakdownChildren.slice(0, 10).map((childSha) => (
              <div key={childSha} style={{ marginBottom: '0.25rem' }}>
                <Link to={`/tasks/task/${childSha}`}>{childSha.substring(0, 12)}</Link>
              </div>
            ))}
            {task.breakdownChildren.length > 10 && (
              <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
                ... and {task.breakdownChildren.length - 10} more
              </p>
            )}
          </div>
        </div>
      )}

      <div className="review-grid">
        <article className="mini-card">
          <header>
            <strong>CLI Commands</strong>
          </header>
          <div style={{ fontFamily: 'monospace', fontSize: '0.875rem', marginTop: '0.75rem' }}>
            <p># Show details</p>
            <p style={{ background: '#f3f4f6', padding: '0.5rem', borderRadius: '4px', marginTop: '0.25rem' }}>
              task-dag show {task.shortSha}
            </p>

            <p style={{ marginTop: '1rem' }}># Check dependencies</p>
            <p style={{ background: '#f3f4f6', padding: '0.5rem', borderRadius: '4px', marginTop: '0.25rem' }}>
              task-dag deps {task.shortSha} --check-complete
            </p>

            {task.isFrontier && (
              <>
                <p style={{ marginTop: '1rem' }}># Complete task</p>
                <p style={{ background: '#f3f4f6', padding: '0.5rem', borderRadius: '4px', marginTop: '0.25rem' }}>
                  task-dag complete {task.shortSha}
                </p>
              </>
            )}
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Status</strong>
          </header>
          <div style={{ marginTop: '0.75rem' }}>
            {task.status === 'done' ? (
              <p style={{ color: 'var(--color-success)' }}>✓ Task completed</p>
            ) : allDepsMet ? (
              <p style={{ color: 'var(--color-success)' }}>✓ Ready to start (all dependencies met)</p>
            ) : (
              <p style={{ color: 'var(--color-warning)' }}>○ Waiting on dependencies</p>
            )}
          </div>
        </article>
      </div>

      <div style={{ marginTop: '2rem' }}>
        <Link to="/tasks/frontier" style={{ fontSize: '0.875rem' }}>
          ← Back to Frontier
        </Link>
        {' | '}
        <Link to="/tasks" style={{ fontSize: '0.875rem' }}>
          Task Management
        </Link>
      </div>
    </section>
  )
}
