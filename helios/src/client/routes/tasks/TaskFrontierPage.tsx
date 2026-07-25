import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Pill } from '../../components/Pill.js'
import {
  fetchTaskJson,
  usePolledData,
  SourceBanner,
  DataStatus,
  TaskLocalNav,
  sourceFromError,
  TaskUnavailable,
  TaskCard,
  type FrontierGroup,
  type FrontierView,
  type TaskNode,
} from './taskShared.js'

const COLLAPSE_KEY = 'helios.tasks.frontier.collapsed.v1'

const STATUS_FILTERS = ['all', 'ready', 'active', 'blocked', 'pending', 'done'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

function parseStatus(raw: string | null): StatusFilter {
  return STATUS_FILTERS.includes(raw as StatusFilter) ? (raw as StatusFilter) : 'all'
}

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {
    /* ignore */
  }
  return new Set()
}

function saveCollapsed(set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]))
  } catch {
    /* ignore */
  }
}

function matchesStatus(task: TaskNode, filter: StatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'ready':
      return task.isReady
    case 'active':
      return task.isActive
    case 'blocked':
      return task.isBlocked
    case 'done':
      return task.status === 'done'
    case 'pending':
      return task.status === 'pending' && !task.isReady
  }
}

export function taskMatchesSearch(task: TaskNode, needle: string): boolean {
  return (
    task.title.toLowerCase().includes(needle) ||
    task.repository.toLowerCase().includes(needle) ||
    task.sha.startsWith(needle) ||
    (task.issueNumber != null && String(task.issueNumber).includes(needle))
  )
}

function groupKeyOf(g: FrontierGroup): string {
  const repository = g.epic?.repository ?? g.tasks[0]?.repository ?? 'unknown'
  return g.epic?.issueNumber != null ? `${repository}:issue:${g.epic.issueNumber}` : `${repository}:${g.epic?.sha ?? 'none'}`
}

function visibleCounts(tasks: TaskNode[]): FrontierGroup['counts'] {
  return {
    total: tasks.length,
    ready: tasks.filter((t) => t.isReady).length,
    active: tasks.filter((t) => t.isActive).length,
    blocked: tasks.filter((t) => t.isBlocked).length,
    done: tasks.filter((t) => t.status === 'done').length,
  }
}

