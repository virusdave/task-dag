/**
 * Git-DAG Task Management - Query Layer
 * 
 * Thin wrapper around git plumbing commands to build and query task DAG.
 * Uses in-memory caching keyed by refs fingerprint.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const REPO_PATH = process.env.AUTOMATION_REPO_PATH || '/home/amp-local/src/automation';

export interface TaskNode {
  sha: string;
  shortSha: string;
  title: string;
  issueNumber?: number;
  status: 'pending' | 'in-progress' | 'blocked' | 'done';
  type: 'epic' | 'task' | 'leaf';
  author?: string;
  createdAt?: Date;
  parentTask?: string;
  dependencies: string[];
  breakdownChildren: string[];
  dependents: string[];
  refs: string[];
  isFrontier: boolean;
  isActive: boolean;
  completedBy: string[];
}

export interface TaskEdge {
  source: string;
  target: string;
  kind: 'breakdown' | 'dependency';
}

export interface TaskIndex {
  nodes: Map<string, TaskNode>;
  epicsByIssue: Map<number, string>;
  frontierTasks: string[];
  activeTasks: string[];
  fingerprintHash: string;
}

export interface EpicSummary {
  issueNumber?: number;
  epicRef: string;
  sha: string;
  title: string;
  statusCounts: Record<string, number>;
  frontierCount: number;
  completionPct: number;
}

export interface DagResult {
  nodes: TaskNode[];
  edges: TaskEdge[];
  summary: {
    totalTasks: number;
    statusCounts: Record<string, number>;
    depth: number;
  };
}

let cachedIndex: TaskIndex | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 30000; // 30 seconds

async function gitCommand(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: REPO_PATH, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

async function getRefsFingerprint(): Promise<string> {
  const refs = await gitCommand('for-each-ref', 'refs/heads/tasks/', '--format=%(objectname) %(refname)');
  return crypto.createHash('sha256').update(refs).digest('hex').substring(0, 16);
}

function extractField(message: string, field: string): string | undefined {
  const match = message.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim();
}

function parseCommitMessage(message: string): Partial<TaskNode> {
  const lines = message.split('\n');
  const title = lines[0]?.replace(/^Task:\s*/, '').trim() || '';
  
  const issueStr = extractField(message, 'Issue');
  const issueNumber = issueStr ? parseInt(issueStr.replace(/^#/, ''), 10) : undefined;
  
  return {
    title,
    issueNumber,
    author: extractField(message, 'Author'),
    status: (extractField(message, 'Status') as TaskNode['status']) || 'pending',
    type: (extractField(message, 'Type') as TaskNode['type']) || 'task',
    parentTask: extractField(message, 'Parent-Task'),
  };
}

async function getCommitParents(sha: string): Promise<string[]> {
  const output = await gitCommand('rev-list', '--parents', '-1', sha);
  const parts = output.split(/\s+/);
  return parts.slice(1); // Skip the commit SHA itself
}

async function isTaskCompleted(sha: string): Promise<boolean> {
  try {
    const parentsOutput = await gitCommand('log', '--all', '--format=%P');
    return parentsOutput.includes(sha);
  } catch {
    return false;
  }
}

async function getTaskRefs(sha: string): Promise<string[]> {
  try {
    const output = await gitCommand('for-each-ref', '--format=%(refname:short)', '--points-at', sha);
    return output.split('\n').filter(ref => ref.startsWith('tasks/'));
  } catch {
    return [];
  }
}

export async function loadTaskIndex(): Promise<TaskIndex> {
  const fingerprint = await getRefsFingerprint();
  const now = Date.now();
  
  // Return cached if still valid
  if (cachedIndex && cachedIndex.fingerprintHash === fingerprint && (now - lastCacheTime) < CACHE_TTL_MS) {
    return cachedIndex;
  }
  
  // Build fresh index
  const nodes = new Map<string, TaskNode>();
  const epicsByIssue = new Map<number, string>();
  const frontierTasks: string[] = [];
  const activeTasks: string[] = [];
  
  // Get all task refs
  const refsOutput = await gitCommand('for-each-ref', 'refs/heads/tasks/', '--format=%(objectname) %(refname:short)');
  const refLines = refsOutput.split('\n').filter(Boolean);
  
  const refsBySha = new Map<string, string[]>();
  for (const line of refLines) {
    const [sha, ref] = line.split(/\s+/);
    if (!refsBySha.has(sha)) {
      refsBySha.set(sha, []);
    }
    refsBySha.get(sha)!.push(ref);
    
    if (ref.startsWith('tasks/frontier/')) {
      frontierTasks.push(sha);
    } else if (ref.startsWith('tasks/active/')) {
      activeTasks.push(sha);
    }
  }
  
  // Process each unique SHA
  const uniqueShas = new Set(refsBySha.keys());
  
  for (const sha of uniqueShas) {
    const shortSha = sha.substring(0, 7);
    const message = await gitCommand('log', '-1', '--format=%B', sha);
    const parsed = parseCommitMessage(message);
    const parents = await getCommitParents(sha);
    const refs = refsBySha.get(sha) || [];
    
    const node: TaskNode = {
      sha,
      shortSha,
      title: parsed.title || 'Untitled Task',
      issueNumber: parsed.issueNumber,
      status: parsed.status || 'pending',
      type: parsed.type || 'task',
      author: parsed.author,
      parentTask: parsed.parentTask || parents[0],
      dependencies: parents.slice(1), // 2nd+ parents
      breakdownChildren: [],
      dependents: [],
      refs,
      isFrontier: frontierTasks.includes(sha),
      isActive: activeTasks.includes(sha),
      completedBy: [],
    };
    
    nodes.set(sha, node);
    
    if (parsed.issueNumber && refs.some(r => r.startsWith('tasks/pending/'))) {
      epicsByIssue.set(parsed.issueNumber, sha);
    }
  }
  
  // Build inverse relationships
  for (const node of nodes.values()) {
    // Breakdown children: find nodes where this is the first parent
    for (const other of nodes.values()) {
      if (other.parentTask === node.sha || other.dependencies.includes(node.sha)) {
        if (other.parentTask === node.sha) {
          node.breakdownChildren.push(other.sha);
        }
        if (other.dependencies.includes(node.sha)) {
          node.dependents.push(other.sha);
        }
      }
    }
  }
  
  // Check completion status
  for (const node of nodes.values()) {
    if (await isTaskCompleted(node.sha)) {
      node.status = 'done';
    }
  }
  
  const index: TaskIndex = {
    nodes,
    epicsByIssue,
    frontierTasks,
    activeTasks,
    fingerprintHash: fingerprint,
  };
  
  cachedIndex = index;
  lastCacheTime = now;
  
  return index;
}

export async function getEpics(): Promise<EpicSummary[]> {
  const index = await loadTaskIndex();
  const epics: EpicSummary[] = [];
  
  for (const [issueNumber, epicSha] of index.epicsByIssue.entries()) {
    const epicNode = index.nodes.get(epicSha);
    if (!epicNode) continue;
    
    // Collect all descendant tasks
    const descendants = new Set<string>();
    const queue = [epicSha];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = index.nodes.get(current);
      if (!node) continue;
      
      for (const child of node.breakdownChildren) {
        if (!descendants.has(child)) {
          descendants.add(child);
          queue.push(child);
        }
      }
    }
    
    const statusCounts: Record<string, number> = {};
    let frontierCount = 0;
    
    for (const sha of descendants) {
      const node = index.nodes.get(sha);
      if (!node) continue;
      
      statusCounts[node.status] = (statusCounts[node.status] || 0) + 1;
      if (node.isFrontier) frontierCount++;
    }
    
    const totalTasks = descendants.size;
    const doneTasks = statusCounts['done'] || 0;
    
    epics.push({
      issueNumber,
      epicRef: epicNode.refs.find(r => r.startsWith('tasks/pending/')) || epicNode.refs[0] || '',
      sha: epicSha,
      title: epicNode.title,
      statusCounts,
      frontierCount,
      completionPct: totalTasks > 0 ? doneTasks / totalTasks : 0,
    });
  }
  
  return epics;
}

