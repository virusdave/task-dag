import { Link } from 'react-router-dom'
import { Pill } from '../../components/Pill.js'
import {
  fetchTaskJson,
  usePolledData,
  SourceBanner,
  DataStatus,
  TaskLocalNav,
  TaskUnavailable,
  sourceFromError,
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
  const refreshing = epicsQ.refreshing || activityQ.refreshing
  const source =
    sourceFromError(activityQ.error) ??
    sourceFromError(epicsQ.error) ??
    activityQ.data?.source ??
    epicsQ.data?.source

  const completionTone = (pct: number): 'success' | 'warning' | 'muted' => {
    if (pct >= 0.8) return 'success'
    if (pct >= 0.4) return 'warning'
    return 'muted'
  }

  return (
    <section className="task-page" data-helios-capture-target="tasks-overview" data-helios-capture-ready={String(!epicsQ.loading && !activityQ.loading)}>
      <div className="page-header">
        <h2>Tasks</h2>
      </div>
      <TaskLocalNav />

      <SourceBanner
        source={source}
        refreshing={refreshing}
        onRefresh={() => {
          epicsQ.refresh()
          activityQ.refresh()
        }}
      />

      {activityQ.data && (
        <div className="task-summary-row">
          <Link to="/tasks/frontier?status=ready"><Stat label="Ready" value={activityQ.data.readyTasks} tone="success" /></Link>
          <Link to="/tasks/frontier?status=active"><Stat label="In progress" value={activityQ.data.activeTasks} tone="warning" /></Link>
          <Link to="/tasks/frontier?status=blocked"><Stat label="Blocked" value={activityQ.data.blockedTasks} tone="danger" /></Link>
        </div>
      )}

      <h3 className="task-section-title">Work by issue</h3>

      {loading ? (
        <p>Loading...</p>
      ) : fatal ? (
        <TaskUnavailable error={epicsQ.error} onRetry={epicsQ.refresh} />
      ) : (epicsQ.data?.epics.length ?? 0) === 0 ? (
        <article className="mini-card">
          <p className="subtle-copy">No active task plans across the available repositories.</p>
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
                <Pill tone={completionTone(epic.completionPct)}>{`${epic.statusCounts.done ?? 0} of ${epic.totalTasks} complete`}</Pill>
              </header>

              <div className="stacked-list compact-stack" style={{ marginTop: '0.75rem' }}>
                {epic.readyCount > 0 && <Row label="Ready" value={epic.readyCount} />}
                {epic.activeCount > 0 && <Row label="In progress" value={epic.activeCount} />}
                {epic.blockedCount > 0 && <Row label="Blocked" value={epic.blockedCount} />}
              </div>

              <div
                className="inline-row wrap-row module-card-links"
                style={{ marginTop: '1rem' }}
              >
                {epic.issueNumber != null && <Link to={`/tasks/${epic.repository}/epic/${epic.issueNumber}`}>View task plan</Link>}
                {epic.issueNumber != null && (
                  <Link to={`/tasks/frontier?repository=${epic.repository}&issue=${epic.issueNumber}${epic.readyCount > 0 ? '&status=ready' : ''}`}>
                    {epic.readyCount > 0
                      ? `View ${epic.readyCount} ready task${epic.readyCount === 1 ? '' : 's'}`
                      : `View ${epic.frontierCount} queued task${epic.frontierCount === 1 ? '' : 's'}`}
                  </Link>
                )}
                {epic.issueNumber != null && <a href={epic.githubUrl ?? githubIssueUrl(epic.issueNumber, epic.githubRepository)} target="_blank" rel="noopener noreferrer">GitHub issue</a>}
              </div>
            </article>
          ))}
        </div>
      )}
      <DataStatus
        source={source}
        onRefresh={() => { epicsQ.refresh(); activityQ.refresh() }}
        refreshing={refreshing}
      />
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
