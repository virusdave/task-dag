import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentWasteBacklogResponse,
  AgentWasteObservation,
} from '../../../shared/contracts/index.js'
import type { AgentWasteCluster } from '../../../shared/contracts/index.js'
import {
  AgentWasteBacklogUnavailableError,
  buildPromoteRequest,
  clusterOtherMembers,
  compareObservations,
  defaultPromoteFormState,
  deriveViewState,
  describeClusterError,
  fetchAgentWasteClusters,
  observationKey,
  parseTriggerIds,
  severityRank,
  severityTone,
  sortClustersByWaste,
  toAdvisorySeverity,
  type PromoteFormState,
} from './agentWasteReviewShared.js'

function obs(overrides: Partial<AgentWasteObservation>): AgentWasteObservation {
  return {
    time: '2026-07-01T00:00:00.000Z',
    kind: 'tool_footgun',
    id: 'rg-short-r-rejected',
    ...overrides,
  }
}

const AVAILABLE = { available: true, detail: 'ok' }

describe('severityTone', () => {
  it('maps the serious end of the scale to loud tones (safety>high), muting the rest', () => {
    expect(severityTone('safety')).toBe('danger')
    expect(severityTone('high')).toBe('warning')
    expect(severityTone('medium')).toBe('muted')
    expect(severityTone('low')).toBe('muted')
  })

  it('falls back to muted for unknown/absent severities (never drops the row)', () => {
    expect(severityTone(undefined)).toBe('muted')
    expect(severityTone('wat')).toBe('muted')
  })
})

describe('severityRank', () => {
  it('orders low < medium < high < safety and sorts unknown last', () => {
    expect(severityRank('low')).toBeLessThan(severityRank('medium'))
    expect(severityRank('medium')).toBeLessThan(severityRank('high'))
    expect(severityRank('high')).toBeLessThan(severityRank('safety'))
    expect(severityRank('nope')).toBe(-1)
    expect(severityRank(undefined)).toBe(-1)
  })
})

describe('compareObservations', () => {
  it('sorts newest first', () => {
    const older = obs({ time: '2026-07-01T00:00:00.000Z' })
    const newer = obs({ time: '2026-07-02T00:00:00.000Z' })
    const sorted = [older, newer].sort(compareObservations)
    expect(sorted[0]).toBe(newer)
    expect(sorted[1]).toBe(older)
  })

  it('breaks ties on equal timestamps by descending severity', () => {
    const low = obs({ severity: 'low', id: 'a' })
    const safety = obs({ severity: 'safety', id: 'b' })
    const sorted = [low, safety].sort(compareObservations)
    expect(sorted[0]).toBe(safety)
    expect(sorted[1]).toBe(low)
  })

  it('sorts invalid/missing timestamps to the bottom without throwing', () => {
    const good = obs({ time: '2026-07-01T00:00:00.000Z' })
    const bad = obs({ time: 'not-a-date' })
    const sorted = [bad, good].sort(compareObservations)
    expect(sorted[0]).toBe(good)
    expect(sorted[1]).toBe(bad)
  })
})

describe('observationKey', () => {
  it('is stable and distinguishes observations that differ in any field', () => {
    const base = obs({ note: 'hello', repo: 'owner/name' })
    expect(observationKey(base)).toBe(observationKey(obs({ note: 'hello', repo: 'owner/name' })))
    expect(observationKey(base)).not.toBe(observationKey(obs({ note: 'other', repo: 'owner/name' })))
    expect(observationKey(base)).not.toBe(observationKey(obs({ note: 'hello', repo: 'x/y' })))
  })

  it('does not collide across field boundaries (uses a separator)', () => {
    const a = obs({ kind: 'ab', id: 'c' })
    const b = obs({ kind: 'a', id: 'bc' })
    expect(observationKey(a)).not.toBe(observationKey(b))
  })
})