export async function getEpicDag(epicRefOrSha: string): Promise<DagResult> {
  const index = await loadTaskIndex();
  
  // Resolve to SHA
  let epicSha: string;
  try {
    epicSha = await gitCommand('rev-parse', epicRefOrSha);
  } catch {
    epicSha = epicRefOrSha;
  }
  
  const epicNode = index.nodes.get(epicSha);
  if (!epicNode) {
    throw new Error(`Epic not found: ${epicRefOrSha}`);
  }
  
  // BFS to collect all descendants
  const nodes: TaskNode[] = [];
  const edges: TaskEdge[] = [];
  const visited = new Set<string>();
  const queue = [epicSha];
  
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    
    const node = index.nodes.get(current);
    if (!node) continue;
    
    nodes.push(node);
    
    // Breakdown edges (1st parent)
    for (const child of node.breakdownChildren) {
      edges.push({ source: current, target: child, kind: 'breakdown' });
      if (!visited.has(child)) {
        queue.push(child);
      }
    }
    
    // Dependency edges (2nd+ parents)
    for (const dep of node.dependencies) {
      edges.push({ source: dep, target: current, kind: 'dependency' });
    }
  }
  
  const statusCounts: Record<string, number> = {};
  for (const node of nodes) {
    statusCounts[node.status] = (statusCounts[node.status] || 0) + 1;
  }
  
  return {
    nodes,
    edges,
    summary: {
      totalTasks: nodes.length,
      statusCounts,
      depth: 0, // TODO: calculate max depth
    },
  };
}

export async function getFrontier(filter?: { issue?: number; status?: string }): Promise<TaskNode[]> {
  const index = await loadTaskIndex();
  const frontierNodes: TaskNode[] = [];
  
  for (const sha of index.frontierTasks) {
    const node = index.nodes.get(sha);
    if (!node) continue;
    
    if (filter?.issue && node.issueNumber !== filter.issue) continue;
    if (filter?.status && node.status !== filter.status) continue;
    
    frontierNodes.push(node);
  }
  
  return frontierNodes;
}

export async function getTaskDetail(sha: string): Promise<TaskNode | null> {
  const index = await loadTaskIndex();
  return index.nodes.get(sha) || null;
}

export async function validateDag(): Promise<{ errors: number; warnings: number; valid: boolean }> {
  const index = await loadTaskIndex();
  let errors = 0;
  let warnings = 0;
  
  for (const node of index.nodes.values()) {
    // Check empty tree
    try {
      const tree = await gitCommand('rev-parse', `${node.sha}^{tree}`);
      if (tree !== EMPTY_TREE) {
        errors++;
      }
    } catch {
      errors++;
    }
    
    // Check frontier refs point to leaf/task types
    if (node.isFrontier && node.type !== 'leaf' && node.type !== 'task') {
      warnings++;
    }
  }
  
  return { errors, warnings, valid: errors === 0 };
}
