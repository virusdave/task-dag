import { describe, expect, it, vi } from 'vitest'

import {
  executeMarketEvidenceAlarmScan,
  isCandidateFreshness,
  planAlarmScanEnqueue,
  type AlarmScanDependencies,
  type FreshnessRow,
} from './configWorkersMarketEvidenceAlarmScanJob.js'
import type { EnqueueMarketRefreshResult } from '../litalerts/enqueueMarketRefresh.js'

function row(overrides: Partial<FreshnessRow> & { productId: number }): FreshnessRow {
  return {
    brandName: null,
    alarmClass: null,
    freshness: 'fresh',
    capturedAt: new Date('2026-05-17T11:00:00Z'),
    expiresAt: new Date('2026-05-21T11:00:00Z'),
    ...overrides,
  }
}

interface FakeDepsState {
  candidates: FreshnessRow[]
  siblings: Map<string, FreshnessRow[]>
  enqueueCalls: Array<{ productIds: number[]; trigger: unknown; priority?: number; alarmClass?: unknown }>
  pages: string[]
  audits: Array<Parameters<AlarmScanDependencies['appendAudit']>[0]>
  enqueueResult: (productIds: number[]) => EnqueueMarketRefreshResult
}

function buildFakeDeps(state: FakeDepsState): AlarmScanDependencies {
  return {
    loadCandidates: async () => state.candidates,
    loadSiblingsByBrand: async () => state.siblings,
    enqueue: async (productIds, options) => {
      state.enqueueCalls.push({
        productIds,
        trigger: options.trigger,
        priority: options.priority,
        alarmClass: options.alarmClass,
      })
      return state.enqueueResult(productIds)
    },
    page: async (message) => {
      state.pages.push(message)
    },
    appendAudit: async (input) => {
      state.audits.push(input)
    },
  }
}

function defaultState(rows: FreshnessRow[], siblings: Map<string, FreshnessRow[]> = new Map()): FakeDepsState {
  return {
    candidates: rows,
    siblings,
    enqueueCalls: [],
    pages: [],
    audits: [],
    enqueueResult: (productIds) => ({
      enqueuedQueueRowIds: productIds.map((_, idx) => idx + 1),
      enqueuedJobIds: productIds.map((_, idx) => 1000 + idx),
      skippedCount: 0,
    }),
  }
}

const NOW = new Date('2026-05-17T12:00:00Z')

describe('isCandidateFreshness', () => {
  it('treats absent capture as a candidate', () => {
    expect(isCandidateFreshness(row({ productId: 1, capturedAt: null, freshness: 'absent', expiresAt: null }), NOW)).toBe(true)
  })

  it('treats expiring-within-12h as a candidate', () => {
    expect(
      isCandidateFreshness(
        row({ productId: 1, freshness: 'fresh', expiresAt: new Date('2026-05-17T20:00:00Z') }),
        NOW,
      ),
    ).toBe(true)
  })

  it('treats already-stale (very_stale/expired) as candidates', () => {
    expect(
      isCandidateFreshness(
        row({ productId: 1, freshness: 'very_stale', expiresAt: new Date('2026-06-01T00:00:00Z') }),
        NOW,
      ),
    ).toBe(true)
  })

  it('ignores fresh evidence with far-future expiry', () => {
    expect(
      isCandidateFreshness(
        row({ productId: 1, freshness: 'fresh', expiresAt: new Date('2026-05-25T00:00:00Z') }),
        NOW,
      ),
    ).toBe(false)
  })

  it('treats a 5-day-old observation as "stale" (not very_stale) under a 7-day per-brand expiry override', () => {
    // Per-brand expiry overrides are evaluated inside
    // vw_pricing_evidence_freshness (migration 012/013). The scanner
    // simply reads whatever freshness label the view produces. So a
    // brand with expiry_days=7 + a 5-day-old capture surfaces here as
    // `freshness: 'stale'` — and the scanner must NOT treat that as a
    // candidate (matching the default-cadence 4-day behavior).
    const fiveDayOld: FreshnessRow = row({
      productId: 1,
      brandName: 'BrandWith7DayWindow',
      freshness: 'stale',
      capturedAt: new Date('2026-05-12T12:00:00Z'),
      expiresAt: new Date('2026-05-19T12:00:00Z'),
    })
    expect(isCandidateFreshness(fiveDayOld, NOW)).toBe(false)
  })
})