describe('deriveViewState', () => {
  const ready: AgentWasteBacklogResponse = {
    source: AVAILABLE,
    observations: [obs({}), obs({ id: 'other' })],
  }
  const emptyResponse: AgentWasteBacklogResponse = { source: AVAILABLE, observations: [] }

  it('is loading before the first fetch resolves', () => {
    expect(deriveViewState({ loading: true, data: null, error: null, visibleCount: 0 })).toEqual({
      kind: 'loading',
    })
  })

  it('is empty when the backlog is genuinely empty (available, zero rows)', () => {
    const state = deriveViewState({ loading: false, data: emptyResponse, error: null, visibleCount: 0 })
    expect(state).toEqual({ kind: 'empty', source: AVAILABLE })
  })

  it('is ready with the visible count when there are observations', () => {
    const state = deriveViewState({ loading: false, data: ready, error: null, visibleCount: 1 })
    expect(state).toEqual({ kind: 'ready', source: AVAILABLE, visibleCount: 1 })
  })

  it('reports unavailable (503) with message + detail when there is no data', () => {
    const err = new AgentWasteBacklogUnavailableError('down', 'transport not wired yet')
    const state = deriveViewState({ loading: false, data: null, error: err, visibleCount: 0 })
    expect(state).toEqual({ kind: 'unavailable', message: 'down', detail: 'transport not wired yet' })
  })

  it('reports a generic error for non-503 failures with no data', () => {
    const state = deriveViewState({
      loading: false,
      data: null,
      error: new Error('boom'),
      visibleCount: 0,
    })
    expect(state).toEqual({ kind: 'error', message: 'boom' })
  })

  it('keeps showing last-good data even while a background refresh errors', () => {
    const state = deriveViewState({
      loading: false,
      data: ready,
      error: new Error('transient'),
      visibleCount: 2,
    })
    expect(state).toEqual({ kind: 'ready', source: AVAILABLE, visibleCount: 2 })
  })
})

describe('promote form helpers', () => {
  it('seeds the form with an EMPTY text (never from the observation note)', () => {
    const state = defaultPromoteFormState(obs({ id: 'rg-short-r-rejected', note: 'agent free text', severity: 'high' }))
    expect(state.text).toBe('')
    // provenance defaults: observation id seeds trigger ids + severity default.
    expect(state.triggerIdsCsv).toBe('rg-short-r-rejected')
    expect(state.severity).toBe('high')
    expect(state.status).toBe('active')
  })

  it('coerces an unknown severity to a valid default', () => {
    expect(toAdvisorySeverity('bogus')).toBe('medium')
    expect(toAdvisorySeverity(undefined)).toBe('medium')
    expect(toAdvisorySeverity('safety')).toBe('safety')
  })

  it('parses trigger ids from comma/space separated input', () => {
    expect(parseTriggerIds('a, b  c,,d')).toEqual(['a', 'b', 'c', 'd'])
    expect(parseTriggerIds('   ')).toEqual([])
  })

  function form(overrides: Partial<PromoteFormState> = {}): PromoteFormState {
    return {
      id: 'rg-short-r',
      status: 'active',
      scope: 'global',
      severity: 'low',
      maxTokens: '35',
      text: 'Use rg -n / rg -l; never rg -r.',
      triggerIdsCsv: 'rg-short-r-rejected',
      expiresAfterDays: '',
      notes: '',
      ...overrides,
    }
  }

  it('builds a valid request against the shared contract schema', () => {
    const res = buildPromoteRequest(form(), 'rg-short-r-rejected')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.request.id).toBe('rg-short-r')
    expect(res.request.trigger_ids).toEqual(['rg-short-r-rejected'])
    expect(res.request.sourceObservationId).toBe('rg-short-r-rejected')
    // note is not a field; nothing agent-authored leaks in beyond approved text.
    expect((res.request as Record<string, unknown>).note).toBeUndefined()
  })

  it('surfaces field errors for an invalid form (non-kebab id, over-budget text)', () => {
    const res = buildPromoteRequest(form({ id: 'Not Kebab', maxTokens: '1' }), 'obs-1')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors.join(' ')).toMatch(/id|kebab/i)
  })

  it('rejects an active promotion with no trigger ids', () => {
    const res = buildPromoteRequest(form({ triggerIdsCsv: '' }), 'obs-1')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors.join(' ')).toMatch(/trigger/i)
  })
})

