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
  githubCommitUrl,
  githubIssueUrl,
  type TaskDetail,
  type TaskNode,
} from './taskShared.js'

export function TaskDetailPage() {
  const { sha, repository = 'automation' } = useParams<{ sha: string; repository?: string }>()
  const { data, error, loading, refreshing, refresh } = usePolledData<TaskDetail>(
    () => fetchTaskJson<TaskDetail>(`/api/tasks/repositories/${repository}/tasks/${sha}`),
    [sha, repository],
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
          <div className="task-card-badges" style={{ marginTop: '0.5rem' }}>
            <StatusBadge task={task} />
          </div>
        </div>
      </div>

      <SourceBanner source={sourceFromError(error) ?? data.source} onRefresh={refresh} refreshing={refreshing} />

      <div className="inline-row wrap-row module-card-links task-nav-row">
        <Link to="/tasks/frontier">Task queue</Link>
        {task.epicIssueNumber != null && (
          <>
            <Link to={`/tasks/frontier?repository=${task.repository}&issue=${task.epicIssueNumber}`}>
              Tasks for this issue
            </Link>
            <Link to={`/tasks/${task.repository}/epic/${task.epicIssueNumber}`}>Task plan</Link>
          </>
        )}
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
                <code>{task.shortSha}</code>
                <CopyButton value={task.sha} label="Copy task ID" />
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
          </div>
          <strong>References</strong>
          {task.refs.length === 0 ? (
            <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
              No refs currently point at this task.
            </p>
          ) : (
            <ul className="task-ref-list">
              {task.refs.map((ref) => (
                <li key={ref}>
                  <code>{ref}</code>
                </li>
              ))}
            </ul>
          )}
          {task.completedBy.length > 0 && (
            <>
              <p className="subtle-copy" style={{ marginTop: '0.75rem' }}>
                Completed by
              </p>
              <ul className="task-ref-list">
                {task.completedBy.map((c) => (
                  <li key={c}>
                    <a href={githubCommitUrl(c, task.githubRepository)} target="_blank" rel="noopener noreferrer">
                      <code>{c.slice(0, 10)}</code>
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
      </details>

      <RelatedSection title="Part of" tasks={data.parent ? [data.parent] : []} />
      <RelatedSection
        title="Must finish first"
        tasks={data.dependencies}
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
            <div key={`${t.repository}:${t.sha}`} className="task-related-row">
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
