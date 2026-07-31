import { Link, useParams } from 'react-router-dom'
import {
  fetchTaskJson,
  usePolledData,
  SourceBanner,
  DataStatus,
  sourceFromError,
  TaskUnavailable,
  StatusBadge,
  CopyButton,
  TaskCard,
  githubIssueUrl,
  type TaskDetail,
  type TaskNode,
} from './taskShared.js'

export function TaskDetailPage() {
  const { taskId = '', repository = '' } = useParams<{ taskId: string; repository: string }>()
  const { data, error, loading, refreshing, refresh } = usePolledData<TaskDetail>(
    () => fetchTaskJson<TaskDetail>(`/api/tasks/repositories/${repository}/tasks/${taskId}`),
    [taskId, repository],
    30_000,
  )

  if (loading && !data) {
    return (
      <section data-helios-capture-target="task-detail" data-helios-capture-ready="false">
        <div className="page-header">
          <h2>Task details</h2>
        </div>
        <p>Loading...</p>
      </section>
    )
  }

  if ((error && !data) || !data) {
    return (
      <section data-helios-capture-target="task-detail" data-helios-capture-ready="true">
        <div className="page-header">
          <h2>Task details</h2>
        </div>
        <SourceBanner source={sourceFromError(error)} onRefresh={refresh} refreshing={refreshing} />
        <TaskUnavailable error={error} onRetry={refresh} />
        <p className="subtle-copy" style={{ marginTop: '1rem' }}>
          <Link to="/tasks/frontier">Back to the task queue</Link>
        </p>
      </section>
    )
  }

  const { task } = data
  return (
    <section className="task-page" data-helios-capture-target="task-detail" data-helios-capture-ready="true">
      <div className="page-header">
        <div>
          <p className="subtle-copy">{task.repository}</p>
          <h2>{task.title}</h2>
          <p className="subtle-copy task-description">{task.description}</p>
          <div className="task-card-badges" style={{ marginTop: '0.5rem' }}>
            <StatusBadge task={task} />
          </div>
        </div>
      </div>

      <SourceBanner source={sourceFromError(error) ?? data.source} onRefresh={refresh} refreshing={refreshing} />

      <div className="inline-row wrap-row module-card-links task-nav-row">
        <Link to="/tasks/frontier">Task queue</Link>
        <Link to={`/tasks/frontier?repository=${task.repository}&rootTaskId=${task.rootTaskId}`}>
          Tasks in this plan
        </Link>
        <Link to={`/tasks/${task.repository}/epic/${task.rootTaskId}`}>Task plan</Link>
        {task.issueNumber != null && (
          <a
            href={task.githubUrl ?? githubIssueUrl(task.issueNumber, task.githubRepository)}
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub issue
          </a>
        )}
      </div>

      <details className="mini-card task-technical-details">
          <summary>Technical details</summary>
          <div className="stacked-list compact-stack" style={{ marginTop: '0.5rem' }}>
            <div className="mini-card-row">
              <span>Task ID</span>
              <span className="inline-row" style={{ gap: '0.5rem' }}>
                <code>{task.taskId}</code>
                <CopyButton value={task.taskId} label="Copy task ID" />
              </span>
            </div>
            {task.issueNumber != null && (
              <div className="mini-card-row">
                <span>Issue</span>
                <a
                  href={task.githubUrl ?? githubIssueUrl(task.issueNumber, task.githubRepository)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  #{task.issueNumber}
                </a>
              </div>
            )}
            {task.author && (
              <div className="mini-card-row">
                <span>Author</span>
                <span>{task.author}</span>
              </div>
            )}
            <div className="mini-card-row">
              <span>Immutable task object</span>
              <span className="inline-row" style={{ gap: '0.5rem' }}>
                <code>{task.taskOid}</code>
                <CopyButton value={task.taskOid} label="Copy task object ID" />
              </span>
            </div>
            <div className="mini-card-row">
              <span>Current state object</span>
              <span className="inline-row" style={{ gap: '0.5rem' }}>
                <code>{task.stateOid}</code>
                <CopyButton value={task.stateOid} label="Copy state object ID" />
              </span>
            </div>
          </div>
      </details>

      <RelatedSection title="Part of" tasks={data.parent ? [data.parent] : []} />
      <RelatedSection
        title="Must finish first"
        tasks={data.requirements}
        showStatusEmoji
      />
      <RelatedSection
        title="Work waiting on this task"
        tasks={data.dependents}
      />
      <RelatedSection
        title="Subtasks"
        tasks={data.children}
      />
      <DataStatus source={sourceFromError(error) ?? data.source} onRefresh={refresh} refreshing={refreshing} />
    </section>
  )
}

function RelatedSection({
  title,
  tasks,
  showStatusEmoji = false,
}: {
  title: string
  tasks: TaskNode[]
  showStatusEmoji?: boolean
}) {
  if (tasks.length === 0) return null
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <h3 className="task-section-title">{title}</h3>
        <div className="task-group-body">
          {tasks.map((t) => (
            <div key={`${t.repository}:${t.taskId}`} className="task-related-row">
              {showStatusEmoji && (
                <span className="task-dep-marker" aria-hidden>
                  {t.status === 'done' ? '✓' : '○'}
                </span>
              )}
              <TaskCard task={t} showEpic />
            </div>
          ))}
        </div>
    </div>
  )
}
