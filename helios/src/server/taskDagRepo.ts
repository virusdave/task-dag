/** Bounded task-dag v2 query adapter. Task semantics come only from the canonical CLI. */

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

import { getTaskDagSources, getTaskDagSourceStatus, publicTaskDagError } from './taskDagMirror.js'
import type { TaskDagSourceStatus } from './taskDagMirror.js'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 10_000
const COMMAND_MAX_BUFFER = 2 * 1024 * 1024
const CONCURRENCY = 8
const TASK_ID_PATTERN = /^v2-[0-9a-f]{64}$/
const OID_PATTERN = /^[0-9a-f]{40}$/
const STATES = ['frontier', 'active', 'blocked', 'waiting', 'done'] as const
const ACTIVATION_REF = 'refs/heads/tasks/v2/activation'
const JOURNAL_REF = 'refs/heads/tasks/system/transitions'

export type TaskState = typeof STATES[number]
export type TaskStatus = 'pending' | 'in-progress' | 'blocked' | 'done'
export type TaskType = 'epic' | 'task' | 'leaf'
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export interface LifecycleEvidence {
  state: TaskState
  owner?: string
  claimedAt?: number
  expiresAt?: number
  reason?: string
  blockedAt?: number
  publicationCommit?: string
  completionDescription?: string
  waitingChildCount?: number
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}
const jsonSchema = z.custom<JsonValue>(isJsonValue, 'Expected a JSON value')
const taskIdSchema = z.string().regex(TASK_ID_PATTERN)
const oidSchema = z.string().regex(OID_PATTERN)
const stateSchema = z.enum(STATES)
const taskIdentitySchema = z.object({ taskId: taskIdSchema, taskOid: oidSchema }).strict()
const taskSchema = z.object({
  taskId: taskIdSchema,
  title: z.string(),
  description: z.string(),
  structuralParent: taskIdentitySchema.nullable(),
  requirements: z.array(taskIdentitySchema),
})
const contextSchema = z.object({
  taskId: taskIdSchema,
  taskOid: oidSchema,
  state: stateSchema,
  stateOid: oidSchema,
  structuralParent: taskIdentitySchema.nullable(),
  directRequirements: z.array(taskIdentitySchema),
  directChildren: z.array(taskIdentitySchema),
  task: taskSchema,
}).strict()
const showSchema = z.object({
  taskId: taskIdSchema,
  state: stateSchema,
  ref: z.string(),
  stateOid: oidSchema,
  record: jsonSchema,
}).strict()

export interface TaskNode {
  repository: string
  githubRepository?: string
  taskId: string
  taskOid: string
  stateOid: string
  state: TaskState
  title: string
  description: string
  structuralParent?: string
  requirements: string[]
  directChildren: string[]
  lifecycleEvidence: LifecycleEvidence
  status: TaskStatus
  type: TaskType
  issueNumber?: number
  author?: string
  dependents: string[]
  isFrontier: boolean
  isActive: boolean
  isBlocked: boolean
  isReady: boolean
  dependenciesMet: boolean
  rootTaskId: string
  epicIssueNumber?: number
  epicTitle?: string
  githubUrl?: string
}

export interface TaskEdge { source: string; target: string; kind: 'breakdown' | 'dependency' }
export interface EpicSummary {
  repository: string
  githubRepository?: string
  taskId: string
  taskOid: string
  stateOid: string
  title: string
  issueNumber?: number
  githubUrl?: string
  statusCounts: Record<string, number>
  frontierCount: number
  readyCount: number
  activeCount: number
  blockedCount: number
  waitingCount: number
  completionPct: number
  totalTasks: number
}
export interface EpicsView { source: TaskDagSourceStatus; epics: EpicSummary[] }
export interface DagResult {
  source: TaskDagSourceStatus
  epic: { repository: string; githubRepository?: string; taskId: string; taskOid: string; stateOid: string; issueNumber?: number; title: string; githubUrl?: string }
  nodes: TaskNode[]
  edges: TaskEdge[]
  summary: { totalTasks: number; statusCounts: Record<string, number> }
}
export interface FrontierGroup {
  epic: { repository: string; githubRepository?: string; taskId: string; taskOid: string; stateOid: string; issueNumber?: number; title: string; githubUrl?: string } | null
  counts: { total: number; ready: number; active: number; blocked: number; waiting: number; done: number }
  tasks: TaskNode[]
}
export interface FrontierView {
  source: TaskDagSourceStatus
  summary: { totalFrontier: number; ready: number; active: number; blocked: number; waiting: number; done: number; epicCount: number }
  groups: FrontierGroup[]
}
export interface TaskDetail { source: TaskDagSourceStatus; task: TaskNode; parent: TaskNode | null; requirements: TaskNode[]; dependents: TaskNode[]; children: TaskNode[] }
export interface TaskIndex {
  nodes: Map<string, TaskNode>
  rootTaskIds: string[]
  epicsByIssue: Map<number, string>
  frontierTaskIds: string[]
  fingerprint: string
  builtAtMs: number
}

