import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Pill } from '../../components/Pill.js'

interface EpicSummary {
  issueNumber?: number
  epicRef: string
  sha: string
  title: string
  statusCounts: Record<string, number>
  frontierCount: number
  completionPct: number
}

interface Activity {
  totalEpics: number
  totalFrontier: number
  activeTasks: number
  completedToday: number
  epicSummaries: Array<{
    title: string
    issueNumber?: number
    frontierCount: number
    completionPct: number
  }>
}

export function TasksPage() {
  const [epics, setEpics] = useState<EpicSummary[]>([])
  const [activity, setActivity] = useState<Activity | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function loadData() {
      try {
        const [epicsRes, activityRes] = await Promise.all([
          fetch('/api/tasks/epics'),
          fetch('/api/tasks/activity'),
        ])

        if (!epicsRes.ok || !activityRes.ok) {
          throw new Error('Failed to load task data')
        }

        const [epicsData, activityData] = await Promise.all([
          epicsRes.json(),
          activityRes.json(),
        ])

        setEpics(epicsData)
        setActivity(activityData)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    loadData()
    const interval = setInterval(loadData, 10000) // Poll every 10s
    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h2>Task Management</h2>
        </div>
        <p>Loading...</p>
      </section>
    )
  }

  if (error) {
    return (
      <section>
        <div className="page-header">
          <h2>Task Management</h2>
        </div>
        <p style={{ color: 'var(--color-danger)' }}>Error: {error}</p>
      </section>
    )
  }

  const getCompletionTone = (pct: number) => {
    if (pct >= 0.8) return 'success'
    if (pct >= 0.5) return 'warning'
    return 'muted'
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Git-DAG Task Management</p>
          <h2>Automated Development Task Tracking</h2>
          <p className="subtle-copy">
            Track epics, tasks, and leaf-level work across parallel agentic development efforts.
          </p>
        </div>
      </div>

      {activity && (
        <div className="review-grid" style={{ marginBottom: '2rem' }}>
          <article className="mini-card">
            <header>
              <strong>Activity Overview</strong>
              <Pill tone="muted">live</Pill>
            </header>
            <div className="stacked-list compact-stack">
              <div className="mini-card-row">
                <span>Total Epics</span>
                <strong>{activity.totalEpics}</strong>
              </div>
              <div className="mini-card-row">
                <span>Frontier Tasks</span>
                <strong>{activity.totalFrontier}</strong>
              </div>
              <div className="mini-card-row">
                <span>Active Tasks</span>
                <strong>{activity.activeTasks}</strong>
              </div>
            </div>
            <div className="inline-row wrap-row module-card-links" style={{ marginTop: '1rem' }}>
              <Link to="/tasks/frontier">View Frontier</Link>
            </div>
          </article>

          <article className="mini-card">
            <header>
              <strong>Quick Links</strong>
            </header>
            <div className="inline-row wrap-row module-card-links">
              <a href="https://github.com/FreshlyBakedNYC/automation/issues" target="_blank" rel="noopener noreferrer">
                GitHub Issues
              </a>
              <Link to="/tasks/validate">Validate DAG</Link>
            </div>
            <p className="subtle-copy" style={{ marginTop: '1rem' }}>
              Use the <code>task-dag</code> CLI for detailed queries and management.
            </p>
          </article>
        </div>
      )}

      <div className="page-header">
        <div>
          <p className="eyebrow">Epics</p>
          <h2>Current Development Efforts</h2>
        </div>
      </div>

      {epics.length === 0 ? (
        <article className="mini-card">
          <p className="subtle-copy">No epics found. Create a GitHub issue to start a new epic.</p>
        </article>
      ) : (
        <div className="review-grid">
          {epics.map((epic) => {
            const totalTasks = Object.values(epic.statusCounts).reduce((sum, count) => sum + count, 0)
            const doneTasks = epic.statusCounts.done || 0

            return (
              <article className="mini-card" key={epic.sha}>
                <header>
                  <div>
                    <strong>{epic.title}</strong>
                    {epic.issueNumber && (
                      <p className="subtle-copy" style={{ marginTop: '0.25rem' }}>
                        <a
                          href={`https://github.com/FreshlyBakedNYC/automation/issues/${epic.issueNumber}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: '0.875rem' }}
                        >
                          Issue #{epic.issueNumber}
                        </a>
                      </p>
                    )}
                  </div>
                  <Pill tone={getCompletionTone(epic.completionPct)}>
                    {Math.round(epic.completionPct * 100)}%
                  </Pill>
                </header>

                <div className="stacked-list compact-stack" style={{ marginTop: '0.75rem' }}>
                  <div className="mini-card-row">
                    <span>Total Tasks</span>
                    <strong>{totalTasks}</strong>
                  </div>
                  <div className="mini-card-row">
                    <span>Completed</span>
                    <strong>{doneTasks}</strong>
                  </div>
                  <div className="mini-card-row">
                    <span>Frontier</span>
                    <strong>{epic.frontierCount}</strong>
                  </div>
                  {epic.statusCounts.pending && (
                    <div className="mini-card-row">
                      <span>Pending</span>
                      <strong>{epic.statusCounts.pending}</strong>
                    </div>
                  )}
                  {epic.statusCounts['in-progress'] && (
                    <div className="mini-card-row">
                      <span>In Progress</span>
                      <strong>{epic.statusCounts['in-progress']}</strong>
                    </div>
                  )}
                </div>

                <div className="inline-row wrap-row module-card-links" style={{ marginTop: '1rem' }}>
                  {epic.issueNumber && <Link to={`/tasks/epic/${epic.issueNumber}`}>View DAG</Link>}
                  <Link to={`/tasks/frontier?issue=${epic.issueNumber || ''}`}>Frontier Tasks</Link>
                </div>

                <p className="subtle-copy" style={{ marginTop: '0.75rem', fontSize: '0.75rem', fontFamily: 'monospace' }}>
                  {epic.sha.substring(0, 12)}
                </p>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
