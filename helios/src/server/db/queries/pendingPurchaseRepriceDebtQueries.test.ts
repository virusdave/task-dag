import { describe, expect, it, vi } from 'vitest'

import { getPendingPurchaseRepriceDebt } from './pendingPurchaseRepriceDebtQueries.js'

describe('getPendingPurchaseRepriceDebt', () => {
  it('returns explicit 30-minute overdue debt and bounded identifiers', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      count: 2,
      incomplete_creation_count: 0,
      oldest_age_minutes: 31.5,
      product_ids: [7, 8],
      proposal_batch_ids: [42],
      recovery_job_ids: [],
    }] })
    await expect(getPendingPurchaseRepriceDebt({ query })).resolves.toEqual({
      count: 2,
      incompleteCreationCount: 0,
      oldestAgeMinutes: 31.5,
      overdue: true,
      productIds: [7, 8],
      proposalBatchIds: [42],
      recoveryJobIds: [],
      thresholdMinutes: 30,
    })
    const [sql, values] = query.mock.calls[0]!
    expect(sql).toContain('pendingPurchaseCreatedSku,productId')
    expect(sql).toContain('pendingPurchaseCreatedSku,repriceQueueJobId')
    expect(sql).toContain('coalesce(')
    expect(sql).not.toContain('last_apply_status')
    expect(sql).not.toContain('last_apply_request_id')
    expect(sql).toContain('catalog_group_products')
    expect(sql).toContain('limit 100')
    expect(values).toEqual([1000])
  })

  it('keeps debt below the canonical threshold hidden', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      count: 1,
      incomplete_creation_count: 1,
      oldest_age_minutes: 29.9,
      product_ids: [7],
      proposal_batch_ids: [],
      recovery_job_ids: [99],
    }] })
    expect((await getPendingPurchaseRepriceDebt({ query })).overdue).toBe(false)
  })
})
