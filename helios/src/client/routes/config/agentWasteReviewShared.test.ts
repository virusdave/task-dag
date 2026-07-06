import { describe, expect, it } from 'vitest'

import type {
  AgentWasteBacklogResponse,
  AgentWasteObservation,
} from '../../../shared/contracts/index.js'
import {
  AgentWasteBacklogUnavailableError,
  buildPromoteRequest,
  compareObservations,
  defaultPromoteFormState,
  deriveViewState,
  observationKey,
  parseTriggerIds,
  severityRank,
  severityTone,
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