describe('planAlarmScanEnqueue', () => {
  it('returns no batches when nothing alarms', () => {
    const plan = planAlarmScanEnqueue([], new Map())
    expect(plan.byClass).toEqual([])
  })

  it('groups by alarm_class and emits one call per non-brand class', () => {
    const candidates: FreshnessRow[] = [
      row({ productId: 10, brandName: 'BrandA', alarmClass: 'in_stock', freshness: 'expired' }),
      row({ productId: 11, brandName: 'BrandA', alarmClass: 'in_stock', freshness: 'expired' }),
      row({ productId: 20, brandName: 'BrandB', alarmClass: 'pending_purchase', freshness: 'absent', capturedAt: null }),
    ]
    const plan = planAlarmScanEnqueue(candidates, new Map())
    expect(plan.byClass.map((batch) => batch.alarmClass)).toEqual(['in_stock', 'pending_purchase'])

    const inStock = plan.byClass.find((b) => b.alarmClass === 'in_stock')!
    expect(inStock.productIds).toEqual([10, 11])
    expect(inStock.brandNames).toEqual(['BrandA'])
    expect(inStock.enqueueCalls).toEqual([
      { productIds: [10, 11], trigger: { kind: 'in-stock-alarm' } },
    ])

    const pending = plan.byClass.find((b) => b.alarmClass === 'pending_purchase')!
    expect(pending.productIds).toEqual([20])
    expect(pending.enqueueCalls).toEqual([
      { productIds: [20], trigger: { kind: 'pending-purchase' } },
    ])
  })

  it('emits one enqueue call per brand for brand_match alarms', () => {
    const candidates: FreshnessRow[] = [
      row({ productId: 30, brandName: 'BrandX', alarmClass: 'brand_match', freshness: 'expired' }),
      row({ productId: 31, brandName: 'BrandY', alarmClass: 'brand_match', freshness: 'expired' }),
    ]
    const plan = planAlarmScanEnqueue(candidates, new Map())
    const brandBatch = plan.byClass.find((b) => b.alarmClass === 'brand_match')!
    expect(brandBatch.enqueueCalls).toEqual([
      { productIds: [30], trigger: { kind: 'brand-alarm', brandName: 'BrandX' } },
      { productIds: [31], trigger: { kind: 'brand-alarm', brandName: 'BrandY' } },
    ])
  })

  it('expands an in-stock alarm with same-brand non-fresh siblings', () => {
    const candidates: FreshnessRow[] = [
      row({ productId: 100, brandName: 'BrandA', alarmClass: 'in_stock', freshness: 'expired' }),
    ]
    const siblings = new Map<string, FreshnessRow[]>([
      [
        'BrandA',
        [
          row({ productId: 100, brandName: 'BrandA', freshness: 'expired' }),
          row({ productId: 101, brandName: 'BrandA', freshness: 'stale' }),
          row({ productId: 102, brandName: 'BrandA', freshness: 'fresh' }), // excluded
          row({ productId: 103, brandName: 'BrandA', freshness: 'very_stale' }),
        ],
      ],
    ])
    const plan = planAlarmScanEnqueue(candidates, siblings)
    const inStock = plan.byClass.find((b) => b.alarmClass === 'in_stock')!
    expect(inStock.productIds).toEqual([100, 101, 103])
    expect(inStock.pageMessage).toMatch(/^in_stock market-evidence alarm: 3 products \(1 brands\)/)
  })

  it('caps sibling expansion at BRAND_SIBLING_CAP per brand', () => {
    const candidates: FreshnessRow[] = [
      row({ productId: 1, brandName: 'BrandHuge', alarmClass: 'in_stock', freshness: 'expired' }),
    ]
    const huge: FreshnessRow[] = []
    for (let i = 2; i < 200; i += 1) {
      huge.push(row({ productId: i, brandName: 'BrandHuge', freshness: 'stale' }))
    }
    const plan = planAlarmScanEnqueue(candidates, new Map([['BrandHuge', huge]]))
    const inStock = plan.byClass.find((b) => b.alarmClass === 'in_stock')!
    // 1 alarm product + 50 admitted siblings.
    expect(inStock.productIds.length).toBe(51)
  })
})

