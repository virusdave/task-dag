// Shared, valid SEO-bundle compile input for the seo/ test suite. Lives
// under __tests__/ so the server tsconfig excludes it from the prod build
// while the vitest specs can import it. Not a test file itself.

import type { CompileInput } from '../compile.js'

const HERO_SHA = 'a'.repeat(64)
const OG_SHA = 'b'.repeat(64)

/** A fully valid, cross-consistent FAQ-MVP + one-blog-post compile input. */
export function validCompileInput(overrides: Partial<CompileInput> = {}): CompileInput {
  const base: CompileInput = {
    sites: {
      fb_nyc: { hosts: ['freshlybaked.nyc'], mode: 'raw' },
      fb_us: { hosts: ['freshlybaked.us'], mode: 'sanitized' },
    },
    widgets: [
      {
        widget_id: 'faq_nyc',
        type: 'SEOFAQFold',
        scope: 'fb_nyc',
        enabled: true,
        route_patterns: ['/'],
        faq_set_id: 'faq_general',
      },
      {
        widget_id: 'post_widget',
        type: 'BlogPost',
        scope: 'all',
        enabled: true,
        post_id: 'post_one',
      },
    ],
    content: {
      faq_sets: [
        {
          faq_set_id: 'faq_general',
          scope: 'fb_nyc',
          approval_id: 'appr_faq',
          items: [
            {
              question: 'Hours?',
              answer_raw: 'Open daily for recreational cannabis.',
              answer_sanitized: 'Open daily.',
            },
          ],
        },
      ],
      posts: [
        {
          post_id: 'post_one',
          scope: 'all',
          slug: 'summer-drop-2026',
          title: 'Summer Drop',
          meta_description: 'New summer arrivals.',
          excerpt: 'New arrivals.',
          canonical_url: 'https://freshlybaked.nyc/sites/all/whats-new/summer-drop-2026',
          published_at: '2026-06-11T08:00:00Z',
          author: 'Editorial',
          reviewer: 'dave',
          tags: ['nyc-culture'],
          body_raw: 'Raw body about cannabis.',
          body_sanitized: 'Sanitized body.',
          hero_image_sha256: HERO_SHA,
          og_image_sha256: OG_SHA,
          approval_id: 'appr_post',
        },
      ],
      related_link_sets: [],
      heads: [],
    },
    policy: {
      seo_policy_version_id: 'seopol_test_01',
      selection_algorithm_version: 'seo-select-v1',
      rules: [
        {
          policy_rule_id: 'home',
          match: { site: 'fb_nyc', route_pattern: '/' },
          widget_ids: ['faq_nyc'],
        },
      ],
    },
    assets: [
      {
        sha256: HERO_SHA,
        role: 'hero',
        media_type: 'image/webp',
        alt_text: 'Hero',
        approval_status: 'approved',
        approval_id: 'appr_hero',
      },
      {
        sha256: OG_SHA,
        role: 'og',
        media_type: 'image/jpeg',
        alt_text: 'OG',
        approval_status: 'approved',
        approval_id: 'appr_og',
      },
    ],
    sitemaps: [
      {
        loc: 'https://freshlybaked.nyc/sites/all/whats-new/summer-drop-2026',
        scope: 'all',
        post_id: 'post_one',
      },
    ],
  }
  return { ...base, ...overrides }
}

export const FIXTURE_HERO_SHA = HERO_SHA
export const FIXTURE_OG_SHA = OG_SHA
