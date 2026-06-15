import { Link, useParams } from 'react-router-dom'
import { Pill } from '../../components/Pill.js'
import {
  fetchTaskJson,
  usePolledData,
  SourceBanner,
  TaskUnavailable,
  StatusBadge,
  CopyShaButton,
  CopyButton,
  TaskCard,
  nextCommandFor,
  githubCommitUrl,
  githubIssueUrl,
  type TaskDetail,
  type TaskNode,
} from './taskShared.js'

export function TaskDetailPage() {
  const { sha } = useParams<{ sha: string }>()
  const { data, error, loading, refresh } = usePolledData<TaskDetail>(
    () => fetchTaskJson<TaskDetail>(`/api/tasks/task/${sha}`),
    [sha],
    30_000,
  )

  if (loading && !data) {
    return (
      <section>
        <div className="page-header">
          <h2>Task details</h2>
        </div>
        <p>Loading...</p>
      </section>
    )
  }

  if ((error && !data) || !data) {
    return (
      <section>
        <div className="page-header">
          <h2>Task details</h2>
        </div>
        <TaskUnavailable error={error} onRetry={refresh} />
        <p className="subtle-copy" style={{ marginTop: '1rem' }}>
          <Link to="/tasks/frontier">Back to the frontier</Link>
        </p>
      </section>
    )
  }

  const { task } = data
  const nextCmd = nextCommandFor(task)

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Operations · Task</p>
          <h2>{task.title}</h2>
          <div className="task-card-badges" style={{ marginTop: '0.5rem' }}>
            <StatusBadge task={task} />
            <Pill tone="muted">{task.type}</Pill>
            {task.isActive && <Pill tone="warning">claimed</Pill>}
            {task.isBlocked && <Pill tone="danger">blocked</Pill>}
          </div>
        </div>
      </div>

      <SourceBanner source={data.source} onRefresh={refresh} />

      <div className="inline-row wrap-row module-card-links task-nav-row">
        {nextCmd && (
          <CopyButton value={nextCmd.command} label={nextCmd.label} copiedLabel="Copied command" />
        )}
        <Link to="/tasks/frontier">All frontier</Link>
        {task.epicIssueNumber != null && (
          <>
            <Link to={`/tasks/frontier?issue=${task.epicIssueNumber}`}>
              Frontier for issue #{task.epicIssueNumber}
            </Link>
            <Link to={`/tasks/epic/${task.epicIssueNumber}`}>Epic DAG</Link>
          </>
        )}
        {task.issueNumber != null && (
          <a
            href={task.githubUrl ?? githubIssueUrl(task.issueNumber)}
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub issue
          </a>
        )}
      </div>

      <div className="review-grid" style={{ marginBottom: '1.5rem' }}>
        <article className="mini-card">
          <header>
            <strong>Overview</strong>
          </header>
          <div className="stacked-list compact-stack" style={{ marginTop: '0.5rem' }}>
            <div className="mini-card-row">
              <span>SHA</span>
              <span className="inline-row" style={{ gap: '0.5rem' }}>
                <code>{task.shortSha}</code>
                <CopyShaButton sha={task.sha} />
              </span>
            </div>
            {task.issueNumber != null && (
              <div className="mini-card-row">
                <span>Issue</span>
                <a
                  href={task.githubUrl ?? githubIssueUrl(task.issueNumber)}
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
              <span>Dependencies</span>
              <span>
                {task.dependencies.length === 0
                  ? 'none'
                  : `${task.dependencies.length} (${task.dependenciesMet ? 'all met' : 'unmet'})`}
              </span>
            </div>
          </div>
          <div className="inline-row wrap-row module-card-links" style={{ marginTop: '1rem' }}>
            {task.epicIssueNumber != null && (
              <Link to={`/tasks/epic/${task.epicIssueNumber}`}>View epic DAG</Link>
            )}
            {task.githubUrl ? (
              <a href={task.githubUrl} target="_blank" rel="noopener noreferrer">
                Open on GitHub
              </a>
            ) : task.issueNumber != null ? (
              <a href={githubIssueUrl(task.issueNumber)} target="_blank" rel="noopener noreferrer">
                Open issue on GitHub
              </a>
            ) : null}
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Git refs</strong>
          </header>
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
                    <a href={githubCommitUrl(c)} target="_blank" rel="noopener noreferrer">
                      <code>{c.slice(0, 10)}</code>
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </article>
      </div>

      <RelatedSection title="Parent task" tasks={data.parent ? [data.parent] : []} emptyHint="This task has no parent (it is an epic or a root)." />
      <RelatedSection
        title="Dependencies (must complete first)"
        tasks={data.dependencies}
        emptyHint="No upstream dependencies."
        showStatusEmoji
      />
      <RelatedSection
        title="Dependents (waiting on this task)"
        tasks={data.dependents}
        emptyHint="Nothing depends on this task yet."
      />
      <RelatedSection
        title="Subtasks (breakdown children)"
        tasks={data.children}
        emptyHint="No breakdown children."
      />

      <article className="mini-card" style={{ marginTop: '1.5rem' }}>
        <header>
          <strong>task-dag CLI</strong>
        </header>
        <ul className="task-ref-list" style={{ marginTop: '0.5rem' }}>
          <li>
            <code>scripts/task-dag show {task.shortSha}</code>
          </li>
          <li>
            <code>scripts/task-dag deps {task.shortSha} --check-complete</code>
          </li>
          {task.isReady && (
            <li>
              <code>scripts/task-dag claim {task.shortSha}</code>
            </li>
          )}
          {task.isActive && (
            <li>
              <code>scripts/task-dag release {task.shortSha}</code>
            </li>
          )}
          {task.isFrontier && task.status !== 'done' && (
            <li>
              <code>scripts/task-dag complete {task.shortSha}</code>
            </li>
          )}
          {task.isBlocked ? (
            <li>
              <code>scripts/task-dag unblock {task.shortSha}</code>
            </li>
          ) : (
            <li>
              <code>scripts/task-dag block {task.shortSha} --reason="..."</code>
            </li>
          )}
        </ul>
      </article>

      <p className="subtle-copy" style={{ marginTop: '1.5rem' }}>
        <Link to="/tasks/frontier">Back to the frontier</Link>
      </p>
    </section>
  )
}

function RelatedSection({
  title,
  tasks,
  emptyHint,
  showStatusEmoji = false,
}: {
  title: string
  tasks: TaskNode[]
  emptyHint: string
  showStatusEmoji?: boolean
}) {
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <h3 className="task-section-title">{title}</h3>
      {tasks.length === 0 ? (
        <p className="subtle-copy">{emptyHint}</p>
      ) : (
        <div className="task-group-body">
          {tasks.map((t) => (
            <div key={t.sha} className="task-related-row">
              {showStatusEmoji && (
                <span className="task-dep-marker" aria-hidden>
                  {t.status === 'done' ? '✓' : '○'}
                </span>
              )}
              <TaskCard task={t} showEpic />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
