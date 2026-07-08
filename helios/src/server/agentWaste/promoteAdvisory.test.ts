// Deterministic, prod-resource-free tests for the promote apply path.
// Everything runs against EPHEMERAL local git repos in a temp dir (a bare
// "origin" + a working clone); NEVER prod virusdave/agent-pain-points. No network,
// no ssh key (a local file remote needs none).

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PromoteAdvisoryRequest } from '../../shared/contracts/api/agentWaste.js'
import { promoteAdvisory } from './promoteAdvisory.js'

const REL = 'docs/agent-runtime/advisories.yaml'

const STARTER_CATALOG = [
  '# Reviewed advisory catalog (test fixture).',
  'version: 1',
  'budget: { max_total_tokens: 500, max_advisories: 5, default_expires_after_days: 14 }',
  'ranking:',
  '  severity_weights: { safety: 1000, high: 8, medium: 3, low: 1 }',
  '  recurrence_window_days: 14',
  '  age_halflife_days: 7',
  'advisories: []',
  '',
  '# ─── SCHEMA BY EXAMPLE (commented) ───',
  '#   - { id: example, status: active, ... }',
  '',
].join('\n')

let tmpRoot: string
let originDir: string
let workDir: string
const savedEnv: Record<string, string | undefined> = {}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function readOriginCatalog(): string {
  return git(originDir, ['show', `master:${REL}`])
}

function setupRepos(catalog: string): void {
  originDir = path.join(tmpRoot, 'origin.git')
  workDir = path.join(tmpRoot, 'work')
  git(tmpRoot, ['init', '-q', '--bare', '-b', 'master', originDir])

  const seed = path.join(tmpRoot, 'seed')
  fs.mkdirSync(seed)
  git(seed, ['init', '-q', '-b', 'master'])
  git(seed, ['config', 'user.email', 'seed@example.com'])
  git(seed, ['config', 'user.name', 'Seed'])
  git(seed, ['config', 'commit.gpgsign', 'false'])
  fs.mkdirSync(path.join(seed, path.dirname(REL)), { recursive: true })
  fs.writeFileSync(path.join(seed, REL), catalog)
  git(seed, ['add', '-A'])
  git(seed, ['commit', '-q', '-m', 'seed catalog'])
  git(seed, ['remote', 'add', 'origin', originDir])
  git(seed, ['push', '-q', 'origin', 'HEAD:master'])

  git(tmpRoot, ['clone', '-q', originDir, workDir])
  git(workDir, ['config', 'user.email', 'work@example.com'])
  git(workDir, ['config', 'user.name', 'Work'])
  git(workDir, ['config', 'commit.gpgsign', 'false'])

  process.env.HELIOS_AGENT_PAIN_POINTS_WRITE_DIR = workDir
  process.env.HELIOS_AGENT_PAIN_POINTS_REPO_URL = originDir
}

function baseRequest(overrides: Partial<PromoteAdvisoryRequest> = {}): PromoteAdvisoryRequest {
  return {
    id: 'rg-short-r',
    status: 'active',
    scope: 'global',
    severity: 'low',
    max_tokens: 35,
    text: 'Use rg -n / rg -l; never rg -r (ripgrep -r is replace).',
    trigger_ids: ['rg-short-r-rejected'],
    expires_after_days: 14,
    sourceObservationId: 'rg-short-r-rejected',
    ...overrides,
  } as PromoteAdvisoryRequest
}

