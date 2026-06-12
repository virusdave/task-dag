// Pure SEO recommendation engine (P5 — parent epic virusdave/top-level#15,
// child epic FreshlyBakedNYC/automation#44).
//
// Turns aggregated GSC metrics into DRAFT recommendations for an operator.
// Everything here is PURE + deterministic (no DB, no clock-of-record) so it
// is fully unit-tested. The DB upsert/list/decide layer lives in
// db/queries/seoRecommendationQueries.ts; routes live in
// routes/seoRecommendation.ts.
//
// IRONCLAD human gate (canon §1): a recommendation is a SUGGESTION, never
// published content. Accepting one only creates a DRAFT that still has to
// pass the existing human approve→bundle gate. Nothing here publishes.

import { createHash } from 'node:crypto'

import type { GscQueryGap } from '../db/queries/seoMetricsQueries.js'

export type RecType = 'faq_gap' | 'low_ctr_title'

export interface RecommendationDraft {
  readonly recommendation_id: string
  readonly rec_type: RecType
  readonly site: string
  readonly target_query: string | null
  readonly target_page_url: string | null
  readonly title: string
  readonly rationale: Record<string, unknown>
  readonly priority: number
}

/** A high-impression / low-CTR page (title/meta-revision candidate). */
export interface LowCtrPage {
  readonly pageUrl: string
  readonly clicks: number
  readonly impressions: number
  readonly ctr: number
  readonly avgPosition: number | null
}

/**
 * Deterministic recommendation id `seorec_<type>_<16 hex>` over
 * (site, rec_type, target) so re-running the generator collapses onto the
 * same row (the upsert is then write-on-change / decision-preserving).
 */
export function recommendationId(site: string, recType: RecType, target: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([site, recType, target]), 'utf8')
    .digest('hex')
    .slice(0, 16)
  return `seorec_${recType}_${hex}`
}

function pct(ctr: number): string {
  return `${(ctr * 100).toFixed(1)}%`
}

function pos(avgPosition: number | null): string {
  return avgPosition === null ? '—' : avgPosition.toFixed(1)
}

/**
 * A faq_gap recommendation for a (query, page) the site ranks for but
 * under-converts on — a candidate for a dedicated FAQ answer. Priority is
 * the impression volume (highest-impact first).
 */
export function faqGapRecommendation(site: string, gap: GscQueryGap): RecommendationDraft {
  return {
    recommendation_id: recommendationId(site, 'faq_gap', `${gap.query}\n${gap.pageUrl}`),
    rec_type: 'faq_gap',
    site,
    target_query: gap.query,
    target_page_url: gap.pageUrl,
    title:
      `Answer "${gap.query}" — ${gap.impressions} impressions, ` +
      `${pct(gap.ctr)} CTR, avg pos ${pos(gap.avgPosition)}`,
    rationale: {
      kind: 'faq_gap',
      query: gap.query,
      page_url: gap.pageUrl,
      clicks: gap.clicks,
      impressions: gap.impressions,
      ctr: gap.ctr,
      avg_position: gap.avgPosition,
    },
    priority: gap.impressions,
  }
}

/**
 * A low_ctr_title recommendation for a page that gets impressions but few
 * clicks — a candidate for a title/meta-description revision.
 */
export function lowCtrTitleRecommendation(site: string, page: LowCtrPage): RecommendationDraft {
  return {
    recommendation_id: recommendationId(site, 'low_ctr_title', page.pageUrl),
    rec_type: 'low_ctr_title',
    site,
    target_query: null,
    target_page_url: page.pageUrl,
    title:
      `Revise title/meta for ${page.pageUrl} — ${page.impressions} impressions, ` +
      `${pct(page.ctr)} CTR, avg pos ${pos(page.avgPosition)}`,
    rationale: {
      kind: 'low_ctr_title',
      page_url: page.pageUrl,
      clicks: page.clicks,
      impressions: page.impressions,
      ctr: page.ctr,
      avg_position: page.avgPosition,
    },
    priority: page.impressions,
  }
}

export interface BuildRecommendationsInput {
  readonly gaps: readonly GscQueryGap[]
  readonly lowCtrPages: readonly LowCtrPage[]
}

/**
 * Build the full draft recommendation set for a site from the aggregated
 * inputs. De-duplicated by recommendation_id (a query/page can in principle
 * surface in more than one feeder); the FIRST occurrence wins.
 */
export function buildRecommendations(
  site: string,
  input: BuildRecommendationsInput,
): RecommendationDraft[] {
  const byId = new Map<string, RecommendationDraft>()
  for (const gap of input.gaps) {
    const rec = faqGapRecommendation(site, gap)
    if (!byId.has(rec.recommendation_id)) {
      byId.set(rec.recommendation_id, rec)
    }
  }
  for (const page of input.lowCtrPages) {
    const rec = lowCtrTitleRecommendation(site, page)
    if (!byId.has(rec.recommendation_id)) {
      byId.set(rec.recommendation_id, rec)
    }
  }
  return [...byId.values()]
}