export class TaskDagUnavailableError extends Error {
  status: TaskDagSourceStatus
  constructor(status: TaskDagSourceStatus) {
    super('Task DAG data source is unavailable')
    this.name = 'TaskDagUnavailableError'
    this.status = status
  }
}
export class TaskDagRepositoryNotFoundError extends Error {
  constructor(repository: string) {
    super(`Task repository not found: ${repository}`)
    this.name = 'TaskDagRepositoryNotFoundError'
  }
}

type CanonicalCommand = 'context' | 'show'
type CanonicalRunner = (
  gitDir: string,
  originUrl: string,
  command: CanonicalCommand,
  taskId: string,
) => Promise<unknown>
let testRunner: CanonicalRunner | undefined
const cachedIndexes = new Map<string, TaskIndex>()

export function __setTaskDagRunnerForTests(runner?: CanonicalRunner): void { testRunner = runner }
export function __resetTaskIndexCacheForTests(): void { cachedIndexes.clear(); testRunner = undefined }

function requireSource(repository: string) {
  const source = getTaskDagSources().find((candidate) => candidate.repository === repository)
  if (!source) throw new TaskDagRepositoryNotFoundError(repository)
  if (!source.gitDir) throw new TaskDagUnavailableError(getTaskDagSourceStatus())
  return { ...source, gitDir: source.gitDir }
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: dir,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
  })
  return stdout.trim()
}

function canonicalBinary(): string {
  const binary = process.env.HELIOS_TASK_DAG_BIN
  if (!binary || !path.isAbsolute(binary)) throw new Error('HELIOS_TASK_DAG_BIN must be an absolute file path')
  let stat: fs.Stats
  try { stat = fs.statSync(binary) } catch { throw new Error('HELIOS_TASK_DAG_BIN must name an existing file') }
  if (!stat.isFile()) throw new Error('HELIOS_TASK_DAG_BIN must name a file')
  try { fs.accessSync(binary, fs.constants.X_OK) } catch { throw new Error('HELIOS_TASK_DAG_BIN must be executable') }
  return binary
}

function localOnlyGitEnvironment(gitDir: string, originUrl: string): NodeJS.ProcessEnv {
  const existing = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10)
  if (!Number.isSafeInteger(existing) || existing < 0) throw new Error('GIT_CONFIG_COUNT must be a non-negative integer')
  return {
    ...process.env,
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(existing + 1),
    [`GIT_CONFIG_KEY_${existing}`]: `url.${gitDir}.insteadOf`,
    [`GIT_CONFIG_VALUE_${existing}`]: originUrl,
  }
}

async function runCanonical(
  gitDir: string,
  originUrl: string,
  command: CanonicalCommand,
  taskId: string,
): Promise<unknown> {
  if (testRunner) return testRunner(gitDir, originUrl, command, taskId)
  const { stdout } = await execFileAsync(canonicalBinary(), [command, taskId], {
    cwd: gitDir,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
    env: localOnlyGitEnvironment(gitDir, originUrl),
  })
  return JSON.parse(stdout)
}

interface LifecycleRef { taskId: string; state: TaskState; ref: string; oid: string }
interface RefCapture { fingerprint: string; lifecycle: LifecycleRef[] }

