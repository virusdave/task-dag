import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../pool.js'
import {
  acceptRecommendation,
  dismissRecommendation,
  listRecommendations,
  upsertRecommendations,
} from './seoRecommendationQueries.js'
import type { RecommendationDraft } from '../../seo/recommendations.js'

interface Call {
  text: string
  params: unknown[] | undefined
}

function mockDb(respond: (callIndex: number) => QueryResultRow[] = () => []): {
  db: Queryable
  calls: Call[]
} {
  const calls: Call[] = []
  const db: Queryable = {
    async query<T extends QueryResultRow>(text: string, params?: unknown[]) {
      const idx = calls.length
      calls.push({ text, params })
      const rows = respond(idx) as T[]
      return { command: '', fields: [], oid: 0, rowCount: rows.length, rows } as QueryResult<T>
    },
  }
  return { db, calls }
}

function draft(i: number): RecommendationDraft {
  return {
    recommendation_id: `seorec_faq_gap_${`${i}`.padStart(16, '0')}`,
    rec_type: 'faq_gap',
    site: 'all',
    target_query: `q${i}`,
    target_page_url: `https://freshlybaked.nyc/${i}`,
    title: `Answer q${i}`,
    rationale: { kind: 'faq_gap', impressions: i },
    priority: i,
  }
}

describe('upsertRecommendations', () => {
  it('is a no-op for an empty list', async () => {
    const { db, calls } = mockDb()
    const counts = await upsertRecommendations(db, [])
    expect(calls).toHaveLength(0)
    expect(counts).toEqual({ inserted: 0, updated: 0, unchanged: 0 })
  })

  it('upserts with a decision-preserving, write-on-change conflict clause', async () => {
    const { db, calls } = mockDb()
    await upsertRecommendations(db, [draft(1)])
    const sql = calls[0]!.text
    expect(sql).toContain('on conflict (recommendation_id) do update set')
    expect(sql).toContain("seo_recommendations.status = 'open'")
    expect(sql).toContain('rationale is distinct from excluded.rationale')
    expect(sql).toContain('returning (xmax = 0) as inserted')
    // serializes rationale to a JSON string param (column index 7).
    expect(calls[0]!.params![6]).toBe(JSON.stringify({ kind: 'faq_gap', impressions: 1 }))
  })

  it('classifies returned rows as inserted/updated and the rest as unchanged', async () => {
    const { db } = mockDb(() => [{ inserted: true }, { inserted: false }])
    const counts = await upsertRecommendations(db, [draft(1), draft(2), draft(3)])
    expect(counts).toEqual({ inserted: 1, updated: 1, unchanged: 1 })
  })
})

describe('listRecommendations', () => {
  it('filters by site + status and orders by priority desc', async () => {
    const { db, calls } = mockDb()
    await listRecommendations(db, { site: 'all', status: 'open', limit: 50 })
    expect(calls[0]!.text).toContain('where site = $1 and status = $2')
    expect(calls[0]!.text).toContain('order by priority desc')
    expect(calls[0]!.params).toEqual(['all', 'open', 50])
  })

  it('omits the where clause when no filters are given', async () => {
    const { db, calls } = mockDb()
    await listRecommendations(db, { limit: 10 })
    expect(calls[0]!.text).not.toContain('where')
    expect(calls[0]!.params).toEqual([10])
  })
})

describe('accept / dismiss', () => {
  it('acceptRecommendation only transitions an open row and binds the link', async () => {
    const { db, calls } = mockDb(() => [])
    const out = await acceptRecommendation(db, {
      recommendationId: 'seorec_faq_gap_x',
      linkedContentKind: 'faq_set',
      linkedContentId: 'faq_123',
      userId: 7,
      note: 'go',
    })
    expect(out).toBeNull() // no row returned → was not open
    expect(calls[0]!.text).toContain("status = 'accepted'")
    expect(calls[0]!.text).toContain("where recommendation_id = $1 and status = 'open'")
    expect(calls[0]!.params).toEqual(['seorec_faq_gap_x', 'faq_set', 'faq_123', 7, 'go'])
  })

  it('dismissRecommendation guards on open status', async () => {
    const { db, calls } = mockDb(() => [])
    await dismissRecommendation(db, {
      recommendationId: 'seorec_faq_gap_x',
      userId: 7,
      note: null,
    })
    expect(calls[0]!.text).toContain("status = 'dismissed'")
    expect(calls[0]!.text).toContain("where recommendation_id = $1 and status = 'open'")
    expect(calls[0]!.params).toEqual(['seorec_faq_gap_x', 7, null])
  })
})