function input(request: PromoteAdvisoryRequest) {
  return { request, actorEmail: 'admin@example.com', actorUserId: 7, requestId: 'req-1' }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-adv-'))
  for (const k of ['HELIOS_AGENT_PAIN_POINTS_WRITE_DIR', 'HELIOS_AGENT_PAIN_POINTS_REPO_URL', 'HELIOS_AGENT_PAIN_POINTS_WRITE_DEPLOY_KEY']) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('promoteAdvisory', () => {
  it('fails closed when the agent-pain-points write clone is not configured', async () => {
    const res = await promoteAdvisory(input(baseRequest()))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('agent_pain_points_unavailable')
  })

  it('fails closed on a network remote when no write deploy key is configured', async () => {
    setupRepos(STARTER_CATALOG)
    // Point at a network (SSH) remote but provide no key: must refuse rather
    // than attempt an unauthenticated push. (The local clone is real; only the
    // declared remote URL flips it into "needs a key" territory.)
    process.env.HELIOS_AGENT_PAIN_POINTS_REPO_URL = 'git@github.com:virusdave/agent-pain-points.git'
    delete process.env.HELIOS_AGENT_PAIN_POINTS_WRITE_DEPLOY_KEY
    const res = await promoteAdvisory(input(baseRequest()))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('agent_pain_points_unavailable')
    // origin (the local bare repo) must be untouched.
    expect(git(originDir, ['rev-list', '--count', 'master'])).toBe('1')
  })

  it('refuses to write when the origin identity does not match the expected repo', async () => {
    setupRepos(STARTER_CATALOG)
    // We expect a specific GitHub repo, but the actual origin is the local
    // bare repo (unparseable owner/repo) — the identity guard must fail closed.
    // A dummy key satisfies the deploy-key precheck; it is never used because
    // we fail before any authenticated git op.
    process.env.HELIOS_AGENT_PAIN_POINTS_REPO_URL = 'git@github.com:virusdave/agent-pain-points.git'
    process.env.HELIOS_AGENT_PAIN_POINTS_WRITE_DEPLOY_KEY = path.join(tmpRoot, 'dummy-key')
    fs.writeFileSync(process.env.HELIOS_AGENT_PAIN_POINTS_WRITE_DEPLOY_KEY, 'not-a-real-key')
    const res = await promoteAdvisory(input(baseRequest()))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('git_command_failed')
    expect(res.message).toContain('expected virusdave/agent-pain-points')
    expect(git(originDir, ['rev-list', '--count', 'master'])).toBe('1')
  })

  it('validates, commits, and pushes a new advisory to origin master', async () => {
    setupRepos(STARTER_CATALOG)
    const res = await promoteAdvisory(input(baseRequest()))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.id).toBe('rg-short-r')
    expect(res.relPath).toBe(REL)
    expect(res.pushed).toBe(true)
    expect(res.commitSha).toMatch(/^[0-9a-f]{40}$/)

    const catalog = readOriginCatalog()
    expect(catalog).toContain('id: rg-short-r')
    expect(catalog).toContain('Use rg -n')
    // Comments preserved.
    expect(catalog).toContain('# ─── SCHEMA BY EXAMPLE')

    // The commit records provenance (audit) and does NOT echo the note anywhere.
    const msg = git(originDir, ['show', '-s', '--format=%B', 'master'])
    expect(msg).toContain('Advisory-Id: rg-short-r')
    expect(msg).toContain('Source-Observation-Id: rg-short-r-rejected')
    expect(msg).toContain('Helios-Actor-Email: admin@example.com')
  })

  it('rejects a duplicate id against the current catalog (no commit)', async () => {
    setupRepos(STARTER_CATALOG)
    const first = await promoteAdvisory(input(baseRequest()))
    expect(first.ok).toBe(true)
    const before = git(originDir, ['rev-parse', 'master'])
    const dup = await promoteAdvisory(input(baseRequest({ text: 'a different text but same id here' })))
    expect(dup.ok).toBe(false)
    if (dup.ok) return
    expect(dup.code).toBe('id_exists')
    // origin unchanged.
    expect(git(originDir, ['rev-parse', 'master'])).toBe(before)
  })

  it('refuses to build on a contract-invalid current catalog', async () => {
    setupRepos(STARTER_CATALOG.replace('version: 1', 'version: 2'))
    const res = await promoteAdvisory(input(baseRequest()))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('catalog_current_invalid')
  })

  it('builds on the latest origin master (picks up a concurrent unrelated commit)', async () => {
    setupRepos(STARTER_CATALOG)
    // Simulate the exporter (child epic #2) landing an unrelated file on
    // origin master AFTER our working clone was made.
    const other = path.join(tmpRoot, 'other')
    git(tmpRoot, ['clone', '-q', originDir, other])
    git(other, ['config', 'user.email', 'x@example.com'])
    git(other, ['config', 'user.name', 'X'])
    git(other, ['config', 'commit.gpgsign', 'false'])
    fs.writeFileSync(path.join(other, 'agent-waste-backlog.ndjson'), '{"id":"x"}\n')
    git(other, ['add', '-A'])
    git(other, ['commit', '-q', '-m', 'exporter append'])
    git(other, ['push', '-q', 'origin', 'HEAD:master'])

    const res = await promoteAdvisory(input(baseRequest()))
    expect(res.ok).toBe(true)
    // Both the exporter file and our advisory are present on origin.
    expect(git(originDir, ['show', 'master:agent-waste-backlog.ndjson'])).toContain('"id":"x"')
    expect(readOriginCatalog()).toContain('id: rg-short-r')
  })

  it('serializes concurrent promotions (mutex) so both land without clobbering', async () => {
    setupRepos(STARTER_CATALOG)
    const [a, b] = await Promise.all([
      promoteAdvisory(input(baseRequest({ id: 'alpha-thing', trigger_ids: ['alpha-obs'], sourceObservationId: 'alpha-obs' }))),
      promoteAdvisory(input(baseRequest({ id: 'beta-thing', trigger_ids: ['beta-obs'], sourceObservationId: 'beta-obs' }))),
    ])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    const catalog = readOriginCatalog()
    expect(catalog).toContain('id: alpha-thing')
    expect(catalog).toContain('id: beta-thing')
  })

  it('supports a permanent-safety promotion (no expires_after_days)', async () => {
    setupRepos(STARTER_CATALOG)
    const res = await promoteAdvisory(
      input(
        baseRequest({
          id: 'perma-safety',
          status: 'permanent-safety',
          severity: 'safety',
          trigger_ids: [],
          expires_after_days: undefined,
          sourceObservationId: 'perma-obs',
        }),
      ),
    )
    expect(res.ok).toBe(true)
    const catalog = readOriginCatalog()
    expect(catalog).toContain('id: perma-safety')
    // The entry line itself must not carry a TTL (only the budget block's
    // `default_expires_after_days` may mention that token).
    const entryLine = catalog.split('\n').find((l) => l.includes('id: perma-safety')) ?? ''
    expect(entryLine).not.toContain('expires_after_days')
  })
})
