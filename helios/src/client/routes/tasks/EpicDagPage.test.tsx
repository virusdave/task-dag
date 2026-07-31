// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction,
} from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EpicDagPage, canonicalTaskPlanSearch, graphStatusKey, parseTaskPlanStatus, taskMatchesPlanStatus, withoutEpicNodes } from './EpicDagPage.js'
import { taskMatchesSearch } from './TaskFrontierPage.js'
import type { DagResult, TaskNode } from './taskShared.js'

const node = (sha: string, type: TaskNode['type'], status: TaskNode['status']): TaskNode => ({
  repository: 'automation', taskId: sha, taskOid: '1'.repeat(40), stateOid: '2'.repeat(40),
  state: status === 'done' ? 'done' : status === 'blocked' ? 'blocked' : 'frontier',
  title: sha, description: sha, lifecycleRecord: {}, status, type, requirements: [],
  dependents: [], directChildren: [], isFrontier: status === 'pending', isActive: false,
  isBlocked: status === 'blocked', isReady: false, dependenciesMet: true, rootTaskId: 'epic',
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const fullRootTaskId = `v2-${'d'.repeat(64)}`
let navigate: NavigateFunction | null = null

function LocationProbe() {
  const location = useLocation()
  navigate = useNavigate()
  return <output aria-label="location">{`${location.pathname}${location.search}`}</output>
}

let host: HTMLDivElement | null = null
let root: Root | null = null
afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
  navigate = null
  vi.unstubAllGlobals()
})

describe('task plan', () => {
  it('distinguishes ready nodes from waiting nodes in the graph', () => {
    expect(graphStatusKey({ state: 'frontier', isReady: true })).toBe('ready')
    expect(graphStatusKey({ state: 'frontier', isReady: false })).toBe('waiting')
    expect(graphStatusKey({ state: 'waiting', isReady: false })).toBe('waiting')
  })

  it('normalizes URL status values and shares status matching across views', () => {
    expect(parseTaskPlanStatus('blocked')).toBe('blocked')
    expect(parseTaskPlanStatus('bogus')).toBe('all')
    expect(parseTaskPlanStatus(null)).toBe('all')
    expect(taskMatchesPlanStatus({ state: 'frontier', isReady: true }, 'ready')).toBe(true)
    expect(taskMatchesPlanStatus({ state: 'frontier', isReady: false }, 'waiting')).toBe(true)
    expect(taskMatchesPlanStatus({ state: 'done', isReady: false }, 'blocked')).toBe(false)
    const invalid = canonicalTaskPlanSearch(new URLSearchParams('status=bogus&view=graph'))
    expect(invalid?.toString()).toBe('view=graph')
    expect(canonicalTaskPlanSearch(new URLSearchParams('status=all&view=graph'))?.toString()).toBe('view=graph')
    expect(canonicalTaskPlanSearch(new URLSearchParams('status=blocked&view=graph'))).toBeNull()
  })

  it('excludes structural epic snapshots from tasks, edges, and counts', () => {
    const data = withoutEpicNodes({
      source: { available: true, coverage: 'complete', repositories: [], mode: 'mirror', lastAttemptAtMs: 1, lastSuccessAtMs: 1, lastError: null },
      epic: { repository: 'automation', taskId: 'epic', taskOid: '1'.repeat(40), stateOid: '2'.repeat(40), title: 'Issue' },
      nodes: [node('epic', 'epic', 'pending'), node('ready', 'leaf', 'pending'), node('done', 'task', 'done')],
      edges: [{ source: 'epic', target: 'ready', kind: 'breakdown' }, { source: 'ready', target: 'done', kind: 'dependency' }],
      summary: { totalTasks: 3, statusCounts: { pending: 2, done: 1 } },
    } satisfies DagResult)
    expect(data.nodes.map((item) => item.taskId)).toEqual(['ready', 'done'])
    expect(data.edges).toHaveLength(1)
    expect(data.summary).toMatchObject({ totalTasks: 2, statusCounts: { waiting: 1, done: 1 } })
  })

  it('canonicalizes, pushes, and restores status query history without duplicate selections', async () => {
    const data: DagResult = {
      source: { available: true, coverage: 'complete', repositories: [], mode: 'mirror', lastAttemptAtMs: 1, lastSuccessAtMs: 1, lastError: null },
      epic: { repository: 'automation', taskId: fullRootTaskId, taskOid: '1'.repeat(40), stateOid: '2'.repeat(40), title: 'Issue #104' },
      nodes: [node('blocked', 'leaf', 'blocked'), node('done', 'leaf', 'done')],
      edges: [{ source: 'blocked', target: 'done', kind: 'dependency' }],
      summary: { totalTasks: 2, statusCounts: { blocked: 1, done: 1 } },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(
      <MemoryRouter initialEntries={[`/tasks/automation/epic/${fullRootTaskId}?status=all&view=graph`]}>
        <Routes>
          <Route path="/tasks/:repository/epic/:taskId" element={<><EpicDagPage /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>,
    ))
    const location = () => host?.querySelector('output[aria-label="location"]')?.textContent
    const button = (label: string) => [...host!.querySelectorAll('button')].find((item) => item.textContent?.includes(label))!
    expect(location()).toBe(`/tasks/automation/epic/${fullRootTaskId}?view=graph`)
    expect(host.querySelector('[role="group"][aria-label="Filter tasks by status"]')).not.toBeNull()

    await act(async () => button('Blocked').click())
    expect(location()).toContain('status=blocked')
    await act(async () => button('Blocked').click())
    await act(async () => button('Done').click())
    expect(location()).toContain('status=done')
    await act(async () => navigate?.(-1))
    expect(location()).toContain('status=blocked')
    await act(async () => navigate?.(-1))
    expect(location()).toBe(`/tasks/automation/epic/${fullRootTaskId}?view=graph`)
    await act(async () => navigate?.(1))
    expect(location()).toContain('status=blocked')
  })
})

describe('task queue search', () => {
  it('matches a copied task ID prefix', () => {
    expect(taskMatchesSearch(node('abcdef123456', 'leaf', 'pending'), 'abcdef')).toBe(true)
  })
})