export function TaskFrontierPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const issueFilter = searchParams.get('issue') ?? ''
  const repositoryFilter = searchParams.get('repository') ?? ''
  const statusFilter = parseStatus(searchParams.get('status'))
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed())
  const expandedForFilterRef = useRef<string | null>(null)

  const { data, error, loading, refreshing, refresh } = usePolledData<FrontierView>(
    () => {
      const params = new URLSearchParams()
      if (issueFilter) params.set('issue', issueFilter)
      if (repositoryFilter) params.set('repository', repositoryFilter)
      return fetchTaskJson<FrontierView>(`/api/tasks/frontier?${params.toString()}`)
    },
    [issueFilter, repositoryFilter],
    30_000,
  )

  const filteredGroups = useMemo(() => {
    if (!data) return []
    const needle = search.trim().toLowerCase()
    return data.groups
      .map((g) => {
        const groupMatches =
          !needle ||
          (g.epic?.title?.toLowerCase().includes(needle) ?? false) ||
          (g.epic?.repository.toLowerCase().includes(needle) ?? false) ||
          (g.epic?.issueNumber != null && String(g.epic.issueNumber).includes(needle))
        const tasks = g.tasks.filter((t) => {
          if (statusFilter !== 'all' && !matchesStatus(t, statusFilter)) return false
          if (groupMatches) return true
          return taskMatchesSearch(t, needle)
        })
        return {
          ...g,
          tasks,
          counts: visibleCounts(tasks),
          totalTasks: g.tasks.length,
          waitingCount: tasks.filter((task) => task.status === 'pending' && !task.isReady).length,
        }
      })
      .filter((g) => g.tasks.length > 0)
  }, [data, search, statusFilter])

  const chipCounts = useMemo(() => {
    const all = data?.groups.flatMap((g) => g.tasks) ?? []
    return {
      all: all.length,
      ready: all.filter((t) => t.isReady).length,
      active: all.filter((t) => t.isActive).length,
      blocked: all.filter((t) => t.isBlocked).length,
      pending: all.filter((t) => t.status === 'pending' && !t.isReady).length,
      done: all.filter((t) => t.status === 'done').length,
    }
  }, [data])

  const setStatus = (status: StatusFilter) => {
    const next = new URLSearchParams(searchParams)
    if (status === 'all') next.delete('status')
    else next.set('status', status)
    setSearchParams(next, { replace: true })
  }

  const hasActiveFilters = statusFilter !== 'all' || search.trim() !== '' || issueFilter !== '' || repositoryFilter !== ''
  const filterKey = `${statusFilter}\u0000${search.trim()}\u0000${repositoryFilter}\u0000${issueFilter}`

  useEffect(() => {
    if (!hasActiveFilters) {
      expandedForFilterRef.current = filterKey
      return
    }
    if (filteredGroups.length === 0 || expandedForFilterRef.current === filterKey) return
    expandedForFilterRef.current = filterKey
    setCollapsed((previous) => {
      const next = new Set(previous)
      let changed = false
      for (const group of filteredGroups) {
        changed = next.delete(groupKeyOf(group)) || changed
      }
      if (!changed) return previous
      saveCollapsed(next)
      return next
    })
  }, [filterKey, filteredGroups, hasActiveFilters])

  const clearFilters = () => {
    setSearch('')
    setSearchParams(new URLSearchParams(), { replace: true })
  }

  const toggleGroup = (key: string, open: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (open) next.delete(key)
      else next.add(key)
      saveCollapsed(next)
      return next
    })
  }

  const setAllCollapsed = (collapse: boolean) => {
    const next = collapse ? new Set(filteredGroups.map(groupKeyOf)) : new Set<string>()
    setCollapsed(next)
    saveCollapsed(next)
  }

  const statusOptions: { key: StatusFilter; label: string; count?: number }[] = [
    { key: 'all', label: 'All', count: chipCounts.all },
    { key: 'ready', label: 'Ready', count: chipCounts.ready },
    { key: 'active', label: 'In progress', count: chipCounts.active },
    { key: 'blocked', label: 'Blocked', count: chipCounts.blocked },
    { key: 'pending', label: 'Waiting', count: chipCounts.pending },
    { key: 'done', label: 'Done', count: chipCounts.done },
  ]

  return (
    <section className="task-page" data-helios-capture-target="tasks-queue" data-helios-capture-ready={String(!loading)}>
      <div className="page-header">
        <h2>Task queue</h2>
      </div>
      <TaskLocalNav />

      <SourceBanner source={sourceFromError(error) ?? data?.source} onRefresh={refresh} refreshing={refreshing} />

      {(issueFilter || repositoryFilter) && (
        <p className="task-scope">
          Showing {repositoryFilter || 'all repositories'}{issueFilter ? ` · Issue #${issueFilter}` : ''}.{' '}
          <Link to="/tasks/frontier">Clear scope</Link>
        </p>
      )}

      <div className="task-controls">
        <input
          type="search"
          className="task-search"
          placeholder="Search tasks, issues, or repositories"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search tasks"
        />
        <div className="task-chip-row" role="group" aria-label="Filter tasks by status">
          {statusOptions.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={`task-chip${statusFilter === opt.key ? ' task-chip--active' : ''}`}
              onClick={() => setStatus(opt.key)}
              aria-pressed={statusFilter === opt.key}
            >
              {opt.label}
              {opt.count != null ? ` (${opt.count})` : ''}
            </button>
          ))}
        </div>
        <details className="task-view-options">
          <summary>View options</summary>
          <div className="task-control-actions">
          <button type="button" className="task-link-button" onClick={() => setAllCollapsed(false)}>
            Expand all
          </button>
          <button type="button" className="task-link-button" onClick={() => setAllCollapsed(true)}>
            Collapse all
          </button>
          </div>
        </details>
      </div>

      <p className="task-result-summary" aria-live="polite">
        {filteredGroups.reduce((count, group) => count + group.tasks.length, 0)}{' '}
        {hasActiveFilters ? 'matching ' : ''}tasks across {filteredGroups.length}{' '}
        {filteredGroups.length === 1 ? 'group' : 'groups'}
      </p>

      {loading && !data ? (
        <p>Loading...</p>
      ) : error && !data ? (
        <TaskUnavailable error={error} onRetry={refresh} />
      ) : filteredGroups.length === 0 ? (
        <article className="mini-card">
          {hasActiveFilters ? (
            <>
              <p className="subtle-copy">No tasks match these filters.</p>
              <div className="inline-row wrap-row module-card-links" style={{ marginTop: '0.75rem' }}>
                <button type="button" className="task-link-button" onClick={clearFilters}>
                  Clear filters
                </button>
              </div>
            </>
          ) : (
            <p className="subtle-copy">
              The task queue is empty. No work is ready, in progress, blocked, or waiting.
            </p>
          )}
        </article>
      ) : (
        <div className="task-group-list">
          {filteredGroups.map((group) => {
            const key = groupKeyOf(group)
            const isOpen = !collapsed.has(key)
            return (
              <details
                key={key}
                className="task-group"
                open={isOpen}
                onToggle={(e) => toggleGroup(key, (e.target as HTMLDetailsElement).open)}
              >
                <summary className="task-group-summary">
                  <span className="task-group-title">
                    {group.epic?.title ?? 'Tasks without an issue'}
                    <span className="task-group-context">{group.epic?.repository ?? group.tasks[0]?.repository}
                    {group.epic?.issueNumber != null ? (
                      <> · Issue #{group.epic.issueNumber}</>
                    ) : null}</span>
                  </span>
                  <span className="task-group-counts">
                    {group.counts.ready > 0 && (
                      <Pill tone="success">{`${group.counts.ready} ready`}</Pill>
                    )}
                    {group.counts.active > 0 && (
                      <Pill tone="warning">{`${group.counts.active} in progress`}</Pill>
                    )}
                    {group.counts.blocked > 0 && (
                      <Pill tone="danger">{`${group.counts.blocked} blocked`}</Pill>
                    )}
                    {group.waitingCount > 0 && (
                      <Pill tone="muted">{`${group.waitingCount} waiting`}</Pill>
                    )}
                    <Pill tone="muted">
                      {hasActiveFilters && group.tasks.length !== group.totalTasks
                        ? `${group.tasks.length} shown`
                        : `${group.tasks.length} task${group.tasks.length === 1 ? '' : 's'}`}
                    </Pill>
                  </span>
                </summary>
                <div className="task-group-body">
                  <div className="task-group-links">
                    {group.epic?.issueNumber != null && (
                      <Link to={`/tasks/${group.epic.repository}/epic/${group.epic.issueNumber}`}>Task plan</Link>
                    )}
                    {group.epic?.githubUrl ? (
                      <a href={group.epic.githubUrl} target="_blank" rel="noopener noreferrer">
                        GitHub issue
                      </a>
                    ) : null}
                  </div>
                  {group.tasks.map((task) => (
                    <TaskCard key={`${task.repository}:${task.sha}`} task={task} />
                  ))}
                </div>
              </details>
            )
          })}
        </div>
      )}

      <DataStatus source={sourceFromError(error) ?? data?.source} onRefresh={refresh} refreshing={refreshing} />
    </section>
  )
}
