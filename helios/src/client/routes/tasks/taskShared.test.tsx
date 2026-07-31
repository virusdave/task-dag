// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SourceBanner,
  TaskCard,
  statusLabel,
  taskSourceWarningSignature,
  type TaskDagSourceStatus,
  type TaskNode,
} from './taskShared.js'

const missingA = 'a'.repeat(40)
const missingB = 'b'.repeat(40)
const fullTaskId = `v2-${'c'.repeat(64)}`
const task: TaskNode = {
  repository: 'automation', taskId: fullTaskId, taskOid: '1'.repeat(40), stateOid: '2'.repeat(40),
  state: 'active', title: 'Improve task UX', description: 'Improve task UX',
  lifecycleEvidence: { state: 'active', owner: 'amp-local', claimedAt: 10, expiresAt: 20 },
  status: 'in-progress', type: 'leaf', requirements: ['first', missingB, missingA], dependents: [],
  directChildren: ['child'], isFrontier: false, isActive: true, isBlocked: false,
  isReady: false, dependenciesMet: false, rootTaskId: 'root', epicIssueNumber: 89,
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const degradedSource: TaskDagSourceStatus = {
  available: true,
  coverage: 'partial',
  repositories: [
    { repository: 'automation', available: true, mode: 'mirror', lastError: null },
    { repository: 'task-dag', available: false, mode: 'none', lastError: 'GitHub rejected the Helios App credential.' },
    { repository: 'top-level', available: true, mode: 'mirror', lastError: 'The repository operation timed out.' },
  ],
  mode: 'mirror',
  lastAttemptAtMs: 1,
  lastSuccessAtMs: 1,
  lastError: 'One or more repositories could not be refreshed',
}

describe('task presentation', () => {
  it('uses shared operator-facing status terminology', () => {
    expect(statusLabel({ state: 'frontier', isReady: true })).toBe('Ready')
    expect(statusLabel({ state: 'frontier', isReady: false })).toBe('Waiting')
    expect(statusLabel({ state: 'waiting', isReady: false })).toBe('Waiting')
    expect(statusLabel(task)).toBe('In progress')
  })

  it('shows repository and useful links without command or duplicate claimed controls', () => {
    const html = renderToStaticMarkup(<MemoryRouter><TaskCard task={task} /></MemoryRouter>)
    expect(html).toContain('automation')
    expect(html).toContain('Task plan')
    expect(html).toContain('prerequisite')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('task-disclosure-button')
    expect(html).not.toContain('claim')
    expect(html).not.toContain('scripts/task')
  })

  it('shows every degraded repository, root cause, remediation, and tab dismissal', () => {
    const html = renderToStaticMarkup(<SourceBanner source={degradedSource} />)
    expect(html).toContain('Task repository coverage warning')
    expect(html).toContain('task-dag')
    expect(html).toContain('GitHub rejected the Helios App credential')
    expect(html).toContain('top-level')
    expect(html).toContain('operation timed out')
    expect(html).toContain('GitHub App installation')
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

describe('TaskCard disclosures', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    if (root) act(() => root?.unmount())
    host?.remove()
    host = null
    root = null
    vi.unstubAllGlobals()
  })

  it('uses one tray for status and relationships and restores focus on Escape', async () => {
    const dependency: TaskNode = {
      ...task,
      taskId: 'first',
      title: 'First prerequisite',
      state: 'blocked',
      status: 'blocked',
      isActive: false,
      isBlocked: true,
    }
    const child: TaskNode = {
      ...task,
      taskId: 'child',
      title: 'Child task',
      state: 'frontier',
      status: 'pending',
      requirements: [],
      directChildren: [],
      isActive: false,
      isReady: true,
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      source: degradedSource,
      task,
      parent: null,
      requirements: [dependency],
      dependents: [],
      children: [child],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(<MemoryRouter><TaskCard task={task} /></MemoryRouter>))

    const statusButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'In progress')!
    const prerequisitesButton = [...host.querySelectorAll('button')].find((button) => button.textContent === '3 prerequisites')!
    const subtasksButton = [...host.querySelectorAll('button')].find((button) => button.textContent === '1 subtask')!
    await act(async () => statusButton.click())
    expect(host.querySelectorAll('.task-card-disclosure')).toHaveLength(1)
    expect(host.textContent).toContain('Claimed by amp-local')
    expect(host.textContent).toContain('Claim expires')
    expect(fetch).not.toHaveBeenCalled()

    await act(async () => prerequisitesButton.click())
    expect(host.querySelectorAll('.task-card-disclosure')).toHaveLength(1)
    expect(host.textContent).toContain('First prerequisite')
    expect(host.textContent).toContain('Blocked')
    expect(host.textContent).toContain('Unavailable relationship')
    expect(host.textContent).toContain('Retry unavailable relationships')
    expect(host.textContent).toContain(missingA)
    expect(host.textContent).toContain(missingB)
    expect(host.textContent!.indexOf(missingA)).toBeLessThan(host.textContent!.indexOf(missingB))
    expect(host.querySelector('.task-card-disclosure')?.getAttribute('aria-labelledby')).toBeTruthy()
    expect(fetch).toHaveBeenCalledWith(`/api/tasks/repositories/automation/tasks/${fullTaskId}`)

    await act(async () => subtasksButton.click())
    expect(host.textContent).toContain('Child task')
    expect(host.textContent).toContain('Ready')
    await act(async () => subtasksButton.click())
    expect(host.querySelector('.task-card-disclosure')).toBeNull()

    await act(async () => prerequisitesButton.click())
    prerequisitesButton.focus()
    await act(async () => host?.querySelector('.task-card-disclosure')?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    })))
    expect(host.querySelector('.task-card-disclosure')).toBeNull()
    expect(document.activeElement).toBe(prerequisitesButton)
  })

  it('suppresses stale relationship responses across same-identity polling refreshes', async () => {
    const firstDependency = { ...task, taskId: 'first', title: 'Old title' }
    const freshTask = { ...task }
    const freshDependency = { ...firstDependency, title: 'Fresh title', status: 'done' as const }
    const response = (responseTask: TaskNode, dependency: TaskNode) => new Response(JSON.stringify({
      source: degradedSource,
      task: responseTask,
      parent: null,
      requirements: [dependency],
      dependents: [],
      children: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    let resolveOld!: (value: Response) => void
    let resolveFresh!: (value: Response) => void
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve })
    const freshResponse = new Promise<Response>((resolve) => { resolveFresh = resolve })
    vi.stubGlobal('fetch', vi.fn()
      .mockReturnValueOnce(oldResponse)
      .mockReturnValueOnce(freshResponse))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(<MemoryRouter><TaskCard task={task} /></MemoryRouter>))
    const prerequisites = [...host.querySelectorAll('button')].find((button) => button.textContent === '3 prerequisites')!
    act(() => prerequisites.click())
    expect(host.textContent).toContain('Loading prerequisites')

    await act(async () => root?.render(<MemoryRouter><TaskCard task={freshTask} /></MemoryRouter>))
    expect(host.textContent).not.toContain('Old title')
    expect(host.textContent).toContain('Loading prerequisites')
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => resolveFresh(response(freshTask, freshDependency)))
    expect(host.textContent).toContain('Fresh title')
    await act(async () => resolveOld(response(task, firstDependency)))
    expect(host.textContent).toContain('Fresh title')
    expect(host.textContent).not.toContain('Old title')
  })

  it('retries a failed relationship request inline', async () => {
    const dependency = { ...task, taskId: 'first', title: 'Recovered prerequisite' }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('failure', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        source: degradedSource,
        task,
        parent: null,
        requirements: [dependency],
        dependents: [],
        children: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(<MemoryRouter><TaskCard task={task} /></MemoryRouter>))
    const prerequisites = [...host.querySelectorAll('button')].find((button) => button.textContent === '3 prerequisites')!
    await act(async () => prerequisites.click())
    expect(host.textContent).toContain('Could not load prerequisites')
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!
    await act(async () => retry.click())
    expect(host.textContent).toContain('Recovered prerequisite')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
