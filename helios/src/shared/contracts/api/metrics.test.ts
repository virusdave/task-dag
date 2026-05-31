import { describe, expect, it } from 'vitest'

import {
  MetricQueryRequestSchema,
  MetricSelectionSchema,
} from './metrics.js'

// v1.4 V4'4: the drill-selection contract is the share-link surface
// for "click a histogram bucket / scatter dot, copy the URL, get the
// same drilled state back". These tests pin the wire shape so a typo
// in MetricSelectionSchema or the JSON-string decoder in
// MetricQueryRequestSchema gets caught before the SPA silently drops
// a drilled state from a shared URL.

describe('MetricSelectionSchema', () => {
  it('parses a histogramBucket selection', () => {
    const parsed = MetricSelectionSchema.parse({
      kind: 'histogramBucket',
      metricId: 'customer-value.purchase_count',
      bucketKey: '3',
    })
    expect(parsed).toEqual({
      kind: 'histogramBucket',
      metricId: 'customer-value.purchase_count',
      bucketKey: '3',
    })
  })

  it('parses a scatterDot selection', () => {
    const parsed = MetricSelectionSchema.parse({
      kind: 'scatterDot',
      metricId: 'weather.scatter_margin_vs_high_temp',
      dotId: 'midtown|2026-04-01',
    })
    expect(parsed.kind).toBe('scatterDot')
  })

  it('rejects an unknown kind', () => {
    expect(() =>
      MetricSelectionSchema.parse({
        kind: 'mysteryKind',
        metricId: 'm',
        bucketKey: '1',
      }),
    ).toThrow()
  })

  it('rejects a histogramBucket selection missing bucketKey', () => {
    expect(() =>
      MetricSelectionSchema.parse({
        kind: 'histogramBucket',
        metricId: 'm',
      }),
    ).toThrow()
  })

  it('rejects a scatterDot selection missing dotId', () => {
    expect(() =>
      MetricSelectionSchema.parse({
        kind: 'scatterDot',
        metricId: 'm',
      }),
    ).toThrow()
  })

  it('rejects an empty metricId', () => {
    expect(() =>
      MetricSelectionSchema.parse({
        kind: 'histogramBucket',
        metricId: '',
        bucketKey: '1',
      }),
    ).toThrow()
  })
})

describe('MetricQueryRequestSchema.selection', () => {
  // The `selection` query param is a JSON-encoded MetricSelection
  // (lives in the URL as `?selection={"kind":"…",…}`). The decoder
  // unwraps the JSON before handing to MetricSelectionSchema.

  it('treats missing selection as undefined', () => {
    const parsed = MetricQueryRequestSchema.parse({})
    expect(parsed.selection).toBeUndefined()
  })

  it('treats empty selection as undefined (forms post empty strings)', () => {
    const parsed = MetricQueryRequestSchema.parse({ selection: '' })
    expect(parsed.selection).toBeUndefined()
  })

  it('parses a JSON-encoded scatterDot selection', () => {
    const parsed = MetricQueryRequestSchema.parse({
      selection: JSON.stringify({
        kind: 'scatterDot',
        metricId: 'weather.scatter_margin_vs_high_temp',
        dotId: 'midtown|2026-04-01',
      }),
    })
    expect(parsed.selection).toEqual({
      kind: 'scatterDot',
      metricId: 'weather.scatter_margin_vs_high_temp',
      dotId: 'midtown|2026-04-01',
    })
  })

  it('parses a JSON-encoded histogramBucket selection', () => {
    const parsed = MetricQueryRequestSchema.parse({
      selection: JSON.stringify({
        kind: 'histogramBucket',
        metricId: 'customer-value.purchase_count',
        bucketKey: 'overflow',
      }),
    })
    expect(parsed.selection?.kind).toBe('histogramBucket')
  })

  it('rejects an unparseable JSON selection', () => {
    expect(() => MetricQueryRequestSchema.parse({ selection: '{not json' })).toThrow(
      /selection must be JSON/,
    )
  })

  it('rejects a selection whose shape doesn\'t match the discriminated union', () => {
    expect(() =>
      MetricQueryRequestSchema.parse({
        selection: JSON.stringify({ kind: 'mystery', metricId: 'm' }),
      }),
    ).toThrow(/selection does not match MetricSelectionSchema/)
  })
})
