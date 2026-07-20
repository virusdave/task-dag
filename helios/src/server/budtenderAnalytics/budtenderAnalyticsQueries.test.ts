import { afterEach, describe, expect, it, vi } from 'vitest'

import * as poolModule from '../db/pool.js'
import { getBudtenderAnalytics, MISSING_DATA_CARDS } from './budtenderAnalyticsQueries.js'

describe('budtender review analytics', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exposes only captured matched, non-fraudulent cashier review aggregates', async () => {
    const fakePool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{
          cashier_user_id: '9988',
          cashier_full_name: 'Test Cashier',
          transactions: 4,
          sales: 200,
          subtotal: 180,
          tax: 20,
          discount: 5,
          active_days: 2,
        }] })
        .mockResolvedValueOnce({ rows: [{
          cashier_user_id: '9988', cashier_full_name: 'Test Cashier',
          review_count: 5, average_star_rating: 4.2,
          classified_review_count: 4, lukewarm_negative_count: 2,
        }, {
          cashier_user_id: 'review-only', cashier_full_name: null,
          review_count: 1, average_star_rating: 5,
          classified_review_count: 0, lukewarm_negative_count: 0,
        }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    }
    vi.spyOn(poolModule, 'getPool').mockReturnValue(fakePool as unknown as ReturnType<typeof poolModule.getPool>)

    const result = await getBudtenderAnalytics({
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-20T00:00:00.000Z'),
      sites: [],
    })

    expect(result.reviewCashiers[0]).toEqual({
      cashierId: '9988',
      cashierName: 'Test Cashier',
      reviewCount: 5,
      averageStarRating: 4.2,
      classifiedReviewCount: 4,
      lukewarmOrNegativeCount: 2,
      lukewarmOrNegativeRate: 0.5,
    })
    const analyticsSql = String(fakePool.query.mock.calls[2]?.[0])
    expect(analyticsSql).toContain("invoice_match_status = 'matched'")
    expect(analyticsSql).toContain('fraud_marked = false')
    expect(analyticsSql).toContain('rs.created_at >= $2')
    expect(result.reviewCashiers[1]).toMatchObject({
      cashierId: 'review-only',
      classifiedReviewCount: 0,
      lukewarmOrNegativeRate: null,
    })
    expect(MISSING_DATA_CARDS.map((card) => card.id)).not.toContain('transaction-reviews')
  })
})
