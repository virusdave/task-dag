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
  repository: 'automation', sha, shortSha: sha, title: sha, status, type, dependencies: [],
  dependents: [], breakdownChildren: [], refs: [], isFrontier: false, isActive: false,
  isBlocked: false, isReady: false, dependenciesMet: true, completedBy: [],
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true
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
    expect(graphStatusKey({ status: 'pending', isReady: true })).toBe('ready')
    expect(graphStatusKey({ status: 'pending', isReady: false })).toBe('waiting')
  })

  it('normalizes URL status values and shares status matching across views', () => {
    expect(parseTaskPlanStatus('blocked')).toBe('blocked')
    expect(parseTaskPlanStatus('bogus')).toBe('all')
    expect(parseTaskPlanStatus(null)).toBe('all')
    expect(taskMatchesPlanStatus({ status: 'pending', isReady: true }, 'ready')).toBe(true)
    expect(taskMatchesPlanStatus({ status: 'pending', isReady: false }, 'waiting')).toBe(true)
    expect(taskMatchesPlanStatus({ status: 'done', isReady: false }, 'blocked')).toBe(false)
    const invalid = canonicalTaskPlanSearch(new URLSearchParams('status=bogus&view=graph'))
    expect(invalid?.toString()).toBe('view=graph')
    expect(canonicalTaskPlanSearch(new URLSearchParams('status=all&view=graph'))?.toString()).toBe('view=graph')
    expect(canonicalTaskPlanSearch(new URLSearchParams('status=blocked&view=graph'))).toBeNull()
  })

  it('excludes structural epic snapshots from tasks, edges, and counts', () => {
    const data = withoutEpicNodes({
      source: { available: true, coverage: 'complete', repositories: [], mode: 'mirror', lastAttemptAtMs: 1, lastSuccessAtMs: 1, lastError: null },
      epic: { repository: 'automation', sha: 'epic', shortSha: 'epic', title: 'Issue' },
      nodes: [node('epic', 'epic', 'pending'), node('ready', 'leaf', 'pending'), node('done', 'task', 'done')],
      edges: [{ source: 'epic', target: 'ready', kind: 'breakdown' }, { source: 'ready', target: 'done', kind: 'dependency' }],
      summary: { totalTasks: 3, statusCounts: { pending: 2, done: 1 } },
    } satisfies DagResult)
    expect(data.nodes.map((item) => item.sha)).toEqual(['ready', 'done'])
    expect(data.edges).toHaveLength(1)
    expect(data.summary).toMatchObject({ totalTasks: 2, statusCounts: { waiting: 1, done: 1 } })
  })

  it('canonicalizes, pushes, and restores status query history without duplicate selections', async () => {
    const data: DagResult = {
      source: { available: true, coverage: 'complete', repositories: [], mode: 'mirror', lastAttemptAtMs: 1, lastSuccessAtMs: 1, lastError: null },
      epic: { repository: 'automation', sha: 'epic', shortSha: 'epic', title: 'Issue #104' },
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
      <MemoryRouter initialEntries={['/tasks/automation/epic/104?status=all&view=graph']}>
        <Routes>
          <Route path="/tasks/:repository/epic/:id" element={<><EpicDagPage /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>,
    ))
    const location = () => host?.querySelector('output[aria-label="location"]')?.textContent
    const button = (label: string) => [...host!.querySelectorAll('button')].find((item) => item.textContent?.includes(label))!
    expect(location()).toBe('/tasks/automation/epic/104?view=graph')
    expect(host.querySelector('[role="group"][aria-label="Filter tasks by status"]')).not.toBeNull()

    await act(async () => button('Blocked').click())
    expect(location()).toContain('status=blocked')
    await act(async () => button('Blocked').click())
    await act(async () => button('Done').click())
    expect(location()).toContain('status=done')
    await act(async () => navigate?.(-1))
    expect(location()).toContain('status=blocked')
    await act(async () => navigate?.(-1))
    expect(location()).toBe('/tasks/automation/epic/104?view=graph')
    await act(async () => navigate?.(1))
    expect(location()).toContain('status=blocked')
  })
})

describe('task queue search', () => {
  it('matches a copied task ID prefix', () => {
    expect(taskMatchesSearch(node('abcdef123456', 'leaf', 'pending'), 'abcdef')).toBe(true)
  })
})
