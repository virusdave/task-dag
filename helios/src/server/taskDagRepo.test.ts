import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetTaskIndexCacheForTests,
  __setTaskDagRunnerForTests,
  getEpicDag,
  getFrontierView,
  getTaskDetail,
  loadTaskIndex,
} from './taskDagRepo.js'
import {
  __resetTaskDagMirrorForTests,
  initTaskDagMirror,
  parseTaskDagReposConfig,
  publicTaskDagError,
} from './taskDagMirror.js'
import { registerTaskDagRoutes } from './routes/taskDag.js'

const ids = {
  root: `v2-${'1'.repeat(64)}`,
  done: `v2-${'2'.repeat(64)}`,
  frontier: `v2-${'3'.repeat(64)}`,
  active: `v2-${'4'.repeat(64)}`,
  blocked: `v2-${'5'.repeat(64)}`,
  waiting: `v2-${'6'.repeat(64)}`,
} as const
type FixtureId = typeof ids[keyof typeof ids]
const states = new Map<FixtureId, 'frontier' | 'active' | 'blocked' | 'waiting' | 'done'>([
  [ids.root, 'done'], [ids.done, 'done'], [ids.frontier, 'frontier'], [ids.active, 'active'],
  [ids.blocked, 'blocked'], [ids.waiting, 'waiting'],
])

let repoDir: string
let configFile: string
let pathsFile: string
let headOid: string
let movedOid: string

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}
function installRefs(cwd = repoDir): void {
  for (const [id, state] of states) git(['update-ref', `refs/heads/tasks/${state}/${id}`, headOid], cwd)
  git(['update-ref', 'refs/heads/tasks/v2/activation', headOid], cwd)
  git(['update-ref', 'refs/heads/tasks/system/transitions', headOid], cwd)
}
function fakeRunner() {
  return async (
    _gitDir: string,
    _originUrl: string,
    command: 'activation' | 'context' | 'show',
    taskId?: string,
  ): Promise<unknown> => {
    if (command === 'activation') return {
      activationOid: git(['rev-parse', 'refs/heads/tasks/v2/activation']),
      journalOid: git(['rev-parse', 'refs/heads/tasks/system/transitions']),
      record: { state: 'enabled' },
    }
    if (taskId === undefined) throw new Error(`${command} requires a task ID`)
    const id = taskId as FixtureId
    const state = states.get(id)
    if (!state) throw new Error(`unknown fixture task ${taskId}`)
    const structuralParent = id === ids.root ? null : ids.root
    const requirements = id === ids.frontier ? [ids.done] : id === ids.active ? [ids.blocked] : []
    const children = id === ids.root ? [ids.done, ids.frontier, ids.active, ids.blocked, ids.waiting] : []
    const taskOid = `${String([...states.keys()].indexOf(id) + 7).repeat(40).slice(0, 40)}`
    const identity = (related: FixtureId) => ({
      taskId: related,
      taskOid: `${String([...states.keys()].indexOf(related) + 7).repeat(40).slice(0, 40)}`,
    })
    const parentIdentity = structuralParent ? identity(structuralParent) : null
    const requirementIdentities = requirements.map(identity)
    if (command === 'context') return {
      taskId: id, taskOid, state, stateOid: headOid, structuralParent: parentIdentity,
      directRequirements: requirementIdentities, directChildren: state === 'waiting' ? children.map(identity) : [],
      task: {
        taskId: id, title: `${state} task`, description: `description for ${state}`,
        structuralParent: parentIdentity, requirements: requirementIdentities,
      },
    }
    const record = state === 'active'
      ? { owner: 'amp-local', claimedAt: 10, expiresAt: 20, claimToken: 'must-not-leak' }
      : state === 'blocked'
        ? { reason: 'Operator decision required', blockedAt: 30, authorization: 'private detail' }
        : state === 'done'
          ? { publicationCommit: headOid, description: 'Published implementation' }
          : state === 'waiting'
            ? { children: children.map(identity) }
            : { operationId: 'fixture-frontier' }
    return { taskId: id, state, ref: `refs/heads/tasks/${state}/${id}`, stateOid: headOid, record }
  }
}

beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdag-v2-'))
  git(['init', '-q', '-b', 'master'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  git(['remote', 'add', 'origin', repoDir])
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'fixture\n')
  git(['add', 'README.md'])
  git(['commit', '-q', '-m', 'fixture'])
  headOid = git(['rev-parse', 'HEAD'])
  movedOid = git(['commit-tree', git(['rev-parse', 'HEAD^{tree}']), '-p', headOid, '-m', 'moved generation'])
  installRefs()
  configFile = path.join(repoDir, 'repos.conf')
  pathsFile = path.join(repoDir, 'paths.conf')
  fs.writeFileSync(configFile, 'automation https://github.com/Example/automation.git\n')
  fs.writeFileSync(pathsFile, `automation ${repoDir}\n`)
  process.env.HELIOS_TASK_DAG_REPOS_FILE = configFile
  process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE = pathsFile
})
beforeEach(() => {
  __resetTaskDagMirrorForTests()
  __resetTaskIndexCacheForTests()
  __setTaskDagRunnerForTests(fakeRunner())
})
afterAll(() => {
  delete process.env.HELIOS_TASK_DAG_REPOS_FILE
  delete process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE
  __resetTaskDagMirrorForTests()
  __resetTaskIndexCacheForTests()
  fs.rmSync(repoDir, { recursive: true, force: true })
})

describe('bounded task-dag v2 adapter', () => {
  it('loads all lifecycle states with immutable identity and opaque evidence', async () => {
    const index = await loadTaskIndex('automation')
    expect(new Set([...index.nodes.values()].map((node) => node.state))).toEqual(new Set(['frontier', 'active', 'blocked', 'waiting', 'done']))
    const node = index.nodes.get(ids.frontier)
    expect(node).toMatchObject({ taskId: ids.frontier, stateOid: headOid, description: 'description for frontier' })
    expect(node?.taskOid).toMatch(/^[0-9a-f]{40}$/)
    expect(node?.lifecycleEvidence).toEqual({ state: 'frontier' })
  })

  it('keeps structural parent separate from requirements and derives relationships/readiness', async () => {
    const index = await loadTaskIndex('automation')
    const frontier = index.nodes.get(ids.frontier)
    expect(frontier?.structuralParent).toBe(ids.root)
    expect(frontier?.requirements).toEqual([ids.done])
    expect(frontier?.isReady).toBe(true)
    expect(index.nodes.get(ids.active)?.isReady).toBe(false)
    expect(index.nodes.get(ids.done)?.dependents).toContain(ids.frontier)
    const root = await getTaskDetail(ids.root, 'automation')
    expect(root?.children.map((node) => node.taskId)).toContain(ids.frontier)
    expect(root?.task.type).toBe('epic')
    const plan = await getEpicDag(ids.root, 'automation')
    expect(plan.nodes.map((node) => node.taskId)).not.toContain(ids.root)
    expect(plan.edges).toEqual(expect.arrayContaining([
      { source: ids.done, target: ids.frontier, kind: 'dependency' },
    ]))
  })

  it('rejects one exact task ID in two lifecycle namespaces', async () => {
    git(['update-ref', `refs/heads/tasks/active/${ids.frontier}`, headOid])
    try {
      await expect(loadTaskIndex('automation')).rejects.toThrow(/appears in both/)
    } finally {
      git(['update-ref', '-d', `refs/heads/tasks/active/${ids.frontier}`])
    }
  })

  it('rejects malformed canonical reader output', async () => {
    __setTaskDagRunnerForTests(async (gitDir, originUrl, command, taskId) => {
      const response = await fakeRunner()(gitDir, originUrl, command, taskId)
      return command === 'context' ? { ...(response as object), task: undefined } : response
    })
    await expect(loadTaskIndex('automation')).rejects.toThrow(/expected object/)
  })

  it('rejects canonical activation that does not bind the captured journal', async () => {
    __setTaskDagRunnerForTests(async (gitDir, originUrl, command, taskId) => {
      const response = await fakeRunner()(gitDir, originUrl, command, taskId)
      return command === 'activation' ? { ...(response as object), journalOid: 'a'.repeat(40) } : response
    })
    await expect(loadTaskIndex('automation')).rejects.toThrow(/activation disagrees/)
  })

  it('rejects identity inconsistencies in canonical reader output', async () => {
    __setTaskDagRunnerForTests(async (gitDir, originUrl, command, taskId) => {
      const response = await fakeRunner()(gitDir, originUrl, command, taskId)
      if (command !== 'context' || taskId !== ids.root) return response
      const context = response as Record<string, unknown>
      return {
        ...context,
        taskOid: 'a'.repeat(40),
      }
    })
    await expect(loadTaskIndex('automation')).rejects.toThrow(/identity mismatch/)
  })

  it('refuses a v1-only repository', async () => {
    for (const [id, state] of states) git(['update-ref', '-d', `refs/heads/tasks/${state}/${id}`])
    git(['update-ref', 'refs/heads/tasks/frontier/deadbee', headOid])
    try {
      await expect(loadTaskIndex('automation')).rejects.toThrow(/refusing v1-only/)
    } finally {
      git(['update-ref', '-d', 'refs/heads/tasks/frontier/deadbee'])
      installRefs()
    }
  })

  it('retries generation movement and caches only the stable capture', async () => {
    let moved = false
    __setTaskDagRunnerForTests(async (gitDir, originUrl, command, taskId) => {
      const result = await fakeRunner()(gitDir, originUrl, command, taskId)
      if (!moved) {
        moved = true
        git(['update-ref', 'refs/heads/tasks/system/transitions', movedOid])
      }
      return result
    })
    await expect(loadTaskIndex('automation')).resolves.toMatchObject({ nodes: expect.any(Map) })
    git(['update-ref', 'refs/heads/tasks/system/transitions', headOid])
    __resetTaskIndexCacheForTests()
    __setTaskDagRunnerForTests(fakeRunner())
  })

  it('retries when canonical task output observes a newer lifecycle state', async () => {
    let staleRead = true
    __setTaskDagRunnerForTests(async (gitDir, originUrl, command, taskId) => {
      const result = await fakeRunner()(gitDir, originUrl, command, taskId)
      if (staleRead && command === 'show' && taskId === ids.frontier) {
        staleRead = false
        return { ...(result as object), stateOid: movedOid }
      }
      return result
    })
    await expect(loadTaskIndex('automation')).resolves.toMatchObject({ nodes: expect.any(Map) })
  })

  it('settles the failed generation before starting its retry', async () => {
    let activationCalls = 0
    let driftObserved = false
    let releaseSibling!: () => void
    const blockedSibling = new Promise<void>((resolve) => { releaseSibling = resolve })
    __setTaskDagRunnerForTests(async (gitDir, originUrl, command, taskId) => {
      if (command === 'activation') activationCalls++
      if (activationCalls === 1 && command === 'context' && taskId === ids.active) await blockedSibling
      const result = await fakeRunner()(gitDir, originUrl, command, taskId)
      if (activationCalls === 1 && command === 'show' && taskId === ids.frontier) {
        driftObserved = true
        return { ...(result as object), stateOid: movedOid }
      }
      return result
    })
    const loading = loadTaskIndex('automation')
    await vi.waitFor(() => expect(driftObserved).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(activationCalls).toBe(1)
    releaseSibling()
    await expect(loading).resolves.toMatchObject({ nodes: expect.any(Map) })
    expect(activationCalls).toBeGreaterThan(1)
  })

  it('returns healthy peers when another configured repository fails', async () => {
    const missing = path.join(repoDir, 'missing')
    fs.writeFileSync(configFile, 'automation https://github.com/Example/automation.git\nbroken https://github.com/Example/broken.git\n')
    fs.writeFileSync(pathsFile, `automation ${repoDir}\nbroken ${missing}\n`)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      __resetTaskDagMirrorForTests()
      const view = await getFrontierView()
      expect(view.source.coverage).toBe('partial')
      expect(view.groups.flatMap((group) => group.tasks).every((task) => task.repository === 'automation')).toBe(true)
    } finally {
      errorSpy.mockRestore()
      fs.writeFileSync(configFile, 'automation https://github.com/Example/automation.git\n')
      fs.writeFileSync(pathsFile, `automation ${repoDir}\n`)
    }
  })
})

