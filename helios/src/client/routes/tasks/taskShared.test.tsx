import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import {
  SourceBanner,
  TaskCard,
  statusLabel,
  taskSourceWarningSignature,
  type TaskDagSourceStatus,
  type TaskNode,
} from './taskShared.js'

const task: TaskNode = {
  repository: 'automation', sha: 'abc123', shortSha: 'abc123', title: 'Improve task UX',
  status: 'in-progress', type: 'leaf', dependencies: ['first'], dependents: [],
  breakdownChildren: [], refs: [], isFrontier: true, isActive: true, isBlocked: false,
  isReady: false, dependenciesMet: false, completedBy: [], epicIssueNumber: 89,
}

const degradedSource: TaskDagSourceStatus = {
  available: true,
  coverage: 'partial',
  repositories: [
    { repository: 'automation', available: true, mode: 'mirror', lastError: null },
    { repository: 'task-dag', available: false, mode: 'none', lastError: 'SSH authentication failed: the repository read key was rejected or is missing.' },
    { repository: 'top-level', available: true, mode: 'mirror', lastError: 'The repository operation timed out.' },
  ],
  mode: 'mirror',
  lastAttemptAtMs: 1,
  lastSuccessAtMs: 1,
  lastError: 'One or more repositories could not be refreshed',
}

describe('task presentation', () => {
  it('uses shared operator-facing status terminology', () => {
    expect(statusLabel({ status: 'pending', isReady: true })).toBe('Ready')
    expect(statusLabel({ status: 'pending', isReady: false })).toBe('Waiting')
    expect(statusLabel(task)).toBe('In progress')
  })

  it('shows repository and useful links without command or duplicate claimed controls', () => {
    const html = renderToStaticMarkup(<MemoryRouter><TaskCard task={task} /></MemoryRouter>)
    expect(html).toContain('automation')
    expect(html).toContain('Task plan')
    expect(html).toContain('prerequisite')
    expect(html).not.toContain('claim')
    expect(html).not.toContain('scripts/task')
  })

  it('shows every degraded repository, root cause, remediation, and tab dismissal', () => {
    const html = renderToStaticMarkup(<SourceBanner source={degradedSource} />)
    expect(html).toContain('Task repository coverage warning')
    expect(html).toContain('task-dag')
    expect(html).toContain('SSH authentication failed')
    expect(html).toContain('top-level')
    expect(html).toContain('operation timed out')
    expect(html).toContain('HELIOS_TASK_DAG_SSH_CONFIG')
    expect(html).toContain('Helios bug report')
    expect(html).toContain('Hide for this tab')
  })

  it('keys tab dismissal to the affected repositories and root causes', () => {
    const first = taskSourceWarningSignature(degradedSource)
    const reordered = taskSourceWarningSignature({
      ...degradedSource,
      repositories: [...degradedSource.repositories].reverse(),
    })
    const changed = taskSourceWarningSignature({
      ...degradedSource,
      repositories: degradedSource.repositories.map((repository) => repository.repository === 'task-dag'
        ? { ...repository, lastError: 'Host key verification failed' }
        : repository),
    })
    expect(first).toBe(reordered)
    expect(changed).not.toBe(first)
  })
})
