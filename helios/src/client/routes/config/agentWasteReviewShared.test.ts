import { describe, expect, it } from 'vitest'

import type {
  AgentWasteBacklogResponse,
  AgentWasteObservation,
} from '../../../shared/contracts/index.js'
import {
  AgentWasteBacklogUnavailableError,
  compareObservations,
  deriveViewState,
  observationKey,
  severityRank,
  severityTone,
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
