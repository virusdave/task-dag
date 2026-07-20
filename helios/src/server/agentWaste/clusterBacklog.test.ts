// Pure unit tests for the agent-waste clustering logic (issue #68). No
// gateway, no DB — these assert the identity/rehydration/ranking invariants
// the route relies on.

import { describe, expect, it } from 'vitest'

import type { AgentWasteObservation } from '../../shared/contracts/api/agentWaste.js'
import { AgentWasteClusterSchema } from '../../shared/contracts/api/agentWaste.js'
import {
  MAX_CLUSTER_LABEL_CHARS,
  buildKeyedClusterInput,
  buildDeterministicBaseline,
  buildRefinementUnits,
  compareClustersByWaste,
  normalizeTokens,
  occurrenceIdentity,
  rehydrateClusters,
  type RawClusterModelOutput,
} from './clusterBacklog.js'

function obs(overrides: Partial<AgentWasteObservation> = {}): AgentWasteObservation {
  return {
    time: '2026-07-06T00:00:00Z',
    kind: 'tool_footgun',
    id: 'x',
    ...overrides,
  }
}

describe('buildKeyedClusterInput', () => {
  it('assigns 0-based keys and omits the waste estimates (rank is server-side)', () => {
    const keyed = buildKeyedClusterInput([
      obs({ id: 'a', note: 'n', severity: 'high', repo: 'o/r', estimated_wasted_tokens: 99 }),
      obs({ id: 'b' }),
    ])
    expect(keyed[0]).toEqual({ key: 0, kind: 'tool_footgun', id: 'a', severity: 'high', repo: 'o/r', note: 'n' })
    expect(keyed[1]).toEqual({ key: 1, kind: 'tool_footgun', id: 'b' })
    // No waste fields leak into the prompt payload.
    expect(JSON.stringify(keyed)).not.toContain('estimated_wasted')
  })
})

describe('deterministic baseline', () => {
  it('splits every adjacent letter/digit transition and preserves numeric occurrence order', () => {
    expect([...normalizeTokens('v2beta 12pack')]).toEqual(['v', '2', 'beta', '12', 'pack'])
    const duplicate = obs({ id: 'same', note: 'byte identical' })
    expect([10, 2, 1].sort((a, b) => occurrenceIdentity(duplicate, a) < occurrenceIdentity(duplicate, b) ? -1 : 1))
      .toEqual([1, 2, 10])
  })

  it('joins at Jaccard 0.60 but not immediately below it', () => {
    const observations = [
      obs({ kind: 'ka', id: 'ia', note: 'one two three four five six' }),
      obs({ kind: 'kb', id: 'ib', note: 'one two three four five six' }),
      obs({ kind: 'kc', id: 'ic', note: 'one two three four five' }),
    ]
    expect(buildDeterministicBaseline(observations).components.map((component) => component.keys))
      .toEqual([[0, 1], [2]])
  })

  it('normalizes, joins exact ids and threshold matches, and preserves duplicate occurrences', () => {
    const observations = [
      obs({ kind: 'ToolFootgun', id: 'RG-12', note: 'Alpha beta gamma delta epsilon zeta eta theta iota kappa' }),
      obs({ kind: 'tool_footgun', id: 'other', note: 'alpha beta gamma delta epsilon zeta eta theta iota kappa' }),
      obs({ kind: 'ToolFootgun', id: 'RG-12', note: 'byte duplicate' }),
      obs({ kind: 'solo', id: 'one', note: 'unrelated words only' }),
    ]
    const baseline = buildDeterministicBaseline(observations)
    expect(baseline.components.map((component) => component.keys)).toEqual([[0, 1, 2], [3]])
    expect(baseline.clusters[0]).toMatchObject({
      label: 'tool_footgun:other', count: 3, provenance: 'deterministic',
    })
    expect(baseline.unclustered).toEqual([observations[3]])
    expect(baseline.clusters[0].members).toHaveLength(3)
  })

  it('packs whole components and skips one oversized component', () => {
    const duplicate = Array.from({ length: 201 }, (_, index) => obs({ id: 'same', time: `t${index}` }))
    const units = buildRefinementUnits(buildDeterministicBaseline(duplicate).components)
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ index: 0, oversized: true })
    expect(units[0].keys).toHaveLength(201)
  })
})

