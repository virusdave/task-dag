import { describe, expect, it } from 'vitest'

import {
  assessBudtenderStaffCache,
  BUDTENDER_STAFF_CACHE_MAX_AGE_MS,
} from './budtenderAnalyticsQueries.js'

const NOW = Date.parse('2026-07-20T16:00:00.000Z')

describe('assessBudtenderStaffCache', () => {
  it('requests a refresh for an unknown attributed cashier when the directory is stale', () => {
    expect(
      assessBudtenderStaffCache(
        [{ cashierName: null }],
        new Date(NOW - BUDTENDER_STAFF_CACHE_MAX_AGE_MS).toISOString(),
        NOW,
      ),
    ).toBe('budtender_cashier_missing')
  })

  it('requests a refresh for stale cached cashier names', () => {
    expect(
      assessBudtenderStaffCache(
        [{ cashierName: 'Old Cached Name' }],
        new Date(NOW - BUDTENDER_STAFF_CACHE_MAX_AGE_MS).toISOString(),
        NOW,
      ),
    ).toBe('budtender_cache_stale')
  })

  it('bounds missing-cashier refreshes while the directory is fresh', () => {
    expect(
      assessBudtenderStaffCache(
        [{ cashierName: null }],
        new Date(NOW - BUDTENDER_STAFF_CACHE_MAX_AGE_MS + 1).toISOString(),
        NOW,
      ),
    ).toBeNull()
  })
})
