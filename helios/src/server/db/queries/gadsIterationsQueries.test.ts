import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../pool.js'
import {
  GADS_ITERATION_ATTEMPT_LIMIT,
  GADS_ITERATION_RUNS_MAX_LIMIT,
  getGadsIterationRunDetail,
  getGadsIterationRuns,
} from './gadsIterationsQueries.js'

interface Recorded {
  text: string
  params: unknown[] | undefined
}

function mockDb(dispatch: (text: string) => Record<string, unknown>[]): {
  db: Queryable
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const db: Queryable = {
    async query<TResult extends QueryResultRow>(text: string, params?: unknown[]) {
      calls.push({ text, params })
      const out = dispatch(text)
      return {
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: out.length,
        rows: out as unknown as TResult[],
      } as QueryResult<TResult>
    },
  }
  return { db, calls }
}

function runRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    run_id: 'run-2026-05-31-da854e09',
    first_attempt_at: '2026-05-31T10:00:00.000Z',
    last_attempt_at: '2026-05-31T12:00:00.000Z',
    attempts: '10',
    ads: '8',
    observed: '6',
    open: '4',
    stale_open: '4',
    a_repair: '5',
    a_replace: '0',
    a_pause: '2',
    a_monitor: '3',
    a_trial_control: '0',
    a_trial_variant: '0',
    o_success: '1',
    o_partial: '1',
    o_no_change: '2',
    o_worse: '1',
    o_superseded: '1',
    o_ad_disappeared: '0',
    ...over,
  }
}

function attemptRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: '1',
    created_at: '2026-05-31T10:00:00.000Z',
    ad_id: 'ad-1',
    campaign_name: 'Bronx Delivery',
    ad_group_name: 'bronx-ag',
    site: 'bronx',
    action_type: 'repair',
    rationale: 'fix headline',
    before_serving_status: 'not_eligible',
    before_policy_status: 'disapproved',
    before_headlines: ['old'],
    before_descriptions: ['old d'],
    before_final_url: 'https://x',
    proposed_headlines: ['new'],
    proposed_descriptions: ['new d'],
    proposed_final_url: 'https://x',
    outcome_observed_at: null,
    outcome_serving_status: null,
    outcome_policy_status: null,
    outcome: null,
    outcome_notes: null,
    ...over,
  }
}

describe('getGadsIterationRuns', () => {
  it('derives the per-site predicate + binds the scope, and caps the limit', async () => {
    const { db, calls } = mockDb(() => [runRow()])
    await getGadsIterationRuns({ scope: 'bronx', limit: 10_000, db })
    const call = calls[0]
    expect(call?.text).toMatch(/and site = \$\d/)
    expect(call?.params).toContain('bronx')
    // Requested 10_000; clamps to MAX+1 (the +1 truncation probe).
    expect(call?.params).toContain(GADS_ITERATION_RUNS_MAX_LIMIT + 1)
    expect(call?.text).toMatch(/order by max\(created_at\) desc/)
  })

  it("emits no site filter for the 'all' scope", async () => {
    const { db, calls } = mockDb(() => [runRow()])
    const res = await getGadsIterationRuns({ scope: 'all', db })
    expect(calls[0]?.text).not.toMatch(/and site = /)
    expect(calls[0]?.params).not.toContain('bronx')
    expect(res.sites.length).toBeGreaterThan(1)
  })

  it('maps per-run action + outcome counts and truncation', async () => {
    // Return limit+1 rows to trip truncation (default limit 25).
    const rows = Array.from({ length: 26 }, (_, i) => runRow({ run_id: `run-${i}` }))
    const { db } = mockDb(() => rows)
    const res = await getGadsIterationRuns({ scope: 'bronx', db })
    expect(res.truncated).toBe(true)
    expect(res.runs.length).toBe(25)
    const r = res.runs[0]
    expect(r?.attempts).toBe(10)
    expect(r?.ads).toBe(8)
    expect(r?.actionCounts.find((a) => a.actionType === 'repair')?.count).toBe(5)
    expect(r?.actionCounts.map((a) => a.actionType)).toEqual([
      'repair',
      'replace',
      'pause',
      'monitor',
      'trial_control',
      'trial_variant',
    ])
    expect(r?.outcomeCounts).toEqual({
      success: 1,
      partial: 1,
      noChange: 2,
      worse: 1,
      superseded: 1,
      adDisappeared: 0,
      open: 4,
    })
  })

  it('folds unexpected action types into the monitor bucket (SQL)', async () => {
    const { db, calls } = mockDb(() => [runRow()])
    await getGadsIterationRuns({ scope: 'bronx', db })
    // The a_monitor filter must also catch any non-enum action_type so a
    // dirty row is never omitted from actionCounts while still counted in
    // the run's `attempts` total.
    expect(calls[0]?.text).toMatch(/action_type not in/)
  })
})

