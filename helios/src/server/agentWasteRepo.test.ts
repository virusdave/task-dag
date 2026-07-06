import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentWasteUnavailableError,
  __resetBacklogReaderForTests,
  getBacklog,
  getBacklogSourceStatus,
  parseBacklogNdjson,
  setBacklogReader,
  unavailableBacklogReader,
  type BacklogReader,
} from './agentWasteRepo.js'
import type { AgentWasteObservation } from '../shared/contracts/api/agentWaste.js'

afterEach(() => {
  __resetBacklogReaderForTests()
  vi.restoreAllMocks()
})

describe('unavailable default reader (503-degrade)', () => {
  it('reports the source as unavailable', () => {
    expect(getBacklogSourceStatus().available).toBe(false)
    expect(unavailableBacklogReader.status().available).toBe(false)
  })

  it('throws AgentWasteUnavailableError carrying the source status', async () => {
    await expect(getBacklog()).rejects.toBeInstanceOf(AgentWasteUnavailableError)
    try {
      await getBacklog()
      throw new Error('expected getBacklog to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentWasteUnavailableError)
      expect((error as AgentWasteUnavailableError).status.available).toBe(false)
    }
  })
})

describe('setBacklogReader', () => {
  it('routes reads through the installed transport reader', async () => {
    const observations: AgentWasteObservation[] = [
      { time: '2026-07-06T00:00:00Z', kind: 'tool_footgun', id: 'x' },
    ]
    const reader: BacklogReader = {
      status: () => ({ available: true, detail: 'test reader' }),
      readBacklog: async () => observations,
    }
    setBacklogReader(reader)
    expect(getBacklogSourceStatus()).toEqual({ available: true, detail: 'test reader' })
    await expect(getBacklog()).resolves.toEqual(observations)
  })
})

describe('parseBacklogNdjson — defensive parsing', () => {
  it('parses well-formed lines and preserves optional fields', () => {
    const raw = [
      JSON.stringify({
        time: '2026-07-06T02:47:10Z',
        kind: 'tool_footgun',
        id: 'rg-short-r-rejected',
        severity: 'low',
        repo: 'owner/name',
        task_sha: 'abc123',
        estimated_wasted_tokens: 40,
        estimated_wasted_seconds: 45,
        note: 'free-form; humans only',
        host: 'vps-nixos-3',
      }),
    ].join('\n')
    const out = parseBacklogNdjson(raw)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('rg-short-r-rejected')
    expect(out[0].note).toBe('free-form; humans only')
    expect(out[0].estimated_wasted_tokens).toBe(40)
  })

  it('skips a single torn line and warns, without zeroing the whole list', () => {
    const warn = vi.fn()
    const raw = [
      JSON.stringify({ time: 't1', kind: 'k', id: 'a' }),
      '{ this is not json',
      JSON.stringify({ time: 't2', kind: 'k', id: 'b' }),
    ].join('\n')
    const out = parseBacklogNdjson(raw, warn)
    expect(out.map((o) => o.id)).toEqual(['a', 'b'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('skips schema-invalid lines (missing required id) and warns', () => {
    const warn = vi.fn()
    const raw = [
      JSON.stringify({ time: 't1', kind: 'k', id: 'a' }),
      JSON.stringify({ time: 't2', kind: 'k' }), // missing id
      JSON.stringify({ time: 't3', kind: 'k', id: 'c' }),
    ].join('\n')
    const out = parseBacklogNdjson(raw, warn)
    expect(out.map((o) => o.id)).toEqual(['a', 'c'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('ignores blank lines and returns an empty array for empty input', () => {
    expect(parseBacklogNdjson('')).toEqual([])
    expect(parseBacklogNdjson('\n\n  \n')).toEqual([])
  })
})
