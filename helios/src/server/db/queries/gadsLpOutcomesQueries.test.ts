import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../pool.js'
import {
  GADS_LP_GROUP_LIMIT,
  GADS_LP_TOP_PAGES_LIMIT,
  getGadsLpOutcomes,
} from './gadsLpOutcomesQueries.js'

// ---------------------------------------------------------------------------
// Query-layer tests for the P6 LP-evolver reaction read path. The site
// predicate is derived SERVER-SIDE from the validated scope (P1/P2 access
// invariant): per-site -> `site = $key` (which excludes unknown-scope NULL
// rows); 'all' -> no site filter. These tests assert the SQL/params enforce
// that, plus the aggregate shaping (truncation caps, observed/pending split,
// single-ingest flag, honest empty state).
// ---------------------------------------------------------------------------

interface Recorded {
  text: string
  params: unknown[] | undefined
}

function mockDb(rows: {
  totals?: Record<string, unknown>[]
  groups?: Record<string, unknown>[]
  pages?: Record<string, unknown>[]
}): { db: Queryable; calls: Recorded[] } {
  const calls: Recorded[] = []
  const db: Queryable = {
    async query<TResult extends QueryResultRow>(text: string, params?: unknown[]) {
      calls.push({ text, params })
      let out: Record<string, unknown>[] = []
      if (text.includes('distinct_created_days')) out = rows.totals ?? [{}]
      else if (text.includes('landing_page_key')) out = rows.pages ?? []
      else out = rows.groups ?? []
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

describe('getGadsLpOutcomes — access / site predicate', () => {
  it('derives `site = $1` for a per-site scope and binds the scope key', async () => {
    const { db, calls } = mockDb({})
    await getGadsLpOutcomes({ scope: 'bronx', db })
    const lpCalls = calls.filter((c) => /from\s+landingpage_ad_outcomes/i.test(c.text))
    expect(lpCalls.length).toBe(3)
    for (const c of lpCalls) {
      expect(c.text).toMatch(/and site = \$\d/)
      expect(c.params).toContain('bronx')
      expect(c.params).not.toContain('midtown')
      expect(c.params).not.toContain('all')
    }
  })

  it("emits NO site filter for the cross-site 'all' scope", async () => {
    const { db, calls } = mockDb({})
    await getGadsLpOutcomes({ scope: 'all', db })
    const lpCalls = calls.filter((c) => /from\s+landingpage_ad_outcomes/i.test(c.text))
    expect(lpCalls.length).toBe(3)
    for (const c of lpCalls) {
      expect(c.text).not.toMatch(/and site = \$/)
      expect(c.params).not.toContain('all')
    }
  })

  it('binds midtown for the midtown scope', async () => {
    const { db, calls } = mockDb({})
    await getGadsLpOutcomes({ scope: 'midtown', db })
    const lpCalls = calls.filter((c) => /from\s+landingpage_ad_outcomes/i.test(c.text))
    for (const c of lpCalls) {
      expect(c.params).toContain('midtown')
      expect(c.params).not.toContain('bronx')
    }
  })
})

describe('getGadsLpOutcomes — shaping', () => {
  it('honest empty state when the table is empty under the scope', async () => {
    const { db } = mockDb({
      totals: [
        {
          total_rows: '0',
          observed_rows: '0',
          avg_confidence: null,
          first_created_at: null,
          last_created_at: null,
          first_observed_at: null,
          last_observed_at: null,
          distinct_created_days: '0',
        },
      ],
    })
    const res = await getGadsLpOutcomes({ scope: 'all', db })
    expect(res.available).toBe(false)
    expect(res.totalRows).toBe(0)
    expect(res.pendingRows).toBe(0)
    expect(res.avgConfidence).toBeNull()
    expect(res.singleIngest).toBe(false)
    expect(res.byGroup).toEqual([])
    expect(res.topLandingPages).toEqual([])
  })

  it('derives pending = total - observed and flags a single-day ingest', async () => {
    const { db } = mockDb({
      totals: [
        {
          total_rows: '63',
          observed_rows: '20',
          avg_confidence: 0.4231,
          first_created_at: '2026-05-31T12:32:42.000Z',
          last_created_at: '2026-05-31T12:32:42.000Z',
          first_observed_at: '2026-06-01T00:00:00.000Z',
          last_observed_at: '2026-06-02T00:00:00.000Z',
          distinct_created_days: '1',
        },
      ],
    })
    const res = await getGadsLpOutcomes({ scope: 'all', db })
    expect(res.available).toBe(true)
    expect(res.totalRows).toBe(63)
    expect(res.observedRows).toBe(20)
    expect(res.pendingRows).toBe(43)
    expect(res.avgConfidence).toBeCloseTo(0.4231, 4)
    expect(res.singleIngest).toBe(true)
    expect(res.firstCreatedAt).toBe('2026-05-31T12:32:42.000Z')
    expect(res.lastOutcomeObservedAt).toBe('2026-06-02T00:00:00.000Z')
  })

  it('multi-day data is NOT flagged single-ingest', async () => {
    const { db } = mockDb({
      totals: [{ total_rows: '10', observed_rows: '5', distinct_created_days: '3' }],
    })
    const res = await getGadsLpOutcomes({ scope: 'all', db })
    expect(res.singleIngest).toBe(false)
  })

  it('caps group rows at the limit and reports truncation', async () => {
    const groups = Array.from({ length: GADS_LP_GROUP_LIMIT + 1 }, (_, i) => ({
      signal_type: `sig_${i}`,
      planned_action: 'observe',
      outcome_status: 'pending_observation',
      count: String(GADS_LP_GROUP_LIMIT + 1 - i),
      avg_confidence: 0.5,
    }))
    const { db } = mockDb({
      totals: [{ total_rows: '100', observed_rows: '0', distinct_created_days: '2' }],
      groups,
    })
    const res = await getGadsLpOutcomes({ scope: 'all', db })
    expect(res.byGroup.length).toBe(GADS_LP_GROUP_LIMIT)
    expect(res.byGroupTruncated).toBe(true)
    expect(res.byGroup[0]).toEqual({
      signalType: 'sig_0',
      plannedAction: 'observe',
      outcomeStatus: 'pending_observation',
      count: GADS_LP_GROUP_LIMIT + 1,
      avgConfidence: 0.5,
    })
  })

  it('caps top landing pages at the limit and reports truncation', async () => {
    const pages = Array.from({ length: GADS_LP_TOP_PAGES_LIMIT + 1 }, (_, i) => ({
      landing_page_key: `lp_${i}`,
      count: String(GADS_LP_TOP_PAGES_LIMIT + 1 - i),
      observed: '1',
      pending: '0',
    }))
    const { db } = mockDb({
      totals: [{ total_rows: '50', observed_rows: '11', distinct_created_days: '2' }],
      pages,
    })
    const res = await getGadsLpOutcomes({ scope: 'all', db })
    expect(res.topLandingPages.length).toBe(GADS_LP_TOP_PAGES_LIMIT)
    expect(res.topLandingPagesTruncated).toBe(true)
    expect(res.topLandingPages[0].landingPageKey).toBe('lp_0')
  })

  it('uses landing_page_key and never selects raw final_url', async () => {
    const { db, calls } = mockDb({})
    await getGadsLpOutcomes({ scope: 'all', db })
    const pageCall = calls.find((c) => c.text.includes('landing_page_key'))
    expect(pageCall).toBeDefined()
    expect(pageCall?.text).not.toMatch(/final_url/)
  })
})
