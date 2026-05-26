import type { MetricDefSummary } from '../../shared/contracts/index.js'

import { metric as demoFlatLine } from './_demo/flat_line.js'
import { metric as demoRandomWalk } from './_demo/random_walk.js'
import { P2_METRICS } from './_stub/p2_acquisition_margins.js'
import { P3_METRICS } from './_stub/p3_basket_category_fulfillment.js'
import { P4_METRICS } from './_stub/p4_inventory.js'
import { P5_METRICS } from './_stub/p5_cashier_weather_delivery.js'
import { P6_METRICS } from './_stub/p6_customer_origin_map.js'
import { toMetricSummary, type MetricDef } from './types.js'

/**
 * The complete list of metrics Helios serves on `/metrics`.
 *
 * Adding a new metric is a two-line change:
 *   1. create `server/src/metrics/<group>/<id>.ts` exporting
 *      `export const metric: MetricDef = { … }`;
 *   2. add one `import` + one entry to the array below.
 *
 * We deliberately avoid filesystem-based auto-discovery at runtime —
 * the helios server is bundled (`tsx`/`esbuild`/`tsc --build` depending
 * on environment) and dynamic glob imports break the typechecker, the
 * SPA bundle that occasionally cross-imports server contracts, and
 * the unit tests. An explicit list is one extra line per metric and
 * has the bonus that grep-for-id Just Works.
 */
const METRICS: readonly MetricDef[] = [
  demoFlatLine,
  demoRandomWalk,
  ...P2_METRICS,
  ...P3_METRICS,
  ...P4_METRICS,
  ...P5_METRICS,
  ...P6_METRICS,
]

const METRICS_BY_ID = new Map<string, MetricDef>(METRICS.map((m) => [m.id, m]))

/**
 * Cheap sanity check at module load: every metric has a unique id and
 * its `defaultAggregation` is in `supportedAggregations`. Throws on
 * misconfiguration so the server fails to boot rather than serving
 * silently broken metric data.
 */
;(function validateRegistry() {
  const seen = new Set<string>()
  for (const m of METRICS) {
    if (seen.has(m.id)) {
      throw new Error(`metric registry: duplicate metric id ${JSON.stringify(m.id)}`)
    }
    seen.add(m.id)
    if (!m.supportedAggregations.includes(m.defaultAggregation)) {
      throw new Error(
        `metric registry: metric ${JSON.stringify(m.id)} defaultAggregation ` +
          `${JSON.stringify(m.defaultAggregation)} is not in supportedAggregations`,
      )
    }
    if (m.series.length === 0) {
      throw new Error(`metric registry: metric ${JSON.stringify(m.id)} declares no series`)
    }
  }
})()

export function listMetricSummaries(): MetricDefSummary[] {
  // Sort by group + title so the SPA can render the nav directly
  // without an extra client-side sort. Within a group we sort by
  // title for predictability; the SPA is free to re-sort.
  return METRICS.map(toMetricSummary).sort((a, b) => {
    if (a.group !== b.group) {
      return a.group.localeCompare(b.group)
    }
    return a.title.localeCompare(b.title)
  })
}

export function getMetricById(id: string): MetricDef | null {
  return METRICS_BY_ID.get(id) ?? null
}

/** Test-only: every registered MetricDef (including `query`). */
export function allMetricsForTests(): readonly MetricDef[] {
  return METRICS
}
