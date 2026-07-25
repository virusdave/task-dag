import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { TaskCard, statusLabel, type TaskNode } from './taskShared.js'

const task: TaskNode = {
  repository: 'automation', sha: 'abc123', shortSha: 'abc123', title: 'Improve task UX',
  status: 'in-progress', type: 'leaf', dependencies: ['first'], dependents: [],
  breakdownChildren: [], refs: [], isFrontier: true, isActive: true, isBlocked: false,
  isReady: false, dependenciesMet: false, completedBy: [], epicIssueNumber: 89,
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
})