describe('task-dag v2 API identity', () => {
  it('round-trips a full Task-ID and rejects ambiguous legacy identifiers', async () => {
    const server = Fastify()
    await registerTaskDagRoutes(server)
    try {
      const full = await server.inject({
        method: 'GET',
        url: `/api/tasks/repositories/automation/tasks/${ids.frontier}`,
      })
      expect(full.statusCode).toBe(200)
      expect(full.json().task).toMatchObject({ taskId: ids.frontier, taskOid: expect.any(String), stateOid: headOid })
      expect(full.json().task).not.toHaveProperty('sha')

      const active = await server.inject({
        method: 'GET',
        url: `/api/tasks/repositories/automation/tasks/${ids.active}`,
      })
      expect(active.json().task.lifecycleEvidence).toEqual({
        state: 'active', owner: 'amp-local', claimedAt: 10, expiresAt: 20,
      })
      expect(active.body).not.toContain('must-not-leak')

      const legacy = await server.inject({
        method: 'GET',
        url: '/api/tasks/repositories/automation/tasks/deadbee',
      })
      expect(legacy.statusCode).toBe(400)
      expect(legacy.json()).toEqual({ error: 'A full task-dag v2 Task-ID is required' })
    } finally {
      await server.close()
    }
  })
})

describe('existing mirror configuration behavior', () => {
  it('rejects malformed, duplicate, unsafe, and empty registry entries', () => {
    expect(parseTaskDagReposConfig('repo url enforce master\n')).toEqual([{ repository: 'repo', repoUrl: 'url' }])
    expect(() => parseTaskDagReposConfig('# comments\n')).toThrow()
    expect(() => parseTaskDagReposConfig('repo one\nrepo two\n')).toThrow(/Duplicate/)
    expect(() => parseTaskDagReposConfig('../repo url\n')).toThrow(/Invalid repository/)
  })

  it('requires the explicit registry', async () => {
    delete process.env.HELIOS_TASK_DAG_REPOS_FILE
    try {
      __resetTaskDagMirrorForTests()
      await expect(initTaskDagMirror()).rejects.toThrow('HELIOS_TASK_DAG_REPOS_FILE is required')
    } finally {
      process.env.HELIOS_TASK_DAG_REPOS_FILE = configFile
    }
  })

  it('never falls back from a missing configured checkout to a persisted mirror', async () => {
    const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdag-local-no-fallback-'))
    const mirrorConfig = path.join(mirrorRoot, 'repos.conf')
    const localPaths = path.join(mirrorRoot, 'paths.conf')
    execFileSync('git', ['clone', '--mirror', repoDir, path.join(mirrorRoot, 'repo.git')], { stdio: 'ignore' })
    fs.writeFileSync(mirrorConfig, 'repo https://github.com/Example/repo.git\n')
    fs.writeFileSync(localPaths, 'repo /missing/configured/checkout\n')
    try {
      process.env.HELIOS_TASK_DAG_REPOS_FILE = mirrorConfig
      process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE = localPaths
      process.env.HELIOS_TASK_DAG_MIRROR_ROOT = mirrorRoot
      __resetTaskDagMirrorForTests()
      expect((await initTaskDagMirror()).repositories[0]).toMatchObject({ available: false, mode: 'none' })
    } finally {
      process.env.HELIOS_TASK_DAG_REPOS_FILE = configFile
      process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE = pathsFile
      delete process.env.HELIOS_TASK_DAG_MIRROR_ROOT
      __resetTaskDagMirrorForTests()
      fs.rmSync(mirrorRoot, { recursive: true, force: true })
    }
  })

  it('preserves a valid last-good mirror on auth failure and removes a wrong-origin mirror', async () => {
    const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdag-auth-failure-'))
    const mirror = path.join(mirrorRoot, 'repo.git')
    const authConfig = path.join(mirrorRoot, 'repos.conf')
    execFileSync('git', ['clone', '--mirror', repoDir, mirror], { stdio: 'ignore' })
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/Example/repo.git'], { cwd: mirror })
    fs.writeFileSync(authConfig, 'repo https://github.com/Example/repo.git\n')
    try {
      process.env.HELIOS_TASK_DAG_REPOS_FILE = authConfig
      delete process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE
      process.env.HELIOS_TASK_DAG_MIRROR_ROOT = mirrorRoot
      process.env.HELIOS_GITHUB_APP_CREDENTIAL_DIR = path.join(mirrorRoot, 'credentials')
      delete process.env.HELIOS_GITHUB_APP_ID
      __resetTaskDagMirrorForTests()
      expect((await initTaskDagMirror()).repositories[0]).toMatchObject({ available: true, mode: 'mirror' })
      expect(fs.existsSync(mirror)).toBe(true)

      execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/Example/wrong.git'], { cwd: mirror })
      __resetTaskDagMirrorForTests()
      await initTaskDagMirror()
      expect(fs.existsSync(mirror)).toBe(false)
    } finally {
      process.env.HELIOS_TASK_DAG_REPOS_FILE = configFile
      process.env.HELIOS_TASK_DAG_LOCAL_PATHS_FILE = pathsFile
      delete process.env.HELIOS_TASK_DAG_MIRROR_ROOT
      delete process.env.HELIOS_GITHUB_APP_CREDENTIAL_DIR
      __resetTaskDagMirrorForTests()
      fs.rmSync(mirrorRoot, { recursive: true, force: true })
    }
  })

  it('redacts secret-bearing process diagnostics', () => {
    const diagnostic = publicTaskDagError(new Error('HTTP 403 super-secret-token /var/lib/helios/private'))
    expect(diagnostic).not.toContain('super-secret-token')
    expect(diagnostic).not.toContain('/var/lib/helios')
  })
})
