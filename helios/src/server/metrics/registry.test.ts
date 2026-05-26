import { describe, expect, it } from 'vitest'

import { MetricDefSummarySchema } from '../../shared/contracts/index.js'

import { allMetricsForTests, getMetricById, listMetricSummaries } from './registry.js'
import { toMetricSummary } from './types.js'

describe('metric registry', () => {
  it('exposes at least the two P0 demo metrics', () => {
    const summaries = listMetricSummaries()
    const ids = summaries.map((s) => s.id)
    expect(ids).toContain('_demo.flat_line')
    expect(ids).toContain('_demo.random_walk')
  })

  it('sorts summaries by group then title for stable nav rendering', () => {
    const summaries = listMetricSummaries()
    for (let i = 1; i < summaries.length; i += 1) {
      const prev = summaries[i - 1]
      const cur = summaries[i]
      if (prev.group === cur.group) {
        expect(prev.title.localeCompare(cur.title)).toBeLessThanOrEqual(0)
      } else {
        expect(prev.group.localeCompare(cur.group)).toBeLessThanOrEqual(0)
      }
    }
  })

  it('produces summaries that satisfy the public schema', () => {
    for (const summary of listMetricSummaries()) {
      const parsed = MetricDefSummarySchema.safeParse(summary)
      expect(parsed.success, JSON.stringify(parsed)).toBe(true)
    }
  })

  it('getMetricById round-trips registered metrics and returns null for unknowns', () => {
    for (const metric of allMetricsForTests()) {
      expect(getMetricById(metric.id)).toBe(metric)
    }
    expect(getMetricById('not.a.real.metric')).toBeNull()
  })

  it('every metric defaultAggregation is in its supportedAggregations', () => {
    for (const metric of allMetricsForTests()) {
      expect(metric.supportedAggregations).toContain(metric.defaultAggregation)
    }
  })

  it('toMetricSummary drops the server-only `query` field', () => {
    const [first] = allMetricsForTests()
    expect(first).toBeDefined()
    const summary = toMetricSummary(first!)
    expect(summary).not.toHaveProperty('query')
  })
})