describe('rehydrateClusters', () => {
  it('groups by returned keys and preserves the coverage invariant', () => {
    const observations = [obs({ id: 'a' }), obs({ id: 'b' }), obs({ id: 'c' })]
    const raw: RawClusterModelOutput = {
      clusters: [{ label: 'dup', primaryKey: 0, memberKeys: [0, 1] }],
    }
    const { clusters, unclustered } = rehydrateClusters(observations, raw)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].members.map((m) => m.id)).toEqual(['a', 'b'])
    expect(clusters[0].count).toBe(2)
    expect(clusters[0].primary.id).toBe('a')
    expect(unclustered.map((o) => o.id)).toEqual(['c'])
    const covered = clusters.reduce((n, c) => n + c.members.length, 0) + unclustered.length
    expect(covered).toBe(observations.length)
  })

  it('drops hallucinated / out-of-range keys', () => {
    const observations = [obs({ id: 'a' }), obs({ id: 'b' })]
    const raw: RawClusterModelOutput = {
      clusters: [{ label: 'x', primaryKey: 0, memberKeys: [0, 5, -1, 1] }],
    }
    const { clusters, unclustered } = rehydrateClusters(observations, raw)
    expect(clusters[0].members.map((m) => m.id)).toEqual(['a', 'b'])
    expect(unclustered).toHaveLength(0)
  })

  it('de-duplicates keys within a cluster', () => {
    const observations = [obs({ id: 'a' }), obs({ id: 'b' })]
    const raw: RawClusterModelOutput = {
      clusters: [{ label: 'x', primaryKey: 0, memberKeys: [0, 0, 1, 1] }],
    }
    const { clusters } = rehydrateClusters(observations, raw)
    expect(clusters[0].members.map((m) => m.id)).toEqual(['a', 'b'])
    expect(clusters[0].count).toBe(2)
  })

  it('gives a duplicated cross-cluster key to the first cluster only', () => {
    const observations = [obs({ id: 'a' }), obs({ id: 'b' }), obs({ id: 'c' })]
    const raw: RawClusterModelOutput = {
      clusters: [
        { label: 'first', primaryKey: 0, memberKeys: [0, 1] },
        { label: 'second', primaryKey: 1, memberKeys: [1, 2] },
      ],
    }
    const { clusters, unclustered } = rehydrateClusters(observations, raw)
    const first = clusters.find((c) => c.label === 'first')
    const second = clusters.find((c) => c.label === 'second')
    expect(first?.members.map((m) => m.id)).toEqual(['a', 'b'])
    // key 1 already consumed → second cluster keeps only key 2, and its
    // consumed primaryKey (1) falls back to the first retained member.
    expect(second?.members.map((m) => m.id)).toEqual(['c'])
    expect(second?.primary.id).toBe('c')
    expect(unclustered).toHaveLength(0)
  })

  it('folds a valid primaryKey the model omitted from memberKeys', () => {
    const observations = [obs({ id: 'a' }), obs({ id: 'b' })]
    const raw: RawClusterModelOutput = {
      clusters: [{ label: 'x', primaryKey: 1, memberKeys: [0] }],
    }
    const { clusters } = rehydrateClusters(observations, raw)
    expect(clusters[0].members.map((m) => m.id)).toEqual(['a', 'b'])
    expect(clusters[0].primary.id).toBe('b')
  })

  it('drops a group that retains no valid keys', () => {
    const observations = [obs({ id: 'a' })]
    const raw: RawClusterModelOutput = {
      clusters: [{ label: 'ghost', primaryKey: 9, memberKeys: [7, 8] }],
    }
    const { clusters, unclustered } = rehydrateClusters(observations, raw)
    expect(clusters).toHaveLength(0)
    expect(unclustered.map((o) => o.id)).toEqual(['a'])
  })

  it('sums real waste estimates, treating missing/negative/NaN as 0', () => {
    const observations = [
      obs({ id: 'a', estimated_wasted_tokens: 100, estimated_wasted_seconds: 10 }),
      obs({ id: 'b', estimated_wasted_tokens: -5 }),
      obs({ id: 'c', estimated_wasted_tokens: Number.NaN }),
      obs({ id: 'd' }),
    ]
    const raw: RawClusterModelOutput = {
      clusters: [{ label: 'x', primaryKey: 0, memberKeys: [0, 1, 2, 3] }],
    }
    const { clusters } = rehydrateClusters(observations, raw)
    expect(clusters[0].aggregateWastedTokens).toBe(100)
    expect(clusters[0].aggregateWastedSeconds).toBe(10)
  })

  it('sorts clusters descending by aggregate waste (tokens, then seconds, then count)', () => {
    const observations = [
      obs({ id: 'big', estimated_wasted_tokens: 1000 }),
      obs({ id: 'mid1', estimated_wasted_tokens: 50, estimated_wasted_seconds: 5 }),
      obs({ id: 'mid2', estimated_wasted_tokens: 50, estimated_wasted_seconds: 1 }),
      obs({ id: 'small' }),
    ]
    const raw: RawClusterModelOutput = {
      clusters: [
        { label: 'small', primaryKey: 3, memberKeys: [3] },
        { label: 'mid-lowsec', primaryKey: 2, memberKeys: [2] },
        { label: 'mid-hisec', primaryKey: 1, memberKeys: [1] },
        { label: 'big', primaryKey: 0, memberKeys: [0] },
      ],
    }
    const { clusters } = rehydrateClusters(observations, raw)
    expect(clusters.map((c) => c.label)).toEqual(['big', 'mid-hisec', 'mid-lowsec', 'small'])
  })

  it('produces clusters that satisfy the public contract (count === members.length)', () => {
    const observations = [obs({ id: 'a' }), obs({ id: 'b' })]
    const raw: RawClusterModelOutput = {
      clusters: [{ label: 'x', primaryKey: 0, memberKeys: [0, 1] }],
    }
    const { clusters } = rehydrateClusters(observations, raw)
    expect(() => AgentWasteClusterSchema.parse(clusters[0])).not.toThrow()
  })

  it('trims + caps the model label length', () => {
    const observations = [obs({ id: 'a' })]
    const raw: RawClusterModelOutput = {
      clusters: [{ label: `  ${'z'.repeat(200)}  `, primaryKey: 0, memberKeys: [0] }],
    }
    const { clusters } = rehydrateClusters(observations, raw)
    expect(clusters[0].label.length).toBeLessThanOrEqual(MAX_CLUSTER_LABEL_CHARS)
  })
})

describe('compareClustersByWaste', () => {
  it('breaks ties on count then label', () => {
    const base = { primary: obs(), members: [obs()], aggregateWastedTokens: 0, aggregateWastedSeconds: 0, provenance: 'deterministic' as const }
    const a = { ...base, label: 'b', count: 2, members: [obs(), obs()] }
    const b = { ...base, label: 'a', count: 2, members: [obs(), obs()] }
    // equal waste + equal count → explicit UTF-16 code-unit label order.
    expect(compareClustersByWaste(a, b)).toBeGreaterThan(0)
  })
})
