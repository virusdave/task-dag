import { describe, expect, it } from 'vitest'
import { graphStatusKey, withoutEpicNodes } from './EpicDagPage.js'
import { taskMatchesSearch } from './TaskFrontierPage.js'
import type { DagResult, TaskNode } from './taskShared.js'

const node = (sha: string, type: TaskNode['type'], status: TaskNode['status']): TaskNode => ({
  repository: 'automation', sha, shortSha: sha, title: sha, status, type, dependencies: [],
  dependents: [], breakdownChildren: [], refs: [], isFrontier: false, isActive: false,
  isBlocked: false, isReady: false, dependenciesMet: true, completedBy: [],
})

describe('task plan', () => {
  it('distinguishes ready nodes from waiting nodes in the graph', () => {
    expect(graphStatusKey({ status: 'pending', isReady: true })).toBe('ready')
    expect(graphStatusKey({ status: 'pending', isReady: false })).toBe('pending')
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
})

describe('task queue search', () => {
  it('matches a copied task ID prefix', () => {
    expect(taskMatchesSearch(node('abcdef123456', 'leaf', 'pending'), 'abcdef')).toBe(true)
  })
})
