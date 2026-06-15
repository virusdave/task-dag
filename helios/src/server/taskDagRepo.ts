/**
 * Git-DAG Task Management - query layer.
 *
 * Builds an in-memory index of the task DAG by reading git refs +
 * commit graph out of the task-DAG git mirror (see taskDagMirror.ts).
 * The model matches the canonical `task-dag` CLI
 * (virusdave/top-level:scripts/task-dag):
 *
 *   - refs/heads/tasks/pending/<N>          epic per GitHub issue N
 *   - refs/heads/tasks/frontier/<short-sha> pickable leaf task
 *   - refs/heads/tasks/active/<short-sha>   in-flight CLAIM commit; its
 *                                           FIRST parent is the task it claims
 *   - refs/heads/tasks/blocked/<full-sha>   overlay: task is parked
 *   - task commits are empty-tree commits; FIRST parent = breakdown
 *     parent (epic/parent task), 2nd+ parents = dependencies.
 *   - a task is DONE when its sha appears as a non-first parent of a
 *     commit on master (a real impl commit landed with the task commit
 *     as a 2nd parent, trailer `Task-Commit: <sha>`).
 */

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'

import { getTaskDagGitDir, getTaskDagSourceStatus } from './taskDagMirror.js'
import type { TaskDagSourceStatus } from './taskDagMirror.js'

const execFileAsync = promisify(execFile)

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const CACHE_TTL_MS = 30_000

export type TaskStatus = 'pending' | 'in-progress' | 'blocked' | 'done'
export type TaskType = 'epic' | 'task' | 'leaf'

export interface TaskNode {
  sha: string
  shortSha: string
  title: string
  issueNumber?: number
  status: TaskStatus
  type: TaskType
  author?: string
  parentTask?: string
  dependencies: string[]
  dependents: string[]
  breakdownChildren: string[]
  refs: string[]
  isFrontier: boolean
  isActive: boolean
  isBlocked: boolean
  /** Frontier task with all dependencies complete (or no deps). */
  isReady: boolean
  /** All dependencies are complete. */
  dependenciesMet: boolean
  /** Impl commits on master that completed this task. */
  completedBy: string[]
  /** Owning epic (root of the first-parent breakdown chain). */
  epicSha?: string
  epicIssueNumber?: number
  epicTitle?: string
  /** GitHub issue / comment URL if present in metadata. */
  githubUrl?: string
}

export interface TaskEdge {
  source: string
  target: string
  kind: 'breakdown' | 'dependency'
}

export interface EpicSummary {
  issueNumber?: number
  epicRef: string
  sha: string
  shortSha: string
  title: string
  githubUrl?: string
  statusCounts: Record<string, number>
  frontierCount: number
  readyCount: number
  activeCount: number
  blockedCount: number
  completionPct: number
  totalTasks: number
}

export interface DagResult {
  source: TaskDagSourceStatus
  epic: {
    sha: string
    shortSha: string
    issueNumber?: number
    title: string
    githubUrl?: string
  }
  nodes: TaskNode[]
  edges: TaskEdge[]
  summary: {
    totalTasks: number
    statusCounts: Record<string, number>
  }
}

export interface FrontierGroup {
  epic: {
    sha: string
    shortSha: string
    issueNumber?: number
    title: string
    githubUrl?: string
  } | null
  counts: {
    total: number
    ready: number
    active: number
    blocked: number
    done: number
  }
  tasks: TaskNode[]
}

export interface FrontierView {
  source: TaskDagSourceStatus
  summary: {
    totalFrontier: number
    ready: number
    active: number
    blocked: number
    done: number
    epicCount: number
  }
  groups: FrontierGroup[]
}

export interface TaskDetail {
  source: TaskDagSourceStatus
  task: TaskNode
  parent: TaskNode | null
  dependencies: TaskNode[]
  dependents: TaskNode[]
  children: TaskNode[]
}