async function captureRefs(gitDir: string): Promise<RefCapture> {
  const raw = await git(gitDir, ['for-each-ref', '--format=%(refname) %(objectname)',
    'refs/heads/tasks/frontier/', 'refs/heads/tasks/active/', 'refs/heads/tasks/blocked/',
    'refs/heads/tasks/waiting/', 'refs/heads/tasks/done/', ACTIVATION_REF, JOURNAL_REF])
  const relevant = raw ? raw.split('\n').sort() : []
  if (!relevant.some((line) => line.startsWith(`${ACTIVATION_REF} `))) {
    throw new Error('Task repository has no canonical v2 activation ref')
  }
  if (!relevant.some((line) => line.startsWith(`${JOURNAL_REF} `))) {
    throw new Error('Task repository has no canonical v2 transition journal')
  }
  const lifecycle: LifecycleRef[] = []
  const seen = new Map<string, TaskState>()
  for (const line of relevant) {
    const match = line.match(/^refs\/heads\/tasks\/(frontier|active|blocked|waiting|done)\/(v2-[0-9a-f]{64}) ([0-9a-f]{40,64})$/)
    if (!match) continue
    const state = stateSchema.parse(match[1])
    const taskId = taskIdSchema.parse(match[2])
    const prior = seen.get(taskId)
    if (prior) throw new Error(`Task ${taskId} appears in both ${prior} and ${state} lifecycle namespaces`)
    seen.set(taskId, state)
    lifecycle.push({ taskId, state, ref: `refs/heads/tasks/${state}/${taskId}`, oid: match[3] })
  }
  if (lifecycle.length === 0) throw new Error('No grammatical task-dag v2 lifecycle refs found; refusing v1-only repository')
  return { fingerprint: crypto.createHash('sha256').update(relevant.join('\n')).digest('hex'), lifecycle }
}

async function mapBounded<T, R>(values: T[], fn: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor++
      output[index] = await fn(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, values.length) }, () => worker()))
  return output
}

function legacyStatus(state: TaskState): TaskStatus {
  if (state === 'active') return 'in-progress'
  if (state === 'blocked' || state === 'waiting') return 'blocked'
  if (state === 'done') return 'done'
  return 'pending'
}

function lifecycleEvidence(state: TaskState, record: JsonValue): LifecycleEvidence {
  const evidence: LifecycleEvidence = { state }
  if (record === null || Array.isArray(record) || typeof record !== 'object') return evidence
  const stringField = (key: string): string | undefined => typeof record[key] === 'string' ? record[key] : undefined
  const numberField = (key: string): number | undefined => typeof record[key] === 'number' ? record[key] : undefined
  if (state === 'active') {
    evidence.owner = stringField('owner')
    evidence.claimedAt = numberField('claimedAt')
    evidence.expiresAt = numberField('expiresAt')
  } else if (state === 'blocked') {
    evidence.reason = stringField('reason')
    evidence.blockedAt = numberField('blockedAt')
  } else if (state === 'done') {
    evidence.publicationCommit = stringField('publicationCommit')
    evidence.completionDescription = stringField('description')
  } else if (state === 'waiting') {
    evidence.waitingChildCount = Array.isArray(record.children) ? record.children.length : undefined
  }
  return evidence
}

