import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../pool.js'
import {
  UPSERT_CHUNK_SIZE,
  bulkUpsertGscDailyRows,
  getGscQueryGaps,
  getTopGscQueries,
} from './seoMetricsQueries.js'
import type { GscDailyInput } from '../../seo/metricsImport.js'

interface Call {
  text: string
  params: unknown[] | undefined
}

/**
 * Mock db whose query() records each call and returns the rows produced by
 * `respond(callIndex)` (default: empty), letting a test simulate the
 * `returning (xmax = 0) as inserted` shape per chunk.
 */
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

function gscRow(i: number): GscDailyInput {
  return {
    row_key: `${i}`.padStart(64, '0'),
    property: 'sc-domain:freshlybaked.nyc',
    site: 'all',
    source_date: '2026-06-01',
    source_timezone: 'America/Los_Angeles',
    bucket_date_ny: '2026-06-01',
    search_type: 'web',
    device: 'all',
    country: 'all',
    query: `q${i}`,
    page_url: `https://freshlybaked.nyc/${i}`,
    clicks: i,
    impressions: i * 10,
    position: 1 + i,
  }
}

describe('bulkUpsertGscDailyRows', () => {
  it('is a no-op for an empty batch', async () => {
    const { db, calls } = mockDb()
    const counts = await bulkUpsertGscDailyRows(db, 'seoimp_x', [])
    expect(calls).toHaveLength(0)
    expect(counts).toEqual({ inserted: 0, updated: 0, unchanged: 0 })
  })

  it('upserts in chunks of UPSERT_CHUNK_SIZE', async () => {
    const rows = Array.from({ length: UPSERT_CHUNK_SIZE + 5 }, (_, i) => gscRow(i))
    const { db, calls } = mockDb()
    await bulkUpsertGscDailyRows(db, 'seoimp_x', rows)
    expect(calls).toHaveLength(2)
    // 16 columns per row → chunk 1 binds CHUNK_SIZE*16 params, chunk 2 binds 5*16.
    expect(calls[0]!.params).toHaveLength(UPSERT_CHUNK_SIZE * 16)
    expect(calls[1]!.params).toHaveLength(5 * 16)
  })

  it('uses ON CONFLICT (row_key) DO UPDATE with an IS DISTINCT FROM write guard', async () => {
    const { db, calls } = mockDb()
    await bulkUpsertGscDailyRows(db, 'seoimp_x', [gscRow(1)])
    const sql = calls[0]!.text
    expect(sql).toContain('on conflict (row_key) do update set')
    expect(sql).toContain('is distinct from excluded.clicks')
    expect(sql).toContain('is distinct from excluded.impressions')
    expect(sql).toContain('is distinct from excluded.position')
    expect(sql).toContain('returning (xmax = 0) as inserted')
    // first_import_batch_id must NOT be in the UPDATE set (insert-only).
    expect(sql).not.toContain('first_import_batch_id = excluded')
  })

  it('classifies returned rows as inserted/updated and the rest as unchanged', async () => {
    const rows = [gscRow(1), gscRow(2), gscRow(3)]
    // Simulate: 1 insert (xmax=0), 1 update (xmax!=0), 1 unchanged (not returned).
    const { db } = mockDb(() => [{ inserted: true }, { inserted: false }])
    const counts = await bulkUpsertGscDailyRows(db, 'seoimp_x', rows)
    expect(counts).toEqual({ inserted: 1, updated: 1, unchanged: 1 })
  })

  it('binds the batch id to both first_ and last_import_batch_id on insert', async () => {
    const { db, calls } = mockDb()
    await bulkUpsertGscDailyRows(db, 'seoimp_b', [gscRow(7)])
    const params = calls[0]!.params!
    // columns: row_key, first_import_batch_id, last_import_batch_id, ...
    expect(params[1]).toBe('seoimp_b')
    expect(params[2]).toBe('seoimp_b')
  })
})

describe('aggregation queries', () => {
  it('getTopGscQueries bounds by site + date window + limit and coerces numerics', async () => {
    const { db, calls } = mockDb(() => [
      { query: 'weed', clicks: '5', impressions: '100', ctr: '0.05', avg_position: '3.2' },
    ])
    const out = await getTopGscQueries(db, {
      site: 'all',
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      limit: 25,
    })
    expect(calls[0]!.params).toEqual(['all', '2026-06-01', '2026-06-08', 25])
    expect(calls[0]!.text).toContain('group by query')
    expect(calls[0]!.text).toContain('sum(position * impressions)')
    expect(out[0]).toEqual({
      query: 'weed',
      clicks: 5,
      impressions: 100,
      ctr: 0.05,
      avgPosition: 3.2,
    })
  })

  it('getGscQueryGaps passes the gap thresholds and uses a HAVING filter', async () => {
    const { db, calls } = mockDb(() => [])
    await getGscQueryGaps(db, {
      site: 'all',
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      minImpressions: 100,
      maxCtr: 0.02,
      maxPosition: 20,
      limit: 50,
    })
    expect(calls[0]!.text).toContain('having sum(impressions) >=')
    expect(calls[0]!.params).toEqual(['all', '2026-06-01', '2026-06-08', 100, 0.02, 20, 50])
  })
})