describe('getGadsIterationRunDetail', () => {
  it('applies the site predicate to BOTH the summary and the attempt query', async () => {
    const { db, calls } = mockDb((text) =>
      text.includes('count(*)') && text.includes('attempts') && !text.includes('action_type,')
        ? [runRow()]
        : [attemptRow()],
    )
    await getGadsIterationRunDetail({ scope: 'bronx', runId: 'run-x', db })
    expect(calls.length).toBe(2)
    for (const c of calls) {
      expect(c.text).toMatch(/where run_id = \$1/)
      expect(c.text).toMatch(/and site = \$2/)
      expect(c.params?.[0]).toBe('run-x')
      expect(c.params).toContain('bronx')
    }
  })

  it('returns null (route -> 404, no side channel) when no rows are visible under the scope', async () => {
    // Summary aggregate over zero scoped rows: one row, attempts = 0.
    const { db } = mockDb((text) =>
      text.includes('order by created_at asc')
        ? []
        : [runRow({ attempts: '0', ads: '0', observed: '0', open: '0' })],
    )
    const res = await getGadsIterationRunDetail({ scope: 'midtown', runId: 'run-x', db })
    expect(res).toBeNull()
  })

  it('caps returned attempt rows and flags truncation (fetches cap+1)', async () => {
    const attempts = Array.from({ length: GADS_ITERATION_ATTEMPT_LIMIT + 1 }, (_, i) =>
      attemptRow({ id: String(i) }),
    )
    const { db, calls } = mockDb((text) =>
      text.includes('order by created_at asc') ? attempts : [runRow({ attempts: '500' })],
    )
    const res = await getGadsIterationRunDetail({ scope: 'all', runId: 'run-x', db })
    expect(res).not.toBeNull()
    expect(res?.attempts.length).toBe(GADS_ITERATION_ATTEMPT_LIMIT)
    expect(res?.returnedAttempts).toBe(GADS_ITERATION_ATTEMPT_LIMIT)
    expect(res?.attemptsTruncated).toBe(true)
    expect(res?.totalAttempts).toBe(500)
    const attemptCall = calls.find((c) => c.text.includes('order by created_at asc'))
    expect(attemptCall?.params).toContain(GADS_ITERATION_ATTEMPT_LIMIT + 1)
  })

  it('maps attempt rows and coerces an unknown outcome to null', async () => {
    const { db } = mockDb((text) =>
      text.includes('order by created_at asc')
        ? [attemptRow({ outcome: 'weird', site: 'queens' })]
        : [runRow()],
    )
    const res = await getGadsIterationRunDetail({ scope: 'all', runId: 'run-x', db })
    const a = res?.attempts[0]
    expect(a?.outcome).toBeNull()
    // Unknown site value coerces to null (only real keys pass through).
    expect(a?.site).toBeNull()
    expect(a?.actionType).toBe('repair')
    expect(a?.beforeHeadlines).toEqual(['old'])
    expect(a?.proposedHeadlines).toEqual(['new'])
  })
})