export interface TaskIndex {
  nodes: Map<string, TaskNode>
  epicShas: string[]
  epicsByIssue: Map<number, string>
  frontierShas: string[]
  fingerprint: string
  builtAtMs: number
}

/** Thrown when no task-DAG git source is currently readable. */
export class TaskDagUnavailableError extends Error {
  status: TaskDagSourceStatus
  constructor(status: TaskDagSourceStatus) {
    super('Task DAG data source is unavailable')
    this.name = 'TaskDagUnavailableError'
    this.status = status
  }
}

let cachedIndex: TaskIndex | null = null

/** Test-only: drop the cached index so a fresh repo is re-read. */
export function __resetTaskIndexCacheForTests(): void {
  cachedIndex = null
}

// --- git helpers -----------------------------------------------------------

function requireGitDir(): string {
  const dir = getTaskDagGitDir()
  if (!dir) {
    throw new TaskDagUnavailableError(getTaskDagSourceStatus())
  }
  return dir
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: dir,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout.trim()
}

interface RawCommit {
  type: string
  tree: string
  parents: string[]
  message: string
}

/**
 * Batch-resolve commit objects via `git cat-file --batch`. Returns a map
 * sha -> parsed commit (or null when missing). One subprocess for the
 * whole set keeps this O(1) in process spawns.
 */
