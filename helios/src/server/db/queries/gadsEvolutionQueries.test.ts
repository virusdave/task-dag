import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../pool.js'
import {
  GADS_EVOLUTION_HOTSPOT_LIMIT,
  GADS_EVOLUTION_LOW_SAMPLE_THRESHOLD,
  getGadsEvolution,
} from './gadsEvolutionQueries.js'

// ---------------------------------------------------------------------------
// Query-layer tests for the Evolution serving path. The site predicate is
// derived SERVER-SIDE from the validated scope (P1/P2 access invariant):
// per-site -> `site = $key` (which excludes unknown-scope NULL rows);
// 'all' -> no site filter. These tests assert the SQL/params enforce that
// and that the aggregate math is correct.
// ---------------------------------------------------------------------------

interface Recorded {
  text: string
  params: unknown[] | undefined
}

/** Dispatches canned rows by matching distinctive SQL fragments so each of
 *  the six aggregate queries gets the right shape. */
function mockDb(rows: {
  matrix?: Record<string, unknown>[]
  extras?: Record<string, unknown>[]
  stuck?: Record<string, unknown>[]
  prior?: Record<string, unknown>[]
  weekly?: Record<string, unknown>[]
  hotspots?: Record<string, unknown>[]
}): { db: Queryable; calls: Recorded[] } {
  const calls: Recorded[] = []
  const db: Queryable = {
    async query<TResult extends QueryResultRow>(text: string, params?: unknown[]) {
      calls.push({ text, params })
      let out: Record<string, unknown>[] = []
      if (text.includes('stuck_ads')) out = rows.stuck ?? [{ stuck_ads: '0' }]
      else if (text.includes('median_latency_hours')) out = rows.extras ?? [{}]
      else if (text.includes('week_start')) out = rows.weekly ?? []
      else if (text.includes('failed_repairs')) out = rows.hotspots ?? []
      else if (text.includes('as proposed')) out = rows.matrix ?? []
      else out = rows.prior ?? [{}] // the prior-window query (no group by)
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

function matrixRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    action_type: 'repair',
    proposed: '0',
    observed: '0',
    success: '0',
    partial: '0',
    no_change: '0',
    worse: '0',
    superseded: '0',
    ad_disappeared: '0',
    open: '0',
    ...over,
  }
}

describe('getGadsEvolution — access / site predicate', () => {
  it("derives `site = $3` for a per-site scope and binds the scope key", async () => {
    const { db, calls } = mockDb({ matrix: [matrixRow()] })
    await getGadsEvolution({ scope: 'bronx', db })
    // Every gads_ad_attempts query must carry the per-site predicate and
    // bind 'bronx' — never an unfiltered cross-site read.
    const attemptCalls = calls.filter((c) => /from\s+gads_ad_attempts/i.test(c.text))
    expect(attemptCalls.length).toBeGreaterThan(0)
    for (const c of attemptCalls) {
      expect(c.text).toMatch(/and site = \$\d/)
      expect(c.params).toContain('bronx')
      // A per-site read must NOT widen to other sites or expose NULL rows.
      expect(c.params).not.toContain('midtown')
      expect(c.params).not.toContain('all')
    }
  })

  it("emits NO site filter for the cross-site 'all' scope", async () => {
    const { db, calls } = mockDb({ matrix: [matrixRow()] })
    const res = await getGadsEvolution({ scope: 'all', db })
    const attemptCalls = calls.filter((c) => /from\s+gads_ad_attempts/i.test(c.text))
    for (const c of attemptCalls) {
      expect(c.text).not.toMatch(/and site = /)
      expect(c.params).not.toContain('bronx')
      expect(c.params).not.toContain('midtown')
    }
    expect(res.sites.length).toBeGreaterThan(1)
  })

  it('buckets the weekly sparkline in NY local time, not UTC', async () => {
    const { db, calls } = mockDb({ matrix: [matrixRow()] })
    await getGadsEvolution({ scope: 'midtown', db })
    const weeklyCall = calls.find((c) => c.text.includes('week_start'))
    expect(weeklyCall?.text).toMatch(/America\/New_York/)
  })
})

describe('getGadsEvolution — heartbeat + loop-health math', () => {
  it('computes the learning score, coverage, and rates from the matrix', async () => {
    // repair: 4 success, 2 partial, 2 no_change, 2 worse, 1 superseded,
    //         1 ad_disappeared, 3 open  => proposed 15, observed 12.
    const { db } = mockDb({
      matrix: [
        matrixRow({
          action_type: 'repair',
          proposed: '15',
          observed: '12',
          success: '4',
          partial: '2',
          no_change: '2',
          worse: '2',
          superseded: '1',
          ad_disappeared: '1',
          open: '3',
        }),
      ],
      prior: [{ success: '0', partial: '0', worse: '0', gradeable: '0' }],
    })
    const res = await getGadsEvolution({ scope: 'bronx', db })

    // gradeable = success+partial+no_change+worse = 10
    expect(res.heartbeat.gradeableObserved).toBe(10)
    // score = (4 + 0.5*2 - 2) / 10 = 3/10
    expect(res.heartbeat.score).toBeCloseTo(0.3)
    expect(res.heartbeat.proposed).toBe(15)
    expect(res.heartbeat.terminalObserved).toBe(12)
    // coverage = observed/proposed = 12/15
    expect(res.heartbeat.coverage).toBeCloseTo(12 / 15)
    // prior had no gradeable => null => delta null
    expect(res.heartbeat.priorScore).toBeNull()
    expect(res.heartbeat.delta).toBeNull()

    // net improvement = (success+partial)/observed = 6/12
    expect(res.loopHealth.netImprovementRate).toBeCloseTo(6 / 12)
    // waste = (no_change+worse+superseded)/observed = (2+2+1)/12
    expect(res.loopHealth.wasteShare).toBeCloseTo(5 / 12)
    expect(res.loopHealth.open).toBe(3)
  })

  it('returns null score (not 0) and lowSample when there are no gradeable outcomes', async () => {
    const { db } = mockDb({ matrix: [matrixRow({ proposed: '5', open: '5' })] })
    const res = await getGadsEvolution({ scope: 'bronx', db })
    expect(res.heartbeat.score).toBeNull()
    expect(res.heartbeat.gradeableObserved).toBe(0)
    expect(res.heartbeat.lowSample).toBe(true)
    expect(res.loopHealth.netImprovementRate).toBeNull()
  })

  it('computes prior-window delta when both windows have gradeable data', async () => {
    const { db } = mockDb({
      matrix: [matrixRow({ proposed: '4', observed: '4', success: '4', no_change: '0' })],
      // current gradeable=4, score=(4-0)/4=1
      prior: [{ success: '1', partial: '0', worse: '1', gradeable: '4' }],
      // prior score = (1 - 1)/4 = 0
    })
    const res = await getGadsEvolution({ scope: 'bronx', db })
    expect(res.heartbeat.score).toBeCloseTo(1)
    expect(res.heartbeat.priorScore).toBeCloseTo(0)
    expect(res.heartbeat.delta).toBeCloseTo(1)
  })

  it('zero-fills every action type in a stable order in the matrix', async () => {
    const { db } = mockDb({ matrix: [matrixRow({ action_type: 'pause', proposed: '3' })] })
    const res = await getGadsEvolution({ scope: 'bronx', db })
    expect(res.actionOutcomeMatrix.map((r) => r.actionType)).toEqual([
      'repair',
      'replace',
      'pause',
      'monitor',
      'trial_control',
      'trial_variant',
    ])
    const pause = res.actionOutcomeMatrix.find((r) => r.actionType === 'pause')
    expect(pause?.proposed).toBe(3)
    const repair = res.actionOutcomeMatrix.find((r) => r.actionType === 'repair')
    expect(repair?.proposed).toBe(0)
  })

  it('coerces unexpected action_type to monitor in SQL so totals never drop dirty rows', async () => {
    // gads_ad_attempts.action_type is write-constrained to the six enum
    // values, but if a dirty row ever appears the matrix SQL must fold it
    // into 'monitor' (case ... else 'monitor') rather than grouping the raw
    // value, which would silently drop it from the headline totals.
    const { db, calls } = mockDb({
      matrix: [matrixRow({ action_type: 'monitor', proposed: '4', observed: '4', success: '4' })],
    })
    const res = await getGadsEvolution({ scope: 'bronx', db })
    const matrixCall = calls.find((c) => c.text.includes('as proposed'))
    expect(matrixCall?.text).toMatch(/else\s+'monitor'/)
    expect(matrixCall?.text).not.toMatch(/group by action_type\b/)
    expect(res.heartbeat.proposed).toBe(4)
    expect(res.actionOutcomeMatrix.find((r) => r.actionType === 'monitor')?.proposed).toBe(4)
  })

  it('reflects the low-sample threshold boundary', async () => {
    const justBelow = GADS_EVOLUTION_LOW_SAMPLE_THRESHOLD - 1
    const { db } = mockDb({
      matrix: [matrixRow({ proposed: String(justBelow), no_change: String(justBelow) })],
    })
    const res = await getGadsEvolution({ scope: 'bronx', db })
    expect(res.heartbeat.gradeableObserved).toBe(justBelow)
    expect(res.heartbeat.lowSample).toBe(true)
  })
})

describe('getGadsEvolution — freshness + hotspots bounding', () => {
  it('marks the feed stale when the newest attempt is older than the threshold', async () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const { db } = mockDb({
      matrix: [matrixRow({ proposed: '1', open: '1' })],
      extras: [{ stale_open: '1', median_latency_hours: null, first_attempt_at: old, last_attempt_at: old }],
    })
    const res = await getGadsEvolution({ scope: 'bronx', db })
    expect(res.freshness.isStale).toBe(true)
    expect(res.freshness.lastAttemptAt).toBe(old)
    expect(res.loopHealth.staleOpen).toBe(1)
  })

  it('is not stale when the newest attempt is recent', async () => {
    const recent = new Date().toISOString()
    const { db } = mockDb({
      matrix: [matrixRow({ proposed: '1', success: '1', observed: '1' })],
      extras: [{ stale_open: '0', median_latency_hours: '12', first_attempt_at: recent, last_attempt_at: recent }],
    })
    const res = await getGadsEvolution({ scope: 'bronx', db })
    expect(res.freshness.isStale).toBe(false)
    expect(res.loopHealth.medianLatencyHours).toBeCloseTo(12)
  })

  it('truncates hotspots to the cap and flags truncation (fetches cap+1)', async () => {
    const hotspots = Array.from({ length: GADS_EVOLUTION_HOTSPOT_LIMIT + 1 }, (_, i) => ({
      ad_id: `ad-${i}`,
      campaign_name: 'c',
      ad_group_name: 'g',
      site: 'bronx',
      attempts: '5',
      failed_repairs: '4',
      success: '0',
      open: '1',
      last_attempt_at: new Date().toISOString(),
      last_outcome: 'worse',
    }))
    const { db, calls } = mockDb({ matrix: [matrixRow()], hotspots })
    const res = await getGadsEvolution({ scope: 'bronx', db })
    expect(res.hotspots.length).toBe(GADS_EVOLUTION_HOTSPOT_LIMIT)
    expect(res.hotspotsTruncated).toBe(true)
    // The hotspot query must request cap+1 to detect truncation.
    const hotspotCall = calls.find((c) => c.text.includes('failed_repairs'))
    expect(hotspotCall?.params).toContain(GADS_EVOLUTION_HOTSPOT_LIMIT + 1)
  })

  it('coerces an unknown last_outcome to null (contract-safe)', async () => {
    const { db } = mockDb({
      matrix: [matrixRow()],
      hotspots: [
        {
          ad_id: 'ad-x',
          campaign_name: null,
          ad_group_name: null,
          site: null,
          attempts: '3',
          failed_repairs: '3',
          success: '0',
          open: '0',
          last_attempt_at: new Date().toISOString(),
          last_outcome: 'bogus',
        },
      ],
    })
    const res = await getGadsEvolution({ scope: 'all', db })
    expect(res.hotspots[0]?.lastOutcome).toBeNull()
    expect(res.hotspots[0]?.site).toBeNull()
  })
})
