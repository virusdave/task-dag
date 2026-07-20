import { describe, expect, it, vi } from 'vitest'

import { insertReviewSubmission } from './customerReviewsQueries.js'

const AT = new Date('2026-07-20T12:00:00.000Z')

describe('review route transaction attribution query', () => {
  it('uses the canonical cancelled filter and persists explicit unmatched', async () => {
    const db = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'id', created_at: AT }] }) }
    await insertReviewSubmission(db, {
      dealerId: 210705, starRating: 5, reviewText: null, submissionKind: 'form',
      sourceIp: null, userAgent: null, referrer: null, rawPayload: {}, contacts: [],
      llmVerdict: 'strong-no-text', degradedPass: null, llmRaw: null,
      llmModelRef: null, llmAt: null, reviewProviderUrl: null,
    })
    const sql = String(db.query.mock.calls[0]?.[0])
    expect(sql).toContain("interval '30 minutes'")
    expect(sql).toContain("interval '4 minutes'")
    expect(sql).toContain("<> 'cancelled'")
    expect(sql).toContain('order by abs(extract(epoch from (pay_time - $2::timestamptz))), pay_time, invoice_id')
    expect(db.query.mock.calls[1]?.[1]?.slice(15)).toEqual(['unmatched', null, null, null])
  })
})