// ── Cluster similar reports (issue #68) ─────────────────────────────────────

function cluster(overrides: Partial<AgentWasteCluster>): AgentWasteCluster {
  const primary = obs({ id: 'p' })
  return {
    label: 'theme',
    primary,
    members: [primary],
    count: 1,
    aggregateWastedTokens: 0,
    aggregateWastedSeconds: 0,
    ...overrides,
  }
}

describe('sortClustersByWaste', () => {
  it('orders descending by tokens, then seconds, then count, then label', () => {
    const a = cluster({ label: 'a', aggregateWastedTokens: 100 })
    const b = cluster({ label: 'b', aggregateWastedTokens: 50, aggregateWastedSeconds: 9 })
    const c = cluster({ label: 'c', aggregateWastedTokens: 50, aggregateWastedSeconds: 1 })
    const sorted = sortClustersByWaste([c, b, a])
    expect(sorted.map((x) => x.label)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate its input', () => {
    const input = [cluster({ label: 'x', aggregateWastedTokens: 1 }), cluster({ label: 'y', aggregateWastedTokens: 2 })]
    const copy = [...input]
    sortClustersByWaste(input)
    expect(input).toEqual(copy)
  })
})

describe('clusterOtherMembers', () => {
  it('drops exactly one occurrence of the primary', () => {
    const primary = obs({ id: 'p', note: 'primary' })
    const other = obs({ id: 'o', note: 'other' })
    const c = cluster({ primary, members: [primary, other], count: 2 })
    const rest = clusterOtherMembers(c)
    expect(rest.map((m) => m.id)).toEqual(['o'])
  })

  it('returns empty for a single-member cluster', () => {
    expect(clusterOtherMembers(cluster({}))).toEqual([])
  })
})

describe('describeClusterError', () => {
  it('explains the common failure codes and passes the message through', () => {
    expect(describeClusterError('bedrock_unconfigured', 'no token')).toMatch(/not configured/i)
    expect(describeClusterError('agent_waste_cluster_input_too_large', 'too big')).toBe('too big')
    expect(describeClusterError('bedrock_http_error', 'HTTP 500')).toMatch(/could not complete/i)
    expect(describeClusterError('weird', 'raw')).toBe('raw')
  })
})

describe('fetchAgentWasteClusters', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(status: number, body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      })),
    )
  }

  const okBody = {
    source: { available: true, detail: 'ok' },
    model: 'deepseek.v3.2',
    clusters: [
      {
        label: 'small',
        primary: obs({ id: 'a' }),
        members: [obs({ id: 'a' })],
        count: 1,
        aggregateWastedTokens: 5,
        aggregateWastedSeconds: 0,
      },
      {
        label: 'big',
        primary: obs({ id: 'b' }),
        members: [obs({ id: 'b' })],
        count: 1,
        aggregateWastedTokens: 500,
        aggregateWastedSeconds: 0,
      },
    ],
    unclustered: [],
  }

  it('parses a 200 body and defensively re-sorts clusters by waste', async () => {
    stubFetch(200, okBody)
    const res = await fetchAgentWasteClusters()
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.response.model).toBe('deepseek.v3.2')
    expect(res.response.clusters.map((c) => c.label)).toEqual(['big', 'small'])
  })

  it('returns the structured error on a 413 too-large body', async () => {
    stubFetch(413, {
      error: 'agent_waste_cluster_input_too_large',
      message: 'too many',
      observationCount: 201,
      maxObservations: 200,
    })
    const res = await fetchAgentWasteClusters()
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('agent_waste_cluster_input_too_large')
  })

  it('returns the structured error on a 503 unconfigured body', async () => {
    stubFetch(503, { error: 'bedrock_unconfigured', message: 'no token' })
    const res = await fetchAgentWasteClusters()
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('bedrock_unconfigured')
  })

  it('returns bad_response when the 200 body does not match the schema', async () => {
    stubFetch(200, { source: { available: true, detail: 'ok' }, model: 'm' })
    const res = await fetchAgentWasteClusters()
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('bad_response')
  })

  it('returns network_error when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const res = await fetchAgentWasteClusters()
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('network_error')
  })
})
