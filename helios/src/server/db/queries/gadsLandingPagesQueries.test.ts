import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../pool.js'
import { getGadsLandingPages } from './gadsLandingPagesQueries.js'

/**
 * Fake Queryable that records every statement and dispatches canned rows
 * by matching the SQL text. The serving path issues exactly two reads:
 * the rollup variant aggregate and the singleton refresh-state row.
 */
function mockDb(handlers: {
  variantRows: Record<string, unknown>[]
  stateRows: Record<string, unknown>[]
}): { db: Queryable; calls: Array<{ text: string; params: unknown[] | undefined }> } {
  const calls: Array<{ text: string; params: unknown[] | undefined }> = []
  const db: Queryable = {
    async query<TResult extends QueryResultRow>(text: string, params?: unknown[]) {
      calls.push({ text, params })
      const isState = text.includes('gads_lp_rollup_refresh_state')
      const rows = (isState ? handlers.stateRows : handlers.variantRows) as unknown as TResult[]
      return {
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: rows.length,
        rows,
      } as QueryResult<TResult>
    },
  }
  return { db, calls }
}

function variantRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    site: 'bronx',
    family: 'delivery',
    experiment_id: null,
    policy_rule_id: 'rule-1',
    branch_id: '1',
    assignments: '100',
    impressions: '80',
    redirects: '40',
    conversions_30d: '10',
    sum_served_prob_bps: '500000',
    assignments_with_prob: '100',
    has_allocated: false,
    has_unavailable: true,
    ...over,
  }
}

const STATE_OK = [{ assignments_missing_id: '3', unattributed_stage_events: '7' }]

describe('getGadsLandingPages (P3 — rollup-backed serving path)', () => {
  it('never queries lp_events on the serving path', async () => {
    const { db, calls } = mockDb({ variantRows: [variantRow()], stateRows: STATE_OK })
    await getGadsLandingPages({ scope: 'bronx', db })
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.text).not.toMatch(/lp_events/)
    }
    // And it must read the rollup + the refresh-state row.
    expect(calls.some((c) => /from\s+gads_lp_rollup\b/i.test(c.text))).toBe(true)
    expect(calls.some((c) => c.text.includes('gads_lp_rollup_refresh_state'))).toBe(true)
  })

  it('aggregates the funnel + KPIs from the rollup variant rows', async () => {
    const { db } = mockDb({
      variantRows: [
        variantRow({ branch_id: '1', assignments: '100', impressions: '80', redirects: '40', conversions_30d: '10' }),
        variantRow({ branch_id: '2', assignments: '100', impressions: '60', redirects: '20', conversions_30d: '5' }),
      ],
      stateRows: STATE_OK,
    })
    const res = await getGadsLandingPages({ scope: 'bronx', db })

    expect(res.kpis.assignments).toBe(200)
    // converted/assignments = 15/200
    expect(res.kpis.conversionRate).toBeCloseTo(15 / 200)
    // impressed/assignments = 140/200
    expect(res.kpis.impressionRate).toBeCloseTo(140 / 200)
    // redirected/impressed = 60/140
    expect(res.kpis.redirectRate).toBeCloseTo(60 / 140)

    const funnel = Object.fromEntries(res.funnel.map((s) => [s.stage, s.count]))
    expect(funnel).toEqual({ assigned: 200, impressed: 140, redirected: 60, converted: 15 })

    // Money KPIs stay null (not wired in V1).
    expect(res.kpis.adSpend).toBeNull()
    expect(res.kpis.roas).toBeNull()
    expect(res.kpis.cpa).toBeNull()
  })

  it('maps cost_attribution_status to the response enum honestly', async () => {
    // All unavailable -> not-wired.
    const a = await getGadsLandingPages({
      scope: 'bronx',
      db: mockDb({ variantRows: [variantRow({ has_allocated: false, has_unavailable: true })], stateRows: STATE_OK }).db,
    })
    expect(a.attributionStatus).toBe('not-wired')

    // Mixed -> incomplete.
    const b = await getGadsLandingPages({
      scope: 'bronx',
      db: mockDb({
        variantRows: [
          variantRow({ has_allocated: true, has_unavailable: false }),
          variantRow({ branch_id: '2', has_allocated: false, has_unavailable: true }),
        ],
        stateRows: STATE_OK,
      }).db,
    })
    expect(b.attributionStatus).toBe('incomplete')

    // All allocated -> allocated.
    const c = await getGadsLandingPages({
      scope: 'bronx',
      db: mockDb({ variantRows: [variantRow({ has_allocated: true, has_unavailable: false })], stateRows: STATE_OK }).db,
    })
    expect(c.attributionStatus).toBe('allocated')
  })

  it('surfaces data-quality from the refresh-state row (not lp_events)', async () => {
    const res = await getGadsLandingPages({
      scope: 'bronx',
      db: mockDb({ variantRows: [variantRow()], stateRows: STATE_OK }).db,
    })
    expect(res.dataQuality.assignmentsMissingId).toBe(3)
    expect(res.dataQuality.unattributedStageEvents).toBe(7)
  })

  it('computes per-variant avg served probability from sum / count-with-prob', async () => {
    const res = await getGadsLandingPages({
      scope: 'bronx',
      db: mockDb({
        variantRows: [variantRow({ sum_served_prob_bps: '500000', assignments_with_prob: '100' })],
        stateRows: STATE_OK,
      }).db,
    })
    // 500000 / 100 = 5000 bps = 0.5
    expect(res.variants[0]?.avgServedProbability).toBeCloseTo(0.5)
  })

  it("scopes 'all' to every gads site and passes the site list as a param", async () => {
    const { db, calls } = mockDb({ variantRows: [variantRow()], stateRows: STATE_OK })
    const res = await getGadsLandingPages({ scope: 'all', db })
    expect(res.sites.length).toBeGreaterThan(1)
    const variantCall = calls.find((c) => /from\s+gads_lp_rollup\b/i.test(c.text))
    expect(variantCall?.params?.[2]).toEqual(res.sites)
  })
})
