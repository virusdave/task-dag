import { describe, expect, it } from 'vitest'

import type { BlogPostContent, SitemapUrl } from './contracts.js'
import {
  SitemapMergeError,
  buildPostSitemapUrls,
  mergePostSitemaps,
} from './postSitemapUrls.js'

function post(overrides: Partial<BlogPostContent> = {}): BlogPostContent {
  return {
    post_id: 'post_a',
    scope: 'all',
    slug: 'summer-drop-2026',
    title: 'Summer 2026 Drop',
    meta_description: 'A look at the new summer arrivals.',
    excerpt: 'New arrivals for summer 2026.',
    canonical_url: 'https://freshlybaked.nyc/sites/all/whats-new/summer-drop-2026',
    published_at: '2026-06-11T08:00:00Z',
    updated_at: '2026-06-12T09:30:00Z',
    author: 'Editorial',
    reviewer: 'dave',
    tags: ['nyc-culture'],
    body_raw: 'Raw body.',
    body_sanitized: 'Sanitized body.',
    approval_id: 'seoapr_a',
    ...overrides,
  }
}

describe('buildPostSitemapUrls', () => {
  it('emits one indexable url per post, derived from canonical_url', () => {
    const urls = buildPostSitemapUrls([post()])
    expect(urls).toEqual<SitemapUrl[]>([
      {
        loc: 'https://freshlybaked.nyc/sites/all/whats-new/summer-drop-2026',
        scope: 'all',
        lastmod: '2026-06-12T09:30:00Z',
        changefreq: 'weekly',
        priority: 0.7,
        post_id: 'post_a',
      },
    ])
  })

  it('falls back to published_at when updated_at is absent', () => {
    const urls = buildPostSitemapUrls([post({ updated_at: undefined })])
    expect(urls[0]!.lastmod).toBe('2026-06-11T08:00:00Z')
  })

  it('skips noindex posts', () => {
    expect(buildPostSitemapUrls([post({ noindex: true })])).toEqual([])
  })

  it('skips kill-listed (disabled) posts', () => {
    const urls = buildPostSitemapUrls([post()], {
      disabledPostIds: new Set(['post_a']),
    })
    expect(urls).toEqual([])
  })

  it('honors custom default changefreq/priority', () => {
    const urls = buildPostSitemapUrls([post()], {
      defaultChangefreq: 'daily',
      defaultPriority: 0.9,
    })
    expect(urls[0]!.changefreq).toBe('daily')
    expect(urls[0]!.priority).toBe(0.9)
  })
})

describe('mergePostSitemaps', () => {
  const homepage: SitemapUrl = {
    loc: 'https://freshlybaked.nyc/',
    scope: 'fb_nyc',
    changefreq: 'daily',
    priority: 1,
  }

  it('keeps static non-post urls and appends generated post urls', () => {
    const merged = mergePostSitemaps([homepage], [post()])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual(homepage)
    expect(merged[1]!.post_id).toBe('post_a')
  })

  it('drops config urls that already carry a post_id (generator owns them)', () => {
    const stale: SitemapUrl = {
      loc: 'https://freshlybaked.nyc/sites/all/whats-new/summer-drop-2026',
      scope: 'all',
      post_id: 'post_a',
      priority: 0.1,
    }
    const merged = mergePostSitemaps([homepage, stale], [post()])
    expect(merged).toHaveLength(2)
    expect(merged.filter((u) => u.post_id === 'post_a')).toHaveLength(1)
    // The regenerated entry uses the canonical defaults, not the stale 0.1.
    expect(merged.find((u) => u.post_id === 'post_a')!.priority).toBe(0.7)
  })

  it('fails closed on a post-shaped static url with no post_id', () => {
    const stalePostUrl: SitemapUrl = {
      loc: 'https://freshlybaked.nyc/sites/all/whats-new/old-post',
      scope: 'all',
    }
    expect(() => mergePostSitemaps([stalePostUrl], [post()])).toThrow(SitemapMergeError)
  })

  it('does not emit a sitemap entry for an excluded post even if a static url is fine', () => {
    const merged = mergePostSitemaps([homepage], [post({ noindex: true })])
    expect(merged).toEqual([homepage])
  })
})