describe('executeMarketEvidenceAlarmScan', () => {
  it('all-fresh scan does not enqueue or page', async () => {
    const state = defaultState([])
    const result = await executeMarketEvidenceAlarmScan(
      { trigger: 'scheduled', requestedByUserId: null },
      buildFakeDeps(state),
      NOW,
    )
    expect(result.totalEnqueued).toBe(0)
    expect(state.enqueueCalls).toEqual([])
    expect(state.pages).toEqual([])
    expect(state.audits).toHaveLength(1)
    expect(state.audits[0]?.totalEnqueued).toBe(0)
    expect(state.audits[0]?.enqueuedByClass).toEqual({ in_stock: 0, pending_purchase: 0, brand_match: 0 })
  })

  it('two expired in-stock products enqueue at priority=0 but do NOT page (in_stock is silent)', async () => {
    const state = defaultState([
      row({ productId: 10, brandName: 'BrandA', alarmClass: 'in_stock', freshness: 'expired' }),
      row({ productId: 11, brandName: 'BrandA', alarmClass: 'in_stock', freshness: 'expired' }),
    ])
    const result = await executeMarketEvidenceAlarmScan(
      { trigger: 'scheduled', requestedByUserId: null },
      buildFakeDeps(state),
      NOW,
    )
    expect(state.enqueueCalls).toHaveLength(1)
    expect(state.enqueueCalls[0]?.productIds).toEqual([10, 11])
    expect(state.enqueueCalls[0]?.priority).toBe(0)
    expect(state.enqueueCalls[0]?.alarmClass).toBe('in_stock')
    expect(state.enqueueCalls[0]?.trigger).toEqual({ kind: 'in-stock-alarm' })
    // in_stock is a NON_PAGING_ALARM_CLASS: we still re-enqueue, but the
    // operator is not paged (the page was pure noise).
    expect(state.pages).toEqual([])
    expect(result.totalEnqueued).toBe(2)
    expect(result.pagedClasses).toEqual([])
  })

  it('absent pending-purchase product enqueues + pages with the pending_purchase message', async () => {
    const state = defaultState([
      row({
        productId: 77,
        brandName: 'BrandZ',
        alarmClass: 'pending_purchase',
        freshness: 'absent',
        capturedAt: null,
        expiresAt: null,
      }),
    ])
    await executeMarketEvidenceAlarmScan(
      { trigger: 'scheduled', requestedByUserId: null },
      buildFakeDeps(state),
      NOW,
    )
    expect(state.enqueueCalls).toEqual([
      {
        productIds: [77],
        trigger: { kind: 'pending-purchase' },
        priority: 0,
        alarmClass: 'pending_purchase',
      },
    ])
    expect(state.pages).toHaveLength(1)
    expect(state.pages[0]).toMatch(/^pending_purchase market-evidence alarm/)
  })

  it('brand-match expansion includes same-brand siblings on the in-stock class', async () => {
    const state = defaultState(
      [row({ productId: 200, brandName: 'BrandM', alarmClass: 'in_stock', freshness: 'expired' })],
      new Map([
        [
          'BrandM',
          [
            row({ productId: 200, brandName: 'BrandM', freshness: 'expired' }),
            row({ productId: 201, brandName: 'BrandM', freshness: 'stale' }),
            row({ productId: 202, brandName: 'BrandM', freshness: 'very_stale' }),
          ],
        ],
      ]),
    )
    await executeMarketEvidenceAlarmScan(
      { trigger: 'scheduled', requestedByUserId: null },
      buildFakeDeps(state),
      NOW,
    )
    expect(state.enqueueCalls).toHaveLength(1)
    expect(state.enqueueCalls[0]?.productIds).toEqual([200, 201, 202])
    expect(state.enqueueCalls[0]?.alarmClass).toBe('in_stock')
    // in_stock no longer pages; sibling expansion still feeds the enqueue.
    expect(state.pages).toEqual([])
  })

  it('filters out alarm rows whose freshness does not warrant a refresh', async () => {
    const state = defaultState([
      row({
        productId: 1,
        brandName: 'BrandFresh',
        alarmClass: 'in_stock',
        freshness: 'fresh',
        expiresAt: new Date('2026-05-25T00:00:00Z'),
      }),
    ])
    const result = await executeMarketEvidenceAlarmScan(
      { trigger: 'scheduled', requestedByUserId: null },
      buildFakeDeps(state),
      NOW,
    )
    expect(state.enqueueCalls).toEqual([])
    expect(state.pages).toEqual([])
    expect(result.totalEnqueued).toBe(0)
  })

  it('emits an audit event recording per-class totals', async () => {
    const state = defaultState([
      row({ productId: 10, brandName: 'BrandA', alarmClass: 'in_stock', freshness: 'expired' }),
      row({ productId: 77, brandName: 'BrandZ', alarmClass: 'pending_purchase', freshness: 'absent', capturedAt: null, expiresAt: null }),
    ])
    await executeMarketEvidenceAlarmScan(
      { trigger: 'manual', requestedByUserId: 42 },
      buildFakeDeps(state),
      NOW,
    )
    expect(state.audits).toHaveLength(1)
    expect(state.audits[0]).toMatchObject({
      enqueuedByClass: { in_stock: 1, pending_purchase: 1, brand_match: 0 },
      totalEnqueued: 2,
      trigger: 'manual',
      requestedByUserId: 42,
    })
  })

  it('pages exactly once for a paging class that fires', async () => {
    const state = defaultState([
      row({
        productId: 77,
        brandName: 'BrandZ',
        alarmClass: 'pending_purchase',
        freshness: 'absent',
        capturedAt: null,
        expiresAt: null,
      }),
    ])
    await executeMarketEvidenceAlarmScan(
      { trigger: 'scheduled', requestedByUserId: null },
      buildFakeDeps(state),
      NOW,
    )
    expect(state.pages).toHaveLength(1)
    expect(state.pages[0]).toMatch(/^pending_purchase/)
  })

  it('survives a page failure by surfacing the error (no silent swallow)', async () => {
    const state = defaultState([
      row({
        productId: 77,
        brandName: 'BrandZ',
        alarmClass: 'pending_purchase',
        freshness: 'absent',
        capturedAt: null,
        expiresAt: null,
      }),
    ])
    const deps = buildFakeDeps(state)
    const failingDeps: AlarmScanDependencies = {
      ...deps,
      page: vi.fn(async () => {
        throw new Error('page-dave not available')
      }),
    }
    await expect(
      executeMarketEvidenceAlarmScan(
        { trigger: 'scheduled', requestedByUserId: null },
        failingDeps,
        NOW,
      ),
    ).rejects.toThrow(/page-dave/)
  })
})