export async function loadTaskIndex(repository: string): Promise<TaskIndex> {
  const source = requireSource(repository)
  const originUrl = await git(source.gitDir, ['remote', 'get-url', 'origin'])
  if (!originUrl) throw new Error(`Task repository ${repository} has no origin URL to isolate`)
  const start = await captureRefs(source.gitDir)
  const cached = cachedIndexes.get(repository)
  if (cached?.fingerprint === start.fingerprint) return cached

  const records = await mapBounded(start.lifecycle, async (lifecycle) => {
    const [contextRaw, showRaw] = await Promise.all([
      runCanonical(source.gitDir, originUrl, 'context', lifecycle.taskId),
      runCanonical(source.gitDir, originUrl, 'show', lifecycle.taskId),
    ])
    const context = contextSchema.parse(contextRaw)
    const show = showSchema.parse(showRaw)
    if (context.taskId !== lifecycle.taskId || context.task.taskId !== lifecycle.taskId || show.taskId !== lifecycle.taskId ||
      context.state !== lifecycle.state || show.state !== lifecycle.state ||
      context.stateOid !== lifecycle.oid || show.stateOid !== lifecycle.oid || show.ref !== lifecycle.ref) {
      throw new Error(`Canonical task-dag output disagrees with lifecycle ref for ${lifecycle.taskId}`)
    }
    if (JSON.stringify(context.structuralParent) !== JSON.stringify(context.task.structuralParent) ||
      JSON.stringify(context.directRequirements) !== JSON.stringify(context.task.requirements)) {
      throw new Error(`Canonical task-dag context disagrees with immutable task relationships for ${lifecycle.taskId}`)
    }
    return { context, show, lifecycle }
  })
  const end = await captureRefs(source.gitDir)
  if (end.fingerprint !== start.fingerprint) throw new Error('Task-dag lifecycle generation changed during read')

  const nodes = new Map<string, TaskNode>()
  for (const { context, show, lifecycle } of records) {
    const structuralParent = context.structuralParent?.taskId
    nodes.set(context.taskId, {
      repository, githubRepository: source.githubRepository,
      taskId: context.taskId, taskOid: context.taskOid, stateOid: context.stateOid, state: context.state,
      title: context.task.title, description: context.task.description, structuralParent,
      requirements: context.directRequirements.map((requirement) => requirement.taskId),
      directChildren: context.directChildren.map((child) => child.taskId),
      lifecycleEvidence: lifecycleEvidence(context.state, show.record),
      status: legacyStatus(context.state),
      type: structuralParent ? (context.directChildren.length ? 'task' : 'leaf') : 'epic',
      dependents: [],
      isFrontier: context.state === 'frontier', isActive: context.state === 'active',
      isBlocked: context.state === 'blocked' || context.state === 'waiting', isReady: false,
      dependenciesMet: false, rootTaskId: context.taskId,
    })
  }
  for (const { context } of records) {
    const checkIdentity = (identity: z.infer<typeof taskIdentitySchema>, relationship: string): TaskNode => {
      const related = nodes.get(identity.taskId)
      if (!related) throw new Error(`Missing ${relationship} ${identity.taskId} for ${context.taskId}`)
      if (related.taskOid !== identity.taskOid) {
        throw new Error(`Immutable identity mismatch for ${relationship} ${identity.taskId}`)
      }
      return related
    }
    if (context.structuralParent) checkIdentity(context.structuralParent, 'structural parent')
    context.directRequirements.forEach((requirement) => checkIdentity(requirement, 'requirement'))
    context.directChildren.forEach((child) => {
      const childNode = checkIdentity(child, 'direct child')
      if (childNode.structuralParent !== context.taskId) {
        throw new Error(`Direct child ${child.taskId} does not name ${context.taskId} as structural parent`)
      }
    })
  }
  for (const node of nodes.values()) {
    for (const requirement of node.requirements) nodes.get(requirement)?.dependents.push(node.taskId)
    node.dependenciesMet = node.requirements.every((id) => nodes.get(id)?.state === 'done')
    node.isReady = node.state === 'frontier' && node.dependenciesMet
    const root = findRoot(node, nodes)
    node.rootTaskId = root.taskId
    node.epicTitle = root.title
  }
  const rootTaskIds = [...nodes.values()].filter((node) => !node.structuralParent).map((node) => node.taskId)
  const index: TaskIndex = {
    nodes, rootTaskIds, epicsByIssue: new Map(),
    frontierTaskIds: [...nodes.values()].filter((node) => node.state === 'frontier').map((node) => node.taskId),
    fingerprint: start.fingerprint, builtAtMs: Date.now(),
  }
  cachedIndexes.set(repository, index)
  return index
}

function findRoot(node: TaskNode, nodes: Map<string, TaskNode>): TaskNode {
  let current = node
  const seen = new Set<string>()
  while (current.structuralParent) {
    if (seen.has(current.taskId)) throw new Error(`Structural parent cycle at ${current.taskId}`)
    seen.add(current.taskId)
    const parent = nodes.get(current.structuralParent)
    if (!parent) throw new Error(`Missing structural parent ${current.structuralParent} for ${current.taskId}`)
    current = parent
  }
  return current
}

