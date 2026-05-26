import { describe, expect, it } from 'vitest'

import { REAL_METRIC_IDS } from '../_real/realMetrics.js'
import { allMetricsForTests } from '../registry.js'

describe('missing-data (stub) metrics', () => {
  it('every spec-listed metric id is present in the registry', () => {
    const ids = new Set(allMetricsForTests().map((m) => m.id))
    const expected = [
      // P2
      'acquisition.first_vs_returning',
      'margins.effective_gm_pct',
      'margins.gross_margin_dollars',
      'margins.stack_new_vs_returning',
      // P3
      'basket.size_by_fulfillment',
      'basket.size_by_customer_type',
      'category.sales_stack_dollars',
      'category.sales_stack_fraction',
      'category.margin_dollars_stack',
      'fulfillment.order_count',
      'fulfillment.sales_dollars',
      'fulfillment.margin_dollars',
      'fulfillment.effective_gm_pct',
      'payment.order_count',
      'payment.sales_dollars',
      // P4
      'inventory.cost_distribution',
      'inventory.misalignment',
      'slowmovers.cost_at_risk',
      'lowstock.upcoming_outs',
      // P5
      'cashier.transactions_per_hour',
      'weather.scatter_margin_vs_high_temp',
      'weather.scatter_margin_vs_low_temp',
      'weather.scatter_margin_vs_precip',
      'delivery.order_count_by_zone',
      'delivery.margin_pct',
      // P6
      'customers.origin_map',
    ]
    for (const id of expected) {
      expect(ids).toContain(id)
    }
  })

  it('no demo metric ids leak into the registry — operator never wants demo data', () => {
    for (const metric of allMetricsForTests()) {
      expect(metric.id.startsWith('_demo.'), `unexpected demo metric ${metric.id}`).toBe(false)
      expect(metric.dataStatus, `metric ${metric.id} must not be tagged demo`).not.toBe('demo')
    }
  })

  it('every pending metric returns ZERO rows — we do not make data up', async () => {
    const from = new Date('2025-01-01T00:00:00Z')
    const to = new Date('2025-01-08T00:00:00Z')
    for (const metric of allMetricsForTests()) {
      if (REAL_METRIC_IDS.has(metric.id)) continue
      const data = await metric.query({ sites: [], from, to, agg: 'date' })
      expect(data, `pending metric ${metric.id} emitted synthetic rows`).toEqual([])
    }
  })

  it('every pending metric carries dataStatus=pending so the UI can label it MISSING DATA', () => {
    for (const metric of allMetricsForTests()) {
      if (REAL_METRIC_IDS.has(metric.id)) continue
      expect(metric.dataStatus, `metric ${metric.id} should be pending`).toBe('pending')
    }
  })

  it('no pending metric description leaks the legacy STUB: prefix', () => {
    for (const metric of allMetricsForTests()) {
      expect(metric.description.startsWith('STUB:'), `metric ${metric.id} still has STUB prefix`).toBe(false)
    }
  })
})
