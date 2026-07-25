import { Link } from 'react-router-dom'
import { Pill } from '../../components/Pill.js'
import {
  fetchTaskJson,
  usePolledData,
  SourceBanner,
  TaskUnavailable,
  githubIssueUrl,
  type EpicsView,
} from './taskShared.js'

interface Activity {
  source: import('./taskShared.js').TaskDagSourceStatus
  totalEpics: number
  totalFrontier: number
  readyTasks: number
  activeTasks: number
  blockedTasks: number
}

export function TasksPage() {
  const epicsQ = usePolledData<EpicsView>(
    () => fetchTaskJson<EpicsView>('/api/tasks/epics'),
    [],
    30_000,
  )
  const activityQ = usePolledData<Activity>(
    () => fetchTaskJson<Activity>('/api/tasks/activity'),
    [],
    30_000,
  )

  const loading = epicsQ.loading && activityQ.loading && !epicsQ.data && !activityQ.data
  const fatal = epicsQ.error && !epicsQ.data

  const completionTone = (pct: number): 'success' | 'warning' | 'muted' => {
    if (pct >= 0.8) return 'success'
    if (pct >= 0.4) return 'warning'
    return 'muted'
  }

  return (
    <section data-helios-capture-target="tasks-overview" data-helios-capture-ready={String(!epicsQ.loading && !activityQ.loading)}>
      <div className="page-header">
        <div>
          <p className="eyebrow">Operations · Tasks</p>
          <h2>Task management</h2>
          <p className="subtle-copy">
            Git-DAG epics and the frontier of leaf tasks across parallel agentic development.
          </p>
        </div>
      </div>

      <SourceBanner
        source={activityQ.data?.source ?? epicsQ.data?.source}
        onRefresh={() => {
          epicsQ.refresh()
          activityQ.refresh()
        }}
      />

      {activityQ.data && (
        <div className="task-summary-row">
          <Stat label="Ready" value={activityQ.data.readyTasks} tone="success" />
          <Stat label="Active" value={activityQ.data.activeTasks} tone="warning" />
          <Stat label="Blocked" value={activityQ.data.blockedTasks} tone="danger" />
          <Stat label="Frontier" value={activityQ.data.totalFrontier} tone="muted" />
          <Stat label="Epics" value={activityQ.data.totalEpics} tone="muted" />
        </div>
      )}

      <div className="inline-row wrap-row module-card-links" style={{ marginBottom: '1.5rem' }}>
        <Link to="/tasks/frontier">Open the frontier</Link>
      </div>

      <div className="page-header">
        <div>
          <p className="eyebrow">Epics</p>
          <h2>Current development efforts</h2>
        </div>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : fatal ? (
        <TaskUnavailable error={epicsQ.error} onRetry={epicsQ.refresh} />
      ) : (epicsQ.data?.epics.length ?? 0) === 0 ? (
        <article className="mini-card">
          <p className="subtle-copy">No epics with active tasks. Open a GitHub issue to start one.</p>
        </article>
      ) : (
        <div className="review-grid">
          {epicsQ.data!.epics.map((epic) => (
            <article className="mini-card" key={`${epic.repository}:${epic.issueNumber ?? epic.sha}`}>
              <header>
                <div>
                  <strong>{epic.title}</strong>
                  <p className="subtle-copy">{epic.repository}</p>
                  {epic.issueNumber != null && (
                    <p className="subtle-copy" style={{ marginTop: '0.25rem' }}>
                      <a
                        href={epic.githubUrl ?? githubIssueUrl(epic.issueNumber, epic.githubRepository)}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: '0.875rem' }}
                      >
                        Issue #{epic.issueNumber}
                      </a>
                    </p>
                  )}
                </div>
                <Pill tone={completionTone(epic.completionPct)}>
                  {`${Math.round(epic.completionPct * 100)}%`}
                </Pill>
              </header>

              <div className="stacked-list compact-stack" style={{ marginTop: '0.75rem' }}>
                <Row label="Tasks" value={epic.totalTasks} />
                <Row label="Ready" value={epic.readyCount} />
                <Row label="Active" value={epic.activeCount} />
                {epic.blockedCount > 0 && <Row label="Blocked" value={epic.blockedCount} />}
              </div>

              <div
                className="inline-row wrap-row module-card-links"
                style={{ marginTop: '1rem' }}
              >
                {epic.issueNumber != null && <Link to={`/tasks/${epic.repository}/epic/${epic.issueNumber}`}>View DAG</Link>}
                {epic.issueNumber != null && (
                  <Link to={`/tasks/frontier?repository=${epic.repository}&issue=${epic.issueNumber}`}>Frontier tasks</Link>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'success' | 'warning' | 'danger' | 'muted'
}) {
  return (
    <div className={`task-summary-stat task-summary-stat--${tone}`}>
      <span className="task-summary-value">{value}</span>
      <span className="task-summary-label">{label}</span>
    </div>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="mini-card-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
