import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AgentWasteUnavailableError,
  __resetBacklogReaderForTests,
  getBacklog,
  getBacklogSourceStatus,
} from './agentWasteRepo.js'
import { __resetAgentPainPointsMirrorForTests, initAgentPainPointsMirror } from './agentPainPointsMirror.js'
import { initAgentWasteBacklogReader, agentPainPointsBacklogReader } from './agentWasteBacklogReader.js'

const BACKLOG_REL = 'docs/agent-runtime/agent-waste-backlog.ndjson'

/**
 * Stand up a throwaway local git repo (default branch `master`) with the
 * given backlog file contents committed, and return its path. No network,
 * no prod resources — this is the fixture the reader reads through the
 * mirror module's local-checkout mode.
 */
function makeAgentPainPointsFixture(backlog: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pain-points-fixture-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
      stdio: 'pipe',
    })
  }
  git('init', '-b', 'master')
  // Always commit at least one file so `master` exists as a ref.
  fs.writeFileSync(path.join(dir, 'README'), 'fixture\n')
  if (backlog != null) {
    fs.mkdirSync(path.join(dir, path.dirname(BACKLOG_REL)), { recursive: true })
    fs.writeFileSync(path.join(dir, BACKLOG_REL), backlog)
  }
  git('add', '-A')
  git('commit', '-m', 'fixture')
  return dir
}

const tempDirs: string[] = []

beforeEach(() => {
  __resetAgentPainPointsMirrorForTests()
  __resetBacklogReaderForTests()
  delete process.env.AGENT_PAIN_POINTS_REPO_PATH
  delete process.env.HELIOS_AGENT_PAIN_POINTS_MIRROR_DIR
  delete process.env.HELIOS_AGENT_PAIN_POINTS_WRITE_DIR
  delete process.env.HELIOS_AGENT_PAIN_POINTS_DEPLOY_KEY
  delete process.env.HELIOS_AGENT_WASTE_BACKLOG_PATH
})

afterEach(() => {
  __resetAgentPainPointsMirrorForTests()
  __resetBacklogReaderForTests()
  delete process.env.AGENT_PAIN_POINTS_REPO_PATH
  delete process.env.HELIOS_AGENT_PAIN_POINTS_MIRROR_DIR
  delete process.env.HELIOS_AGENT_PAIN_POINTS_WRITE_DIR
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()
    if (d) fs.rmSync(d, { recursive: true, force: true })
  }
})

async function wireFixture(backlog: string | null): Promise<void> {
  const dir = makeAgentPainPointsFixture(backlog)
  tempDirs.push(dir)
  process.env.AGENT_PAIN_POINTS_REPO_PATH = dir
  // No deploy key / no LOCAL_DIR → local-checkout mode, no network.
  await initAgentPainPointsMirror()
  initAgentWasteBacklogReader()
}

describe('agentPainPointsBacklogReader — mirror available, backlog file present', () => {
  it('parses committed NDJSON observations off the agent-pain-points mirror', async () => {
    const backlog = [
      JSON.stringify({
        time: '2026-07-06T02:47:10Z',
        kind: 'tool_footgun',
        id: 'rg-short-r-rejected',
        severity: 'low',
        repo: 'owner/name',
        note: 'humans only — never injected',
      }),
      JSON.stringify({ time: '2026-07-06T03:00:00Z', kind: 'startup_repeat', id: 'canon-reread' }),
      '',
    ].join('\n')
    await wireFixture(backlog)

    expect(getBacklogSourceStatus().available).toBe(true)
    const observations = await getBacklog()
    expect(observations.map((o) => o.id)).toEqual(['rg-short-r-rejected', 'canon-reread'])
    expect(observations[0].note).toBe('humans only — never injected')
  })

  it('skips a torn line but keeps the valid observations', async () => {
    const backlog = [
      JSON.stringify({ time: 't1', kind: 'k', id: 'a' }),
      '{ not json',
      JSON.stringify({ time: 't2', kind: 'k', id: 'b' }),
    ].join('\n')
    await wireFixture(backlog)

    const observations = await agentPainPointsBacklogReader.readBacklog()
    expect(observations.map((o) => o.id)).toEqual(['a', 'b'])
  })
})

describe('agentPainPointsBacklogReader — mirror available, backlog file missing', () => {
  it('reports available with a fail-safe empty backlog', async () => {
    await wireFixture(null)

    expect(getBacklogSourceStatus().available).toBe(true)
    await expect(getBacklog()).resolves.toEqual([])
  })
})

describe('agentPainPointsBacklogReader — mirror unavailable', () => {
  it('reports unavailable and throws AgentWasteUnavailableError (route 503-degrades)', async () => {
    // No init, no AGENT_PAIN_POINTS_REPO_PATH → mirror is not available. No network.
    initAgentWasteBacklogReader()

    const status = getBacklogSourceStatus()
    expect(status.available).toBe(false)
    expect(status.detail).toMatch(/agent-pain-points mirror unavailable/i)
    await expect(getBacklog()).rejects.toBeInstanceOf(AgentWasteUnavailableError)
  })
})

describe('read mirror vs promote write clone must not share a directory (design §5)', () => {
  it('refuses to run the read mirror when MIRROR_DIR equals WRITE_DIR (never deletes the write clone)', async () => {
    // Stand up a working-tree checkout (the shape of the promote write clone).
    const clone = makeAgentPainPointsFixture('{"time":"t","kind":"k","id":"keep"}\n')
    tempDirs.push(clone)
    const sentinel = path.join(clone, '.git', 'config')
    expect(fs.existsSync(sentinel)).toBe(true)

    // Point BOTH the read mirror dir and the write clone dir at it. Arming the
    // mirror must refuse rather than rm -rf the working tree.
    process.env.HELIOS_AGENT_PAIN_POINTS_MIRROR_DIR = clone
    process.env.HELIOS_AGENT_PAIN_POINTS_WRITE_DIR = clone

    const result = await initAgentPainPointsMirror()
    // Fail closed: the mirror does not run, so the backlog is unavailable …
    expect(result.available).toBe(false)
    // … and the working-tree clone is untouched.
    expect(fs.existsSync(sentinel)).toBe(true)
  })

  it('refuses to delete a working-tree checkout pinned as the mirror dir', async () => {
    // Even without a WRITE_DIR set, a MIRROR_DIR that is a working tree must
    // not be blown away by the bare-mirror bootstrap (defense-in-depth).
    const clone = makeAgentPainPointsFixture(null)
    tempDirs.push(clone)
    const sentinel = path.join(clone, '.git', 'config')
    expect(fs.existsSync(sentinel)).toBe(true)

    process.env.HELIOS_AGENT_PAIN_POINTS_MIRROR_DIR = clone

    const result = await initAgentPainPointsMirror()
    expect(result.available).toBe(false)
    expect(fs.existsSync(sentinel)).toBe(true)
  })
})
