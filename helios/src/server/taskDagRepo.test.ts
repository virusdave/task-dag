import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  getEpicDag,
  getEpics,
  getFrontierView,
  getTaskDetail,
  __resetTaskIndexCacheForTests,
} from './taskDagRepo.js'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

let repoDir: string

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()
}

/** Create an empty-tree task commit, return its full sha. */
function taskCommit(message: string, parents: string[]): string {
  const args = ['commit-tree', EMPTY_TREE]
  for (const p of parents) args.push('-p', p)
  args.push('-m', message)
  return git(args)
}

beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdag-test-'))
  git(['init', '-q', '-b', 'master'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  git(['config', 'commit.gpgsign', 'false'])

  // Real master root commit (non-empty tree).
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# repo\n')
  git(['add', 'README.md'])
  git(['commit', '-q', '-m', 'root'])
  const master0 = git(['rev-parse', 'HEAD'])

  // Epic for issue #100 (header format).
  const epic = taskCommit(
    'Task: Build the thing\n\nIssue: #100\nAuthor: alice\nStatus: pending\nType: epic\nURL: https://github.com/FreshlyBakedNYC/automation/issues/100',
    [master0],
  )
  git(['update-ref', 'refs/heads/tasks/pending/100', epic])

  // Dependency task D (will be completed on master).
  const dep = taskCommit('Task: Prerequisite\n\nIssue: #100\nType: task', [epic])
  git(['update-ref', `refs/heads/tasks/frontier/${dep.slice(0, 7)}`, dep])

  // Leaf L depends on D (first parent = epic breakdown, 2nd = dep). Claimed.
  const leaf = taskCommit('Task: Depends on prereq\n\nIssue: #100\nType: leaf', [epic, dep])
  git(['update-ref', `refs/heads/tasks/frontier/${leaf.slice(0, 7)}`, leaf])

  // Ready leaf R (no deps, frontier).
  const ready = taskCommit('Task: Ready to go\n\nIssue: #100\nType: leaf', [epic])
  git(['update-ref', `refs/heads/tasks/frontier/${ready.slice(0, 7)}`, ready])

  // Blocked leaf B.
  const blocked = taskCommit('Task: Parked\n\nIssue: #100\nType: leaf', [epic])
  git(['update-ref', `refs/heads/tasks/frontier/${blocked.slice(0, 7)}`, blocked])
  git(['update-ref', `refs/heads/tasks/blocked/${blocked}`, blocked])

  // YAML comment-sync frontier task (no header fields).
  const yamlTask = taskCommit(
    [
      'kind: message',
      'role: human',
      'intent: clarification',
      '',
      'issue:',
      '  number: 100',
      '  repo: FreshlyBakedNYC/automation',
      '',
      'github:',
      '  url: https://github.com/FreshlyBakedNYC/automation/issues/100#issuecomment-1',
      '',
      'body: |',
      '  ## Please also handle the edge case',
      '  more detail here',
    ].join('\n'),
    [epic],
  )
  git(['update-ref', `refs/heads/tasks/frontier/${yamlTask.slice(0, 7)}`, yamlTask])

  // Complete D: a real impl commit on master with D as a 2nd parent.
  fs.writeFileSync(path.join(repoDir, 'impl.txt'), 'done\n')
  git(['add', 'impl.txt'])
  const tree = git(['write-tree'])
  const implCommit = git([
    'commit-tree',
    tree,
    '-p',
    master0,
    '-p',
    dep,
    '-m',
    'feat: implement prereq\n\nTask-Commit: ' + dep,
  ])
  git(['update-ref', 'refs/heads/master', implCommit])

  // Active claim on L: claim commit whose FIRST parent is L.
  const claim = taskCommit('claim: leaf', [leaf])
  git(['update-ref', `refs/heads/tasks/active/${leaf.slice(0, 7)}`, claim])

  process.env.AUTOMATION_REPO_PATH = repoDir
  delete process.env.HELIOS_TASK_DAG_LOCAL_DIR
  __resetTaskIndexCacheForTests()
})

afterAll(() => {
  if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true })
})

describe('taskDagRepo indexer', () => {
  it('detects completion via a master 2nd-parent', async () => {
    const detail = await getTaskDetail((await frontierByTitle('Prerequisite')).sha)
    expect(detail?.task.status).toBe('done')
    expect(detail?.task.completedBy.length).toBe(1)
  })

  it('marks an active claim in-progress (resolving claim->task)', async () => {
    const leaf = await nodeByTitle('Depends on prereq')
    expect(leaf.isActive).toBe(true)
    expect(leaf.status).toBe('in-progress')
    expect(leaf.isReady).toBe(false)
  })

  it('marks a blocked overlay as blocked and not ready', async () => {
    const b = await nodeByTitle('Parked')
    expect(b.isBlocked).toBe(true)
    expect(b.status).toBe('blocked')
    expect(b.isReady).toBe(false)
  })

  it('marks a no-dep frontier task ready', async () => {
    const r = await nodeByTitle('Ready to go')
    expect(r.isReady).toBe(true)
    expect(r.dependenciesMet).toBe(true)
  })

  it('computes dependency edges and dependenciesMet', async () => {
    const leaf = await nodeByTitle('Depends on prereq')
    const dep = await nodeByTitle('Prerequisite')
    expect(leaf.dependencies).toContain(dep.sha)
    expect(leaf.dependenciesMet).toBe(true) // dep is done
    expect(dep.dependents).toContain(leaf.sha)
  })

  it('parses YAML comment-sync title + issue number', async () => {
    const y = await nodeByTitle('Please also handle the edge case')
    expect(y.issueNumber).toBe(100)
    expect(y.epicIssueNumber).toBe(100)
  })

  it('groups the frontier by issue with correct counts', async () => {
    const view = await getFrontierView()
    const g = view.groups.find((g) => g.epic?.issueNumber === 100)
    expect(g).toBeTruthy()
    // D (done) + L (active) + R (ready) + B (blocked) + yaml (ready) = 5 frontier
    expect(g!.counts.total).toBe(5)
    expect(g!.counts.ready).toBe(2)
    expect(g!.counts.active).toBe(1)
    expect(g!.counts.blocked).toBe(1)
    expect(g!.counts.done).toBe(1)
  })

  it('builds an epic DAG resolvable by issue number', async () => {
    const dag = await getEpicDag('100')
    expect(dag.epic.issueNumber).toBe(100)
    expect(dag.nodes.length).toBeGreaterThanOrEqual(6) // epic + 5 tasks
    expect(dag.edges.some((e) => e.kind === 'dependency')).toBe(true)
    expect(dag.edges.some((e) => e.kind === 'breakdown')).toBe(true)
  })

  it('aggregates the epic in getEpics by issue', async () => {
    const epics = await getEpics()
    const e = epics.find((e) => e.issueNumber === 100)
    expect(e).toBeTruthy()
    expect(e!.totalTasks).toBe(5)
    expect(e!.completionPct).toBeCloseTo(1 / 5)
  })
})

async function frontierByTitle(substr: string) {
  return nodeByTitle(substr)
}

async function nodeByTitle(substr: string) {
  const view = await getFrontierView()
  for (const g of view.groups) {
    for (const t of g.tasks) {
      if (t.title.includes(substr)) return t
    }
  }
  // Fall back to epic DAG (covers done/non-frontier nodes too).
  const dag = await getEpicDag('100')
  const found = dag.nodes.find((n) => n.title.includes(substr))
  if (!found) throw new Error(`no node titled ~${substr}`)
  return found
}