export function getSourceStatus(): TaskDagSourceStatus { return getTaskDagSourceStatus() }
function configuredRepositories(repository?: string): string[] {
  const repositories = getTaskDagSources().map((source) => source.repository)
  if (repository && !repositories.includes(repository)) throw new TaskDagRepositoryNotFoundError(repository)
  return repository ? [repository] : repositories
}
function sourceStatusForQueryFailures(failures: ReadonlyMap<string, string>): TaskDagSourceStatus {
  const base = getTaskDagSourceStatus()
  if (!failures.size) return base
  const repositories = base.repositories.map((item) => failures.has(item.repository)
    ? { ...item, available: false, lastError: item.lastError ?? failures.get(item.repository) ?? 'Task data could not be read' }
    : item)
  const available = repositories.filter((item) => item.available).length
  return { ...base, available: available > 0, coverage: available === 0 ? 'unavailable' : available === repositories.length ? 'complete' : 'partial', repositories, lastError: 'One or more repositories could not be read' }
}
async function loadConfiguredTaskIndexes(requested?: string) {
  if (requested) configuredRepositories(requested)
  const repositories = configuredRepositories()
  const results = await Promise.allSettled(repositories.map(loadTaskIndex))
  const indexes = new Map<string, TaskIndex>()
  const failures = new Map<string, string>()
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') indexes.set(repositories[index], result.value)
    else { console.error(`task-dag read failed for ${repositories[index]}`, result.reason); failures.set(repositories[index], publicTaskDagError(result.reason)) }
  })
  const source = sourceStatusForQueryFailures(failures)
  if (!indexes.size || (requested && !indexes.has(requested))) throw new TaskDagUnavailableError(source)
  return { indexes, source }
}

function epicRef(index: TaskIndex, task: TaskNode) {
  const root = index.nodes.get(task.rootTaskId)
  return root ? { repository: root.repository, githubRepository: root.githubRepository, taskId: root.taskId, taskOid: root.taskOid, stateOid: root.stateOid, title: root.title } : null
}
export async function getFrontierView(filter?: { rootTaskId?: string; status?: string; repository?: string }): Promise<FrontierView> {
  const { indexes, source } = await loadConfiguredTaskIndexes(filter?.repository)
  const groups: FrontierGroup[] = []
  for (const index of indexes.values()) {
    const byRoot = new Map<string, TaskNode[]>()
    for (const task of index.nodes.values()) {
      if (filter?.rootTaskId && task.rootTaskId !== filter.rootTaskId) continue
      if (filter?.status && task.status !== filter.status) continue
      const root = task.rootTaskId
      const list = byRoot.get(root)
      if (list) list.push(task); else byRoot.set(root, [task])
    }
    for (const tasks of byRoot.values()) {
      tasks.sort((a, b) => Number(b.isReady) - Number(a.isReady) || a.title.localeCompare(b.title))
      groups.push({ epic: epicRef(index, tasks[0]), counts: {
        total: tasks.length, ready: tasks.filter((task) => task.isReady).length,
        active: tasks.filter((task) => task.state === 'active').length, blocked: tasks.filter((task) => task.state === 'blocked').length,
        waiting: tasks.filter((task) => task.state === 'waiting' || (task.state === 'frontier' && !task.isReady)).length,
        done: tasks.filter((task) => task.state === 'done').length,
      }, tasks })
    }
  }
  groups.sort((a, b) => b.counts.ready - a.counts.ready || (a.epic?.repository ?? '').localeCompare(b.epic?.repository ?? ''))
  const tasks = groups.flatMap((group) => group.tasks)
  return { source, summary: { totalFrontier: tasks.length, ready: tasks.filter((task) => task.isReady).length, active: tasks.filter((task) => task.state === 'active').length, blocked: tasks.filter((task) => task.state === 'blocked').length, waiting: tasks.filter((task) => task.state === 'waiting' || (task.state === 'frontier' && !task.isReady)).length, done: tasks.filter((task) => task.state === 'done').length, epicCount: groups.length }, groups }
}
export async function getFrontier(filter?: { rootTaskId?: string; status?: string; repository?: string }): Promise<TaskNode[]> { return (await getFrontierView(filter)).groups.flatMap((group) => group.tasks) }

