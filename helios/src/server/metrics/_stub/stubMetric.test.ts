import { describe, expect, it } from 'vitest'

import { allMetricsForTests } from '../registry.js'

describe('stub metrics', () => {
  it('every spec-listed metric id is present in the registry', () => {
    const ids = new Set(allMetricsForTests().map((m) => m.id))
    const expected = [
      // Demo
      '_demo.flat_line',
      '_demo.random_walk',
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

  it('every stub query returns at least one row for a 7-day window at agg=date', async () => {
    const from = new Date('2025-01-01T00:00:00Z')
    const to = new Date('2025-01-08T00:00:00Z')
    for (const metric of allMetricsForTests()) {
      if (!metric.description.startsWith('STUB:')) continue
      const data = await metric.query({ sites: [], from, to, agg: 'date' })
      expect(data.length, `metric ${metric.id} emitted no rows`).toBeGreaterThan(0)
      // Every row has a `t` plus every declared series id as a numeric.
      for (const row of data) {
        expect(typeof row.t).toBe('string')
        for (const s of metric.series) {
          const v = row[s.id]
          expect(typeof v, `metric ${metric.id} series ${s.id} non-numeric`).toBe('number')
        }
      }
    }
  })

  it('every stub description starts with the STUB prefix so reviewers can tell at a glance', () => {
    for (const metric of allMetricsForTests()) {
      // _demo metrics are the only non-stubs that are also non-real.
      // They have their own clear demo title and don't need the prefix.
      if (metric.id.startsWith('_demo.')) continue
      expect(metric.description, `metric ${metric.id} missing STUB prefix`).toMatch(/^STUB:/)
    }
  })
})
