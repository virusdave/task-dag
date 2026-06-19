import { describe, expect, it } from 'vitest'

import {
  BLOG_CANONICAL_ORIGIN,
  RESERVED_GLOBAL_SITE_ID,
  blogCanonicalUrl,
  blogIndexPath,
  blogPostPath,
  isReservedGlobalSiteId,
  isValidScope,
  isValidSlug,
  looksLikeBlogPostUrl,
} from './routeRegistry.js'

describe('FB.nyc Reserved Prefix Registry slug', () => {
  it('builds the canonical hosted-content path for a concrete site', () => {
    expect(blogPostPath('fb_nyc', 'summer-drop-2026')).toBe('/sites/fb_nyc/whats-new/summer-drop-2026')
  })

  it('builds the global (all) path for domain-boosting posts', () => {
    expect(blogPostPath(RESERVED_GLOBAL_SITE_ID, 'cannabis-101')).toBe('/sites/all/whats-new/cannabis-101')
  })

  it('builds the blog index path', () => {
    expect(blogIndexPath('fb_us')).toBe('/sites/fb_us/whats-new')
  })

  it('derives the canonical post URL from scope+slug', () => {
    expect(blogCanonicalUrl('all', 'summer-drop-2026')).toBe(
      `${BLOG_CANONICAL_ORIGIN}/sites/all/whats-new/summer-drop-2026`,
    )
    expect(() => blogCanonicalUrl('fb_nyc', 'Bad Slug')).toThrow()
  })

  it('rejects an invalid slug', () => {
    expect(() => blogPostPath('fb_nyc', 'Summer Drop')).toThrow()
    expect(() => blogPostPath('fb_nyc', '-leading')).toThrow()
    expect(() => blogPostPath('fb_nyc', 'TRAILING-')).toThrow()
  })

  it('validates slugs', () => {
    expect(isValidSlug('summer-drop-2026')).toBe(true)
    expect(isValidSlug('a')).toBe(true)
    expect(isValidSlug('a--b')).toBe(false)
    expect(isValidSlug('UPPER')).toBe(false)
    expect(isValidSlug('')).toBe(false)
  })

  it('treats `all` as the reserved global token', () => {
    expect(isReservedGlobalSiteId('all')).toBe(true)
    expect(isReservedGlobalSiteId('fb_nyc')).toBe(false)
  })

  it('accepts a scope that is a known site id or `all`', () => {
    const siteIds = new Set(['fb_nyc', 'fb_us'])
    expect(isValidScope('fb_nyc', siteIds)).toBe(true)
    expect(isValidScope('all', siteIds)).toBe(true)
    expect(isValidScope('unknown', siteIds)).toBe(false)
  })

  it('detects blog-post routes (absolute url, bare path, trailing slash, query)', () => {
    expect(looksLikeBlogPostUrl('https://freshlybaked.nyc/sites/all/whats-new/summer-drop-2026')).toBe(true)
    expect(looksLikeBlogPostUrl('/sites/fb_nyc/whats-new/cannabis-101')).toBe(true)
    expect(looksLikeBlogPostUrl('https://freshlybaked.nyc/sites/all/whats-new/summer-drop-2026/')).toBe(true)
    expect(looksLikeBlogPostUrl('/sites/all/whats-new/summer-drop-2026?utm=x')).toBe(true)
  })

  it('does not flag non-post routes as blog posts', () => {
    expect(looksLikeBlogPostUrl('https://freshlybaked.nyc/')).toBe(false)
    expect(looksLikeBlogPostUrl('/sites/fb_nyc/whats-new')).toBe(false)
    expect(looksLikeBlogPostUrl('/sites/fb_nyc/whats-new/Bad-Slug')).toBe(false)
    expect(looksLikeBlogPostUrl('/categories/edibles')).toBe(false)
  })
})
