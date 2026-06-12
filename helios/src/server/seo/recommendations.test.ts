import { describe, expect, it } from 'vitest'

import {
  buildRecommendations,
  faqGapRecommendation,
  lowCtrTitleRecommendation,
  recommendationId,
  type LowCtrPage,
} from './recommendations.js'
import type { GscQueryGap } from '../db/queries/seoMetricsQueries.js'

function gap(overrides: Partial<GscQueryGap> = {}): GscQueryGap {
  return {
    query: 'weed delivery nyc',
    pageUrl: 'https://freshlybaked.nyc/sites/all/whats-new/x',
    clicks: 2,
    impressions: 800,
    ctr: 0.0025,
    avgPosition: 8.4,
    ...overrides,
  }
}

function page(overrides: Partial<LowCtrPage> = {}): LowCtrPage {
  return {
    pageUrl: 'https://freshlybaked.nyc/sites/all/whats-new/y',
    clicks: 5,
    impressions: 1200,
    ctr: 0.0042,
    avgPosition: 4.1,
    ...overrides,
  }
}

describe('recommendationId', () => {
  it('is deterministic and well-formed', () => {
    const a = recommendationId('all', 'faq_gap', 'q\np')
    expect(a).toBe(recommendationId('all', 'faq_gap', 'q\np'))
    expect(a).toMatch(/^seorec_faq_gap_[0-9a-f]{16}$/)
  })

  it('differs by site, type, and target', () => {
    expect(recommendationId('all', 'faq_gap', 't')).not.toBe(
      recommendationId('site1', 'faq_gap', 't'),
    )
    expect(recommendationId('all', 'faq_gap', 't')).not.toBe(
      recommendationId('all', 'low_ctr_title', 't'),
    )
    expect(recommendationId('all', 'faq_gap', 't')).not.toBe(
      recommendationId('all', 'faq_gap', 'u'),
    )
  })
})

describe('faqGapRecommendation', () => {
  it('maps the gap into a faq_gap draft with impression-volume priority', () => {
    const rec = faqGapRecommendation('all', gap())
    expect(rec.rec_type).toBe('faq_gap')
    expect(rec.site).toBe('all')
    expect(rec.target_query).toBe('weed delivery nyc')
    expect(rec.target_page_url).toBe('https://freshlybaked.nyc/sites/all/whats-new/x')
    expect(rec.priority).toBe(800)
    expect(rec.title).toContain('weed delivery nyc')
    expect(rec.title).toContain('800 impressions')
    expect(rec.rationale).toMatchObject({ kind: 'faq_gap', impressions: 800, avg_position: 8.4 })
    expect(rec.recommendation_id).toBe(
      recommendationId('all', 'faq_gap', `${gap().query}\n${gap().pageUrl}`),
    )
  })

  it('renders a null average position as an em dash', () => {
    expect(faqGapRecommendation('all', gap({ avgPosition: null })).title).toContain('avg pos —')
  })
})

describe('lowCtrTitleRecommendation', () => {
  it('maps a page into a low_ctr_title draft keyed on the page only', () => {
    const rec = lowCtrTitleRecommendation('all', page())
    expect(rec.rec_type).toBe('low_ctr_title')
    expect(rec.target_query).toBeNull()
    expect(rec.target_page_url).toBe('https://freshlybaked.nyc/sites/all/whats-new/y')
    expect(rec.priority).toBe(1200)
    expect(rec.recommendation_id).toBe(recommendationId('all', 'low_ctr_title', page().pageUrl))
  })
})

describe('buildRecommendations', () => {
  it('combines feeders and de-dupes by recommendation_id', () => {
    const recs = buildRecommendations('all', {
      gaps: [gap(), gap({ query: 'gummies nyc', impressions: 300 })],
      lowCtrPages: [page()],
    })
    expect(recs).toHaveLength(3)
    expect(recs.filter((r) => r.rec_type === 'faq_gap')).toHaveLength(2)
    expect(recs.filter((r) => r.rec_type === 'low_ctr_title')).toHaveLength(1)
  })

  it('keeps the first occurrence when a feeder repeats an id', () => {
    const recs = buildRecommendations('all', {
      gaps: [gap({ impressions: 800 }), gap({ impressions: 999 })], // same query+page → same id
      lowCtrPages: [],
    })
    expect(recs).toHaveLength(1)
    expect(recs[0]!.priority).toBe(800)
  })
})
