import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  getEpicDag,
  getEpics,
  getFrontierView,
  getTaskDetail,
  __resetTaskIndexCacheForTests,
} from './taskDagRepo.js'
import {
  __resetTaskDagMirrorForTests,
  initTaskDagMirror,
  parseTaskDagReposConfig,
  publicTaskDagError,
  taskDagGitEnv,
} from './taskDagMirror.js'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

let repoDir: string
let defaultConfigFile: string
let defaultPathsFile: string

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

  defaultConfigFile = path.join(os.tmpdir(), `taskdag-default-repos-${process.pid}.conf`)
  defaultPathsFile = `${defaultConfigFile}.paths`
  fs.writeFileSync(defaultConfigFile, 'automation git@github.com:Example/automation.git\n')
  fs.writeFileSync(defaultPathsFile, `automation ${repoDir}\n`)
  process.env.HELIOS_TASK_DAG_REPOS_FILE = defaultConfigFile
  process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE = defaultPathsFile
  __resetTaskIndexCacheForTests()
})

afterAll(() => {
  delete process.env.HELIOS_TASK_DAG_REPOS_FILE
  delete process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE
  fs.rmSync(defaultConfigFile, { force: true })
  fs.rmSync(defaultPathsFile, { force: true })
  if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true })
})

describe('taskDagRepo indexer', () => {
  it('detects completion via a master 2nd-parent', async () => {
    const detail = await getTaskDetail((await frontierByTitle('Prerequisite')).sha, 'automation')
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
    const dag = await getEpicDag('100', 'automation')
    expect(dag.epic.issueNumber).toBe(100)
    expect(dag.nodes.length).toBeGreaterThanOrEqual(6) // epic + 5 tasks
    expect(dag.edges.some((e) => e.kind === 'dependency')).toBe(true)
    expect(dag.edges.some((e) => e.kind === 'breakdown')).toBe(true)
  })

  it('aggregates the epic in getEpics by issue', async () => {
    const epics = await getEpics()
    const e = epics.epics.find((e) => e.issueNumber === 100)
    expect(e).toBeTruthy()
    expect(e!.totalTasks).toBe(5)
    expect(e!.completionPct).toBeCloseTo(1 / 5)
  })

  it('keeps identical repository DAGs scoped and reports partial/all failure', async () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdag-second-'))
    fs.rmSync(second, { recursive: true, force: true })
    fs.cpSync(repoDir, second, { recursive: true })
    const configFile = path.join(os.tmpdir(), `taskdag-repos-${process.pid}.conf`)
    const pathsFile = `${configFile}.paths`
    const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdag-mirrors-'))
    const corrupt = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdag-corrupt-'))
    fs.writeFileSync(path.join(corrupt, 'HEAD'), 'ref: refs/heads/master\n')
    fs.mkdirSync(path.join(corrupt, 'objects'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      fs.writeFileSync(configFile, 'automation git@github.com:Example/automation.git\nsecond git@github.com:Example/second.git\ncorrupt git@github.com:Example/corrupt.git\n')
      fs.writeFileSync(pathsFile, `automation ${repoDir}\nsecond ${second}\ncorrupt ${corrupt}\n`)
      process.env.HELIOS_TASK_DAG_REPOS_FILE = configFile
      process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE = pathsFile
      process.env.HELIOS_TASK_DAG_MIRROR_ROOT = mirrorRoot
      __resetTaskDagMirrorForTests()
      __resetTaskIndexCacheForTests()
      const view = await getFrontierView()
      expect(new Set(view.groups.flatMap((group) => group.tasks.map((task) => task.repository))))
        .toEqual(new Set(['automation', 'second']))
      expect(view.source.coverage).toBe('partial')
      expect(view.source.repositories.find((source) => source.repository === 'corrupt')?.available).toBe(false)
      expect(view.source.repositories.find((source) => source.repository === 'corrupt')?.lastError)
        .toBe('The local task mirror is not a readable Git repository or contains corrupt refs.')
      const secondTask = await getTaskDetail((await nodeByTitle('Ready to go')).sha, 'second')
      expect(secondTask?.task.repository).toBe('second')
      expect(secondTask?.source.repositories.find((source) => source.repository === 'corrupt'))
        .toMatchObject({ available: false })
      expect((await getFrontierView({ repository: 'second' })).source.repositories
        .find((source) => source.repository === 'corrupt')).toMatchObject({ available: false })
      expect((await getEpicDag('100', 'second')).source.repositories
        .find((source) => source.repository === 'corrupt')).toMatchObject({ available: false })
      await expect(getTaskDetail('abc', 'corrupt')).rejects.toMatchObject({
        name: 'TaskDagUnavailableError',
        status: {
          repositories: expect.arrayContaining([
            expect.objectContaining({
              repository: 'corrupt',
              available: false,
              lastError: 'The local task mirror is not a readable Git repository or contains corrupt refs.',
            }),
          ]),
        },
      })
      await expect(getTaskDetail('abc', 'unknown')).rejects.toMatchObject({
        name: 'TaskDagRepositoryNotFoundError',
      })

      fs.writeFileSync(configFile, 'one git@github.com:Example/one.git\ntwo git@github.com:Example/two.git\n')
      fs.writeFileSync(pathsFile, 'one /no/one\ntwo /no/two\n')
      __resetTaskDagMirrorForTests()
      __resetTaskIndexCacheForTests()
      await expect(getFrontierView()).rejects.toMatchObject({ name: 'TaskDagUnavailableError' })
    } finally {
      process.env.HELIOS_TASK_DAG_REPOS_FILE = defaultConfigFile
      process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE = defaultPathsFile
      delete process.env.HELIOS_TASK_DAG_MIRROR_ROOT
      __resetTaskDagMirrorForTests()
      __resetTaskIndexCacheForTests()
      errorSpy.mockRestore()
      fs.rmSync(second, { recursive: true, force: true })
      fs.rmSync(configFile, { force: true })
      fs.rmSync(pathsFile, { force: true })
      fs.rmSync(mirrorRoot, { recursive: true, force: true })
      fs.rmSync(corrupt, { recursive: true, force: true })
    }
  })

  it('replaces persisted mirrors with a wrong or missing origin', async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdag-origin-target-'))
    fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(repoDir, target, { recursive: true })
    const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdag-origin-mirrors-'))
    const mirror = path.join(mirrorRoot, 'repo.git')
    const configFile = path.join(mirrorRoot, 'repos.conf')
    execFileSync('git', ['clone', '--mirror', repoDir, mirror], { stdio: 'ignore' })
    fs.writeFileSync(configFile, `repo ${target}\n`)
    try {
      process.env.HELIOS_TASK_DAG_REPOS_FILE = configFile
      delete process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE
      process.env.HELIOS_TASK_DAG_MIRROR_ROOT = mirrorRoot
      __resetTaskDagMirrorForTests()
      await initTaskDagMirror()
      expect(execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: mirror,
        encoding: 'utf8',
      }).trim()).toBe(target)

      execFileSync('git', ['remote', 'remove', 'origin'], { cwd: mirror, stdio: 'ignore' })
      __resetTaskDagMirrorForTests()
      await initTaskDagMirror()
      expect(execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: mirror,
        encoding: 'utf8',
      }).trim()).toBe(target)
    } finally {
      process.env.HELIOS_TASK_DAG_REPOS_FILE = defaultConfigFile
      process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE = defaultPathsFile
      delete process.env.HELIOS_TASK_DAG_MIRROR_ROOT
      __resetTaskDagMirrorForTests()
      fs.rmSync(target, { recursive: true, force: true })
      fs.rmSync(mirrorRoot, { recursive: true, force: true })
    }
  })

  it('rejects malformed, duplicate, unsafe, and empty repository config', () => {
    expect(parseTaskDagReposConfig('repo url enforce master\n')).toEqual([
      { repository: 'repo', repoUrl: 'url' },
    ])
    expect(() => parseTaskDagReposConfig('# only comments\n')).toThrow()
    expect(() => parseTaskDagReposConfig('repo url extra\n')).toThrow(/2 or 4 fields/)
    expect(() => parseTaskDagReposConfig('repo one\nrepo two\n')).toThrow(/Duplicate/)
    expect(() => parseTaskDagReposConfig('../repo url\n')).toThrow(/Invalid repository/)
    expect(() => parseTaskDagReposConfig('repo url broken master\n')).toThrow(/repair mode/)
    expect(() => parseTaskDagReposConfig('repo url enforce foo..bar\n')).toThrow(/repair branch/)
    expect(() => parseTaskDagReposConfig('repo url enforce foo@{bar\n')).toThrow(/repair branch/)
    expect(() => parseTaskDagReposConfig('repo url enforce foo.\n')).toThrow(/repair branch/)
  })

  it('requires an explicit repository registry in every environment', async () => {
    try {
      delete process.env.HELIOS_TASK_DAG_REPOS_FILE
      __resetTaskDagMirrorForTests()
      await expect(initTaskDagMirror()).rejects.toThrow(
        'HELIOS_TASK_DAG_REPOS_FILE is required',
      )
    } finally {
      process.env.HELIOS_TASK_DAG_REPOS_FILE = defaultConfigFile
      process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE = defaultPathsFile
      __resetTaskDagMirrorForTests()
    }
  })

  it('categorizes public diagnostics without exposing secret-bearing process errors', () => {
    const diagnostic = publicTaskDagError(new Error(
      'fatal: https://oauth2:super-secret-token@github.com/acme/private.git?access_token=other-secret: Permission denied (publickey). /var/lib/helios/private',
    ))
    expect(diagnostic).toBe('SSH authentication failed: the repository read key was rejected or is missing.')
    expect(diagnostic).not.toContain('super-secret-token')
    expect(diagnostic).not.toContain('other-secret')
    expect(diagnostic).not.toContain('/var/lib/helios')
  })

  it('defers strict host-key policy to the configured SSH file', () => {
    const previousConfig = process.env.HELIOS_TASK_DAG_SSH_CONFIG
    const previousCommand = process.env.GIT_SSH_COMMAND
    try {
      process.env.HELIOS_TASK_DAG_SSH_CONFIG = '/etc/helios/task-dag-ssh.conf'
      process.env.GIT_SSH_COMMAND = 'ssh -i /tmp/legacy-key'
      const command = taskDagGitEnv().GIT_SSH_COMMAND
      expect(command).toBe('ssh -F /etc/helios/task-dag-ssh.conf -o BatchMode=yes')
      expect(command).not.toContain('StrictHostKeyChecking')
      expect(command).not.toContain('legacy-key')
    } finally {
      if (previousConfig == null) delete process.env.HELIOS_TASK_DAG_SSH_CONFIG
      else process.env.HELIOS_TASK_DAG_SSH_CONFIG = previousConfig
      if (previousCommand == null) delete process.env.GIT_SSH_COMMAND
      else process.env.GIT_SSH_COMMAND = previousCommand
    }
  })

  it('does not derive public repository links from credential-bearing URLs', async () => {
    const configFile = path.join(os.tmpdir(), `taskdag-secret-repos-${process.pid}.conf`)
    const pathsFile = `${configFile}.paths`
    try {
      fs.writeFileSync(configFile, 'secret https://github.com/acme/repo.git?access_token=do-not-leak\n')
      fs.writeFileSync(pathsFile, `secret ${repoDir}\n`)
      process.env.HELIOS_TASK_DAG_REPOS_FILE = configFile
      process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE = pathsFile
      __resetTaskDagMirrorForTests()
      __resetTaskIndexCacheForTests()
      const serialized = JSON.stringify(await getFrontierView())
      expect(serialized).not.toContain('do-not-leak')
      expect(serialized).not.toContain('access_token')
    } finally {
      process.env.HELIOS_TASK_DAG_REPOS_FILE = defaultConfigFile
      process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE = defaultPathsFile
      __resetTaskDagMirrorForTests()
      __resetTaskIndexCacheForTests()
      fs.rmSync(configFile, { force: true })
      fs.rmSync(pathsFile, { force: true })
    }
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
  const dag = await getEpicDag('100', 'automation')
  const found = dag.nodes.find((n) => n.title.includes(substr))
  if (!found) throw new Error(`no node titled ~${substr}`)
  return found
}