function summaries(repository: string, index: TaskIndex): EpicSummary[] {
  return index.rootTaskIds.map((rootId) => {
    const root = index.nodes.get(rootId) as TaskNode
    const members = [...index.nodes.values()].filter((node) => node.rootTaskId === rootId)
    const statusCounts: Record<string, number> = {}
    members.forEach((node) => { statusCounts[node.status] = (statusCounts[node.status] ?? 0) + 1 })
    return { repository, githubRepository: root.githubRepository, taskId: rootId, taskOid: root.taskOid, stateOid: root.stateOid, title: root.title, statusCounts, frontierCount: members.filter((node) => node.state === 'frontier').length, readyCount: members.filter((node) => node.isReady).length, activeCount: members.filter((node) => node.state === 'active').length, blockedCount: members.filter((node) => node.state === 'blocked').length, waitingCount: members.filter((node) => node.state === 'waiting' || (node.state === 'frontier' && !node.isReady)).length, completionPct: members.length ? members.filter((node) => node.state === 'done').length / members.length : 0, totalTasks: members.length }
  })
}
export async function getEpics(): Promise<EpicsView> {
  const { indexes, source } = await loadConfiguredTaskIndexes()
  return { source, epics: [...indexes].flatMap(([repository, index]) => summaries(repository, index)) }
}
export async function getEpicDag(rootId: string, repository: string): Promise<DagResult> {
  const { indexes, source } = await loadConfiguredTaskIndexes(repository)
  const index = indexes.get(repository) as TaskIndex
  const root = index.nodes.get(rootId)
  if (!root || root.structuralParent) throw new Error(`Epic not found: ${rootId}`)
  const nodes = [...index.nodes.values()].filter((node) => node.rootTaskId === rootId)
  const memberIds = new Set(nodes.map((node) => node.taskId))
  const edges: TaskEdge[] = []
  for (const node of nodes) {
    if (node.structuralParent && memberIds.has(node.structuralParent)) edges.push({ source: node.structuralParent, target: node.taskId, kind: 'breakdown' })
    node.requirements.filter((id) => memberIds.has(id)).forEach((id) => edges.push({ source: id, target: node.taskId, kind: 'dependency' }))
  }
  const statusCounts: Record<string, number> = {}
  nodes.forEach((node) => { statusCounts[node.status] = (statusCounts[node.status] ?? 0) + 1 })
  return { source, epic: { repository, githubRepository: root.githubRepository, taskId: root.taskId, taskOid: root.taskOid, stateOid: root.stateOid, title: root.title }, nodes, edges, summary: { totalTasks: nodes.length, statusCounts } }
}
export async function getTaskDetail(taskId: string, repository: string): Promise<TaskDetail | null> {
  const { indexes, source } = await loadConfiguredTaskIndexes(repository)
  const index = indexes.get(repository) as TaskIndex
  const task = index.nodes.get(taskId)
  if (!task) return null
  const lookup = (id: string): TaskNode | null => index.nodes.get(id) ?? null
  return { source, task, parent: task.structuralParent ? lookup(task.structuralParent) : null, requirements: task.requirements.map(lookup).filter((node): node is TaskNode => node !== null), dependents: task.dependents.map(lookup).filter((node): node is TaskNode => node !== null), children: task.directChildren.map(lookup).filter((node): node is TaskNode => node !== null) }
}
export async function getActivity() {
  const view = await getFrontierView(); const epics = await getEpics()
  return { source: view.source, totalEpics: epics.epics.length, totalFrontier: view.summary.totalFrontier, readyTasks: view.summary.ready, activeTasks: view.summary.active, blockedTasks: view.summary.blocked }
}
export async function validateDag(): Promise<{ source: TaskDagSourceStatus; errors: number; warnings: number; valid: boolean }> {
  const { source } = await loadConfiguredTaskIndexes()
  return { source, errors: 0, warnings: 0, valid: true }
}
