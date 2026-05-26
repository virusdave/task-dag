import type { MetricDef } from '../types.js'
import { makeStubMetric } from './stubMetric.js'

// P6 metrics — customer origin map.
// STUB — see ../_stub/stubMetric.ts and the P7 runbook.
//
// `customers.origin_map` is spec'd as an OSM-tile choropleth +
// heatmap over delivery zip codes (one dot per zip, intensity =
// order count in the selected window). The real implementation
// needs a new map-mode renderer in the client and a per-zip
// aggregation in the SQL. The stub here returns a single
// total-orders-per-bucket time-series so the metric appears in the
// /metrics IA and the chart frame renders end-to-end; the map
// renderer slots in transparently once it exists.

export const P6_METRICS: ReadonlyArray<MetricDef> = [
  makeStubMetric({
    id: 'customers.origin_map',
    group: 'Customer origin',
    title: 'Customer origin map (by delivery zip)',
    description:
      'MAP PANEL. OSM-tile choropleth + heatmap, one dot per delivery zip code over the selected window, intensity = order count. Toggles: "first-time customers only", "diff vs prior window (e.g. 6 months ago)". v1 is static (no playback) — the playback follow-on is filed as a separate v2 issue per the parent EPIC.',
    series: [{ id: 'orders', label: 'Delivery orders (stub)', colour: '#2ca02c' }],
    defaultAggregation: 'week',
    range: { lo: 50, hi: 400 },
  }),
]