function gitCatBatch(dir: string, shas: string[]): Promise<Map<string, RawCommit | null>> {
  return new Promise((resolve, reject) => {
    const result = new Map<string, RawCommit | null>()
    if (shas.length === 0) {
      resolve(result)
      return
    }
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: dir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => errChunks.push(d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git cat-file exited ${code}: ${Buffer.concat(errChunks).toString()}`))
        return
      }
      try {
        parseCatBatch(Buffer.concat(chunks), result)
        resolve(result)
      } catch (err) {
        reject(err)
      }
    })
    child.stdin.write(shas.join('\n') + '\n')
    child.stdin.end()
  })
}

function parseCatBatch(buf: Buffer, out: Map<string, RawCommit | null>): void {
  let off = 0
  while (off < buf.length) {
    const nl = buf.indexOf(0x0a, off)
    if (nl < 0) break
    const header = buf.toString('utf8', off, nl)
    off = nl + 1
    const parts = header.split(' ')
    const oid = parts[0]
    if (parts[1] === 'missing') {
      out.set(oid, null)
      continue
    }
    const type = parts[1]
    const size = parseInt(parts[2] ?? '0', 10)
    const body = buf.toString('utf8', off, off + size)
    off += size + 1 // skip trailing newline after object content
    if (type !== 'commit') {
      out.set(oid, { type, tree: '', parents: [], message: '' })
      continue
    }
    out.set(oid, parseCommitObject(type, body))
  }
}

function parseCommitObject(type: string, body: string): RawCommit {
  const headerEnd = body.indexOf('\n\n')
  const headerBlock = headerEnd >= 0 ? body.slice(0, headerEnd) : body
  const message = headerEnd >= 0 ? body.slice(headerEnd + 2) : ''
  let tree = ''
  const parents: string[] = []
  for (const line of headerBlock.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim()
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim())
  }
  return { type, tree, parents, message }
}

// --- metadata parsing ------------------------------------------------------

function extractHeaderField(message: string, field: string): string | undefined {
  const m = message.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'))
  return m?.[1]?.trim()
}

/** Extract `key:` then a nested `child:` value from YAML-ish metadata. */
function extractYamlNested(message: string, parent: string, child: string): string | undefined {
  const lines = message.split('\n')
  let inBlock = false
  for (const line of lines) {
    if (new RegExp(`^${parent}:\\s*$`).test(line)) {
      inBlock = true
      continue
    }
    if (inBlock) {
      if (/^[^\s]/.test(line)) inBlock = false
      const m = line.match(new RegExp(`^\\s+${child}:\\s*(.+)$`))
      if (m) return m[1].trim()
    }
  }
  return undefined
}

function parseIssueNumber(message: string): number | undefined {
  const header = extractHeaderField(message, 'Issue')
  if (header) {
    const n = parseInt(header.replace(/^#/, ''), 10)
    if (Number.isFinite(n)) return n
  }
  const yaml = extractYamlNested(message, 'issue', 'number')
  if (yaml) {
    const n = parseInt(yaml.replace(/^#/, ''), 10)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function parseGithubUrl(message: string): string | undefined {
  return (
    extractHeaderField(message, 'URL') ??
    extractYamlNested(message, 'github', 'url') ??
    extractYamlNested(message, 'issue', 'url')
  )
}

function isTaskStatus(v: string | undefined): v is TaskStatus {
  return v === 'pending' || v === 'in-progress' || v === 'blocked' || v === 'done'
}

/**
 * First non-empty line of a YAML `body: |` block scalar (used by the
 * comment-sync `ingest-comment` format), with leading markdown heading /
 * quote markers stripped. Returns undefined when there is no body block.
 */
function extractYamlBodyFirstLine(message: string): string | undefined {
  const lines = message.split('\n')
  let i = lines.findIndex((l) => /^body:\s*\|?\s*$/.test(l))
  if (i < 0) return undefined
  for (i = i + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (!/^\s/.test(line)) break // dedent: body block ended
    return line.replace(/^\s+/, '').replace(/^[#>\s]+/, '').trim() || undefined
  }
  return undefined
}

/** True when this commit message is the YAML comment-sync format. */
function isYamlFormat(message: string): boolean {
  return /^kind:\s*\w+/m.test(message)
}

function detectDeclaredEpic(message: string): boolean {
  return (
    extractHeaderField(message, 'Type') === 'epic' || extractHeaderField(message, 'kind') === 'epic'
  )
}

function parseTitle(message: string, isEpic: boolean): string {
  const first = (message.split('\n')[0] ?? '').trim()

  // Header format: "Task: <title>".
  if (first.startsWith('Task:')) {
    const t = first.replace(/^Task:\s*/, '').trim()
    if (t) return t
  }

  // YAML format: epics carry a clean issue.title; messages put the human
  // text in a body block.
  if (isYamlFormat(message)) {
    if (isEpic) {
      const issueTitle = extractYamlNested(message, 'issue', 'title')
      if (issueTitle) return issueTitle
    }
    const bodyLine = extractYamlBodyFirstLine(message)
    if (bodyLine) return bodyLine
    const intent = extractHeaderField(message, 'intent')
    return intent ? `(${intent})` : 'Untitled task'
  }

  // Plain commit: first non-metadata line.
  if (first && !first.includes(':')) return first
  return first || 'Untitled task'
}

// --- index build -----------------------------------------------------------

async function resolveMasterRef(dir: string): Promise<string | null> {
  for (const ref of ['refs/heads/master', 'refs/remotes/origin/master', 'HEAD']) {
    try {
      await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      return ref
    } catch {
      // try next
    }
  }
  return null
}

/** Map: task sha -> impl commit shas on master that completed it. */
async function buildCompletionMap(dir: string, masterRef: string): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  const out = await git(dir, ['rev-list', '--parents', masterRef])
  for (const line of out.split('\n')) {
    if (!line) continue
    const parts = line.split(' ')
    const commit = parts[0]
    for (let i = 2; i < parts.length; i++) {
      const taskSha = parts[i]
      const arr = map.get(taskSha)
      if (arr) arr.push(commit)
      else map.set(taskSha, [commit])
    }
  }
  return map
}

interface RefSets {
  fingerprint: string
  epicByIssue: Map<number, string>
  epicShas: Set<string>
  epicRefBySha: Map<string, string>
  frontierShas: Set<string>
  activeClaimShas: string[]
  blockedShas: Set<string>
  refsBySha: Map<string, string[]>
}

async function readRefs(dir: string): Promise<RefSets> {
  const raw = await git(dir, [
    'for-each-ref',
    'refs/heads/tasks/',
    '--format=%(objectname) %(refname:short)',
  ])
  const fingerprint = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)

  const epicByIssue = new Map<number, string>()
  const epicShas = new Set<string>()
  const epicRefBySha = new Map<string, string>()
  const frontierShas = new Set<string>()
  const activeClaimShas: string[] = []
  const blockedShas = new Set<string>()
  const refsBySha = new Map<string, string[]>()

  for (const line of raw.split('\n')) {
    if (!line) continue
    const sp = line.indexOf(' ')
    const sha = line.slice(0, sp)
    const ref = line.slice(sp + 1)
    const list = refsBySha.get(sha)
    if (list) list.push(ref)
    else refsBySha.set(sha, [ref])

    if (ref.startsWith('tasks/pending/')) {
      epicShas.add(sha)
      epicRefBySha.set(sha, ref)
      const n = parseInt(ref.slice('tasks/pending/'.length), 10)
      if (Number.isFinite(n)) epicByIssue.set(n, sha)
    } else if (ref.startsWith('tasks/frontier/')) {
      frontierShas.add(sha)
    } else if (ref.startsWith('tasks/active/')) {
      activeClaimShas.push(sha)
    } else if (ref.startsWith('tasks/blocked/')) {
      blockedShas.add(sha)
    }
  }

  return {
    fingerprint,
    epicByIssue,
    epicShas,
    epicRefBySha,
    frontierShas,
    activeClaimShas,
    blockedShas,
    refsBySha,
  }
}

export async function loadTaskIndex(): Promise<TaskIndex> {
  const dir = requireGitDir()
  const refs = await readRefs(dir)
  const masterRef = await resolveMasterRef(dir)
  const masterSha = masterRef ? await git(dir, ['rev-parse', masterRef]) : 'none'
  const fingerprint = `${refs.fingerprint}:${masterSha.slice(0, 12)}`

  if (
    cachedIndex &&
    cachedIndex.fingerprint === fingerprint &&
    Date.now() - cachedIndex.builtAtMs < CACHE_TTL_MS
  ) {
    return cachedIndex
  }

  const completion = masterRef ? await buildCompletionMap(dir, masterRef) : new Map<string, string[]>()

  // Resolve active claim commits -> the task sha they claim (first parent).
  const activeTaskShas = new Set<string>()
  if (refs.activeClaimShas.length > 0) {
    const claims = await gitCatBatch(dir, refs.activeClaimShas)
    for (const claim of claims.values()) {
      if (claim && claim.parents.length > 0) activeTaskShas.add(claim.parents[0])
    }
  }

  // Seed the node closure from every known task root, then walk parents
  // (breakdown + dependency) but only across empty-tree task commits so we
  // never wander into master's real history.
  const seeds = new Set<string>([
    ...refs.epicShas,
    ...refs.frontierShas,
    ...refs.blockedShas,
    ...activeTaskShas,
    ...completion.keys(),
  ])

  const raw = new Map<string, RawCommit>()
  let pending = [...seeds]
  while (pending.length > 0) {
    const batch = await gitCatBatch(dir, pending)
    const next: string[] = []
    for (const [sha, commit] of batch.entries()) {
      if (!commit || commit.type !== 'commit') continue
      if (commit.tree !== EMPTY_TREE) continue // real (impl) commit, not a task
      if (raw.has(sha)) continue
      raw.set(sha, commit)
      for (const p of commit.parents) {
        if (!raw.has(p)) next.push(p)
      }
    }
    pending = next
  }

  // Build nodes.
  const nodes = new Map<string, TaskNode>()
  const epicShas = new Set<string>(refs.epicShas)
  for (const [sha, commit] of raw.entries()) {
    const msg = commit.message
    const parentTask = commit.parents[0]
    const dependencies = commit.parents.slice(1)
    const isFrontier = refs.frontierShas.has(sha)
    const isActive = activeTaskShas.has(sha)
    const isBlocked = refs.blockedShas.has(sha)
    const completedBy = completion.get(sha) ?? []
    // An epic is anything pointed at by tasks/pending/<N> OR declaring
    // itself an epic (Type: epic / kind: epic). Comment-sync epics often
    // have no pending ref, so the declaration is the reliable signal.
    const isEpic = refs.epicShas.has(sha) || detectDeclaredEpic(msg)
    if (isEpic) epicShas.add(sha)
    const type: TaskType = isEpic ? 'epic' : isFrontier ? 'leaf' : 'task'

    let status: TaskStatus
    if (completedBy.length > 0) status = 'done'
    else if (isBlocked) status = 'blocked'
    else if (isActive) status = 'in-progress'
    else {
      const declared = extractHeaderField(msg, 'Status')
      status = isTaskStatus(declared) ? declared : 'pending'
    }

    nodes.set(sha, {
      sha,
      shortSha: sha.slice(0, 7),
      title: parseTitle(msg, isEpic),
      issueNumber: parseIssueNumber(msg),
      status,
      type,
      author: extractHeaderField(msg, 'Author'),
      parentTask,
      dependencies,
      dependents: [],
      breakdownChildren: [],
      refs: refs.refsBySha.get(sha) ?? [],
      isFrontier,
      isActive,
      isBlocked,
      isReady: false,
      dependenciesMet: false,
      completedBy,
      githubUrl: parseGithubUrl(msg),
    })
  }

  // Relationships in one pass.
  const isComplete = (sha: string): boolean => {
    const n = nodes.get(sha)
    if (n) return n.status === 'done'
    return completion.has(sha)
  }
  for (const node of nodes.values()) {
    if (node.parentTask) {
      const parent = nodes.get(node.parentTask)
      if (parent) parent.breakdownChildren.push(node.sha)
    }
    for (const dep of node.dependencies) {
      const depNode = nodes.get(dep)
      if (depNode) depNode.dependents.push(node.sha)
    }
    node.dependenciesMet = node.dependencies.every(isComplete)
    node.isReady =
      node.isFrontier &&
      !node.isBlocked &&
      !node.isActive &&
      node.status !== 'done' &&
      node.dependenciesMet
  }

  // Epic inheritance: walk the first-parent breakdown chain to the epic.
  for (const node of nodes.values()) {
    const epic = findEpic(node, nodes, epicShas)
    if (epic) {
      node.epicSha = epic.sha
      node.epicIssueNumber = epic.issueNumber
      node.epicTitle = epic.title
      if (!node.issueNumber) node.issueNumber = epic.issueNumber
      if (!node.githubUrl && epic.githubUrl) node.githubUrl = epic.githubUrl
    }
  }

  // Build the issue -> epic map from every epic-typed node, preferring the
  // one carrying a pending ref when an issue has more than one candidate.
  const epicsByIssue = new Map<number, string>(refs.epicByIssue)
  for (const sha of epicShas) {
    const node = nodes.get(sha)
    if (!node || node.issueNumber == null) continue
    if (!epicsByIssue.has(node.issueNumber)) epicsByIssue.set(node.issueNumber, sha)
  }

  const index: TaskIndex = {
    nodes,
    epicShas: [...epicShas].filter((s) => nodes.has(s)),
    epicsByIssue,
    frontierShas: [...refs.frontierShas].filter((s) => nodes.has(s)),
    fingerprint,
    builtAtMs: Date.now(),
  }
  cachedIndex = index
  return index
}

function findEpic(
  node: TaskNode,
  nodes: Map<string, TaskNode>,
  epicShas: Set<string>,
): TaskNode | null {
  let current: TaskNode | undefined = node
  const seen = new Set<string>()
  while (current && !seen.has(current.sha)) {
    seen.add(current.sha)
    if (epicShas.has(current.sha)) return current
    current = current.parentTask ? nodes.get(current.parentTask) : undefined
  }
  return null
}

// --- public query API ------------------------------------------------------

export function getSourceStatus(): TaskDagSourceStatus {
  return getTaskDagSourceStatus()
}

export async function getFrontierView(filter?: {
  issue?: number
  status?: string
}): Promise<FrontierView> {
  const index = await loadTaskIndex()
  const source = getTaskDagSourceStatus()

  const frontier: TaskNode[] = []
  for (const sha of index.frontierShas) {
    const node = index.nodes.get(sha)
    if (!node) continue
    if (filter?.issue && node.issueNumber !== filter.issue) continue
    if (filter?.status && node.status !== filter.status) continue
    frontier.push(node)
  }

  const groupsByEpic = new Map<string, FrontierGroup>()
  for (const task of frontier) {
    const key = groupKey(task)
    let group = groupsByEpic.get(key)
    if (!group) {
      group = {
        epic: epicRefOf(index, task),
        counts: { total: 0, ready: 0, active: 0, blocked: 0, done: 0 },
        tasks: [],
      }
      groupsByEpic.set(key, group)
    }
    group.tasks.push(task)
    group.counts.total++
    if (task.isReady) group.counts.ready++
    if (task.isActive) group.counts.active++
    if (task.isBlocked) group.counts.blocked++
    if (task.status === 'done') group.counts.done++
  }

  for (const group of groupsByEpic.values()) {
    group.tasks.sort((a, b) => taskSortRank(a) - taskSortRank(b) || a.title.localeCompare(b.title))
  }

  const groups = [...groupsByEpic.values()].sort((a, b) => {
    // Most actionable epics first (more ready tasks), then by issue number.
    if (b.counts.ready !== a.counts.ready) return b.counts.ready - a.counts.ready
    return (a.epic?.issueNumber ?? 1e9) - (b.epic?.issueNumber ?? 1e9)
  })

  const summary = {
    totalFrontier: frontier.length,
    ready: frontier.filter((t) => t.isReady).length,
    active: frontier.filter((t) => t.isActive).length,
    blocked: frontier.filter((t) => t.isBlocked).length,
    done: frontier.filter((t) => t.status === 'done').length,
    epicCount: groups.filter((g) => g.epic).length,
  }

  return { source, summary, groups }
}

function taskSortRank(t: TaskNode): number {
  if (t.isReady) return 0
  if (t.isActive) return 1
  if (t.status === 'pending') return 2
  if (t.isBlocked) return 3
  if (t.status === 'done') return 5
  return 4
}

type EpicRef = FrontierGroup['epic']

/**
 * Stable grouping key. Tasks are grouped by their owning GitHub issue,
 * NOT by the specific epic commit, because the comment-sync mints a fresh
 * `kind: epic` snapshot commit per sync run, so one issue has many epic
 * commits over time.
 */
function groupKey(t: TaskNode): string {
  if (t.epicIssueNumber != null) return `issue:${t.epicIssueNumber}`
  if (t.epicSha) return `epic:${t.epicSha}`
  return 'none'
}

function epicRefOf(index: TaskIndex, t: TaskNode): EpicRef {
  if (t.epicIssueNumber != null) {
    const sha = index.epicsByIssue.get(t.epicIssueNumber)
    const node = sha ? index.nodes.get(sha) : undefined
    return {
      sha: node?.sha ?? t.epicSha ?? '',
      shortSha: (node?.sha ?? t.epicSha ?? '').slice(0, 7),
      issueNumber: t.epicIssueNumber,
      title: node?.title ?? t.epicTitle ?? `Issue #${t.epicIssueNumber}`,
      githubUrl: node?.githubUrl ?? t.githubUrl,
    }
  }
  if (t.epicSha) {
    const node = index.nodes.get(t.epicSha)
    if (node) {
      return {
        sha: node.sha,
        shortSha: node.shortSha,
        issueNumber: node.issueNumber,
        title: node.title,
        githubUrl: node.githubUrl,
      }
    }
  }
  return null
}

export async function getFrontier(filter?: {
  issue?: number
  status?: string
}): Promise<TaskNode[]> {
  const view = await getFrontierView(filter)
  return view.groups.flatMap((g) => g.tasks)
}

export async function getEpics(): Promise<EpicSummary[]> {
  const index = await loadTaskIndex()

  // Aggregate by GitHub issue (one issue may have many epic snapshot
  // commits). Members are the non-epic task nodes belonging to the issue.
  const membersByIssue = new Map<number, TaskNode[]>()
  for (const node of index.nodes.values()) {
    if (node.type === 'epic') continue
    if (node.epicIssueNumber == null) continue
    const arr = membersByIssue.get(node.epicIssueNumber)
    if (arr) arr.push(node)
    else membersByIssue.set(node.epicIssueNumber, [node])
  }

  const epics: EpicSummary[] = []
  for (const [issue, epicSha] of index.epicsByIssue.entries()) {
    const epicNode = index.nodes.get(epicSha)
    const members = membersByIssue.get(issue) ?? []
    const hasPendingRef = epicNode?.refs.some((r) => r.startsWith('tasks/pending/')) ?? false
    // Skip stale epic snapshots for closed issues with no live work.
    if (members.length === 0 && !hasPendingRef) continue

    const statusCounts: Record<string, number> = {}
    let frontierCount = 0
    let readyCount = 0
    let activeCount = 0
    let blockedCount = 0
    for (const n of members) {
      statusCounts[n.status] = (statusCounts[n.status] ?? 0) + 1
      if (n.isFrontier) frontierCount++
      if (n.isReady) readyCount++
      if (n.isActive) activeCount++
      if (n.isBlocked) blockedCount++
    }

    const totalTasks = members.length
    const doneTasks = statusCounts['done'] ?? 0
    epics.push({
      issueNumber: issue,
      epicRef: epicNode?.refs.find((r) => r.startsWith('tasks/pending/')) ?? '',
      sha: epicSha,
      shortSha: epicSha.slice(0, 7),
      title: epicNode?.title ?? `Issue #${issue}`,
      githubUrl: epicNode?.githubUrl,
      statusCounts,
      frontierCount,
      readyCount,
      activeCount,
      blockedCount,
      completionPct: totalTasks > 0 ? doneTasks / totalTasks : 0,
      totalTasks,
    })
  }

  epics.sort((a, b) => {
    if (b.readyCount !== a.readyCount) return b.readyCount - a.readyCount
    if (b.frontierCount !== a.frontierCount) return b.frontierCount - a.frontierCount
    return (a.issueNumber ?? 1e9) - (b.issueNumber ?? 1e9)
  })
  return epics
}

export async function getEpicDag(epicRefOrSha: string): Promise<DagResult> {
  const index = await loadTaskIndex()
  const source = getTaskDagSourceStatus()

  // Resolve to an issue number when possible (the canonical epic identity),
  // else to a specific epic commit sha.
  let issueNumber: number | undefined
  let epicSha: string | undefined
  if (/^\d+$/.test(epicRefOrSha)) {
    issueNumber = parseInt(epicRefOrSha, 10)
    epicSha = index.epicsByIssue.get(issueNumber)
  }
  if (!epicSha) {
    const dir = requireGitDir()
    try {
      epicSha = await git(dir, ['rev-parse', epicRefOrSha])
    } catch {
      epicSha = epicRefOrSha
    }
    const resolved = epicSha ? index.nodes.get(epicSha) : undefined
    if (resolved?.issueNumber != null) issueNumber = resolved.issueNumber
  }

  const epicNode = epicSha ? index.nodes.get(epicSha) : undefined
  if (!epicNode && issueNumber == null) {
    throw new Error(`Epic not found: ${epicRefOrSha}`)
  }

  // Collect the member set. When we have an issue number, take ALL task
  // nodes belonging to that issue (across epic snapshots); else BFS from
  // the single epic commit.
  const nodes: TaskNode[] = []
  const edges: TaskEdge[] = []
  const memberSet = new Set<string>()
  if (issueNumber != null) {
    for (const node of index.nodes.values()) {
      if (node.type === 'epic' && node.issueNumber !== issueNumber) continue
      if (node.type !== 'epic' && node.epicIssueNumber !== issueNumber) continue
      memberSet.add(node.sha)
    }
  } else if (epicSha) {
    const queue = [epicSha]
    while (queue.length > 0) {
      const cur = queue.shift() as string
      if (memberSet.has(cur)) continue
      const node = index.nodes.get(cur)
      if (!node) continue
      memberSet.add(cur)
      queue.push(...node.breakdownChildren)
    }
  }

  for (const sha of memberSet) {
    const node = index.nodes.get(sha)
    if (!node) continue
    nodes.push(node)
    if (node.parentTask && memberSet.has(node.parentTask)) {
      edges.push({ source: node.parentTask, target: sha, kind: 'breakdown' })
    }
    for (const dep of node.dependencies) {
      if (memberSet.has(dep)) edges.push({ source: dep, target: sha, kind: 'dependency' })
    }
  }

  const statusCounts: Record<string, number> = {}
  for (const n of nodes) statusCounts[n.status] = (statusCounts[n.status] ?? 0) + 1

  return {
    source,
    epic: {
      sha: epicNode?.sha ?? epicSha ?? '',
      shortSha: (epicNode?.sha ?? epicSha ?? '').slice(0, 7),
      issueNumber: epicNode?.issueNumber ?? issueNumber,
      title: epicNode?.title ?? (issueNumber != null ? `Issue #${issueNumber}` : 'Epic'),
      githubUrl: epicNode?.githubUrl,
    },
    nodes,
    edges,
    summary: { totalTasks: nodes.length, statusCounts },
  }
}

export async function getTaskDetail(shaOrRef: string): Promise<TaskDetail | null> {
  const index = await loadTaskIndex()
  const source = getTaskDagSourceStatus()

  let task = index.nodes.get(shaOrRef)
  if (!task) {
    // Allow short-sha / ref lookups.
    const dir = requireGitDir()
    try {
      const full = await git(dir, ['rev-parse', shaOrRef])
      task = index.nodes.get(full)
    } catch {
      // fall through
    }
  }
  if (!task) return null

  const lookup = (sha: string): TaskNode | null => index.nodes.get(sha) ?? null
  return {
    source,
    task,
    parent: task.parentTask ? lookup(task.parentTask) : null,
    dependencies: task.dependencies.map(lookup).filter((n): n is TaskNode => n != null),
    dependents: task.dependents.map(lookup).filter((n): n is TaskNode => n != null),
    children: task.breakdownChildren.map(lookup).filter((n): n is TaskNode => n != null),
  }
}

export async function getActivity(): Promise<{
  source: TaskDagSourceStatus
  totalEpics: number
  totalFrontier: number
  readyTasks: number
  activeTasks: number
  blockedTasks: number
}> {
  const view = await getFrontierView()
  const epics = await getEpics()
  return {
    source: view.source,
    totalEpics: epics.length,
    totalFrontier: view.summary.totalFrontier,
    readyTasks: view.summary.ready,
    activeTasks: view.summary.active,
    blockedTasks: view.summary.blocked,
  }
}

export async function validateDag(): Promise<{
  source: TaskDagSourceStatus
  errors: number
  warnings: number
  valid: boolean
}> {
  const index = await loadTaskIndex()
  const source = getTaskDagSourceStatus()
  let errors = 0
  let warnings = 0
  for (const node of index.nodes.values()) {
    // Frontier refs should point at task/leaf nodes.
    if (node.isFrontier && node.type === 'epic') warnings++
    // A dependency that isn't a known node and isn't completed is suspect.
    for (const dep of node.dependencies) {
      if (!index.nodes.has(dep)) warnings++
    }
  }
  return { source, errors, warnings, valid: errors === 0 }
}
