import { describe, expect, it } from 'vitest'

import {
  buildBlogPostJsonLd,
  buildSocialExport,
  checkPostApprovable,
  newPostId,
  POST_ID_RE,
  postCanonicalPayload,
  postContentSha256,
  visiblePostBody,
  type PostContentInput,
} from './postContent.js'

function basePost(overrides: Partial<PostContentInput> = {}): PostContentInput {
  return {
    post_id: 'post_x',
    scope: 'all',
    slug: 'summer-drop-2026',
    title: 'Summer 2026 Drop',
    meta_description: 'A look at the new summer arrivals.',
    excerpt: 'New arrivals for summer 2026.',
    author: 'Freshly Baked Editorial',
    tags: ['nyc-culture', 'new-arrivals'],
    body_raw: 'Summer is here with new cannabis arrivals across our NYC menu.',
    body_sanitized: 'Summer is here with new arrivals across our NYC menu.',
    ...overrides,
  }
}

describe('newPostId', () => {
  it('mints an id matching the frozen format', () => {
    const id = newPostId(new Date('2026-06-11T08:09:10Z'))
    expect(id).toMatch(POST_ID_RE)
    expect(id.startsWith('post_2026-06-11_080910_')).toBe(true)
  })
})

describe('postContentSha256', () => {
  it('is stable regardless of key insertion order of the input object', () => {
    const a = postContentSha256(basePost())
    const reordered: PostContentInput = {
      body_sanitized: 'Summer is here with new arrivals across our NYC menu.',
      tags: ['nyc-culture', 'new-arrivals'],
      author: 'Freshly Baked Editorial',
      excerpt: 'New arrivals for summer 2026.',
      meta_description: 'A look at the new summer arrivals.',
      title: 'Summer 2026 Drop',
      slug: 'summer-drop-2026',
      scope: 'all',
      post_id: 'post_x',
      body_raw: 'Summer is here with new cannabis arrivals across our NYC menu.',
    }
    expect(postContentSha256(reordered)).toBe(a)
  })

  it('changes when any public field changes', () => {
    const base = postContentSha256(basePost())
    expect(postContentSha256(basePost({ title: 'Other' }))).not.toBe(base)
    expect(postContentSha256(basePost({ slug: 'other-slug' }))).not.toBe(base)
    expect(postContentSha256(basePost({ tags: ['nyc-culture'] }))).not.toBe(base)
    expect(postContentSha256(basePost({ body_raw: 'changed' }))).not.toBe(base)
    expect(postContentSha256(basePost({ noindex: true }))).not.toBe(base)
    expect(postContentSha256(basePost({ hero_image_sha256: 'a'.repeat(64) }))).not.toBe(base)
  })

  it('treats undefined and null image refs / absent noindex identically', () => {
    const a = postContentSha256(basePost())
    const b = postContentSha256(
      basePost({ hero_image_sha256: null, og_image_sha256: null, noindex: false }),
    )
    expect(b).toBe(a)
    expect(postCanonicalPayload(basePost())).toContain('"hero_image_sha256":null')
  })
})

describe('checkPostApprovable', () => {
  it('passes a clean, complete, sanitized post', () => {
    expect(checkPostApprovable(basePost())).toEqual([])
  })

  it('flags empty required fields', () => {
    const problems = checkPostApprovable(
      basePost({ title: '', body_sanitized: '', slug: '' }),
    )
    const fields = problems.map((p) => p.field)
    expect(fields).toContain('title')
    expect(fields).toContain('body_sanitized')
    expect(fields).toContain('slug')
  })

  it('rejects an invalid slug', () => {
    const problems = checkPostApprovable(basePost({ slug: 'Not A Slug' }))
    expect(problems.some((p) => p.field === 'slug')).toBe(true)
  })

  it('blocks raw-only terms leaking onto shared/sanitized fields', () => {
    const problems = checkPostApprovable(
      basePost({
        title: 'Best cannabis deals',
        slug: 'thc-guide',
        tags: ['weed', 'deals'],
        body_sanitized: 'Buy marijuana here.',
      }),
    )
    const fields = problems.map((p) => p.field)
    expect(fields).toContain('title')
    expect(fields).toContain('slug')
    expect(fields).toContain('tags')
    expect(fields).toContain('body_sanitized')
  })

  it('allows raw terms in the raw body only', () => {
    expect(
      checkPostApprovable(basePost({ body_raw: 'Fresh cannabis, THC, and edibles in stock.' })),
    ).toEqual([])
  })

  it('rejects a sanitized body that is an unsanitized copy of a raw body with raw terms', () => {
    const shared = 'Fresh cannabis and edibles in stock.'
    const problems = checkPostApprovable(
      basePost({ body_raw: shared, body_sanitized: shared }),
    )
    expect(problems.some((p) => p.field === 'body_sanitized')).toBe(true)
  })
})

describe('buildBlogPostJsonLd (no cloaking)', () => {
  const meta = {
    canonical_url: 'https://freshlybaked.nyc/sites/all/whats-new/summer-drop-2026',
    published_at: '2026-06-11T08:00:00Z',
    updated_at: '2026-06-11T09:30:00Z',
  }

  it('articleBody equals the visible raw body in raw mode', () => {
    const post = basePost()
    const jsonLd = buildBlogPostJsonLd(post, meta, 'raw')
    expect(jsonLd.articleBody).toBe(visiblePostBody(post, 'raw'))
    expect(jsonLd.articleBody).toBe(post.body_raw)
  })

  it('articleBody equals the visible sanitized body in sanitized mode', () => {
    const post = basePost()
    const jsonLd = buildBlogPostJsonLd(post, meta, 'sanitized')
    expect(jsonLd.articleBody).toBe(post.body_sanitized)
  })

  it('carries headline/description/canonical/datePublished', () => {
    const jsonLd = buildBlogPostJsonLd(basePost(), meta, 'raw')
    expect(jsonLd['@type']).toBe('BlogPosting')
    expect(jsonLd.headline).toBe('Summer 2026 Drop')
    expect(jsonLd.datePublished).toBe('2026-06-11T08:00:00Z')
    expect(jsonLd.dateModified).toBe('2026-06-11T09:30:00Z')
    expect((jsonLd.mainEntityOfPage as Record<string, unknown>)['@id']).toBe(meta.canonical_url)
  })

  it('omits dateModified when no updated_at is supplied', () => {
    const jsonLd = buildBlogPostJsonLd(basePost(), {
      canonical_url: meta.canonical_url,
      published_at: meta.published_at,
    }, 'raw')
    expect('dateModified' in jsonLd).toBe(false)
  })
})

describe('buildSocialExport (export-only)', () => {
  const canonical = 'https://freshlybaked.nyc/sites/all/whats-new/summer-drop-2026'

  it('emits one entry per platform with UTM-tagged URLs + non-empty captions', () => {
    const out = buildSocialExport(
      { title: 'Summer 2026 Drop', excerpt: 'New arrivals for summer.', tags: ['nyc-culture'] },
      canonical,
    )
    expect(out.canonical_url).toBe(canonical)
    expect(out.entries.map((e) => e.platform)).toEqual(['instagram', 'x', 'linkedin', 'email'])
    // instagram caption carries no URL (IG strips links), so check the others.
    for (const entry of out.entries) {
      expect(entry.caption.length).toBeGreaterThan(0)
      if (entry.platform === 'instagram') {
        expect(entry.url).toContain('utm_source=instagram')
        continue
      }
      expect(entry.url).toContain(`utm_source=${entry.platform}`)
      expect(entry.url).toContain('utm_campaign=whats-new')
      expect(entry.caption).toContain(entry.url)
    }
    expect(out.entries.find((e) => e.platform === 'email')!.url).toContain('utm_medium=email')
    expect(out.entries.find((e) => e.platform === 'x')!.url).toContain('utm_medium=social')
  })

  it('keeps the x caption text within budget before the appended URL', () => {
    const out = buildSocialExport({ title: 'A'.repeat(400), excerpt: '', tags: [] }, canonical)
    const x = out.entries.find((e) => e.platform === 'x')!
    expect(x.caption.indexOf('http')).toBeLessThanOrEqual(241)
  })

  it('leaves a non-URL canonical (draft without slug) untouched', () => {
    const out = buildSocialExport({ title: 'Draft', excerpt: 'x', tags: [] }, '')
    expect(out.canonical_url).toBe('')
    for (const entry of out.entries) {
      expect(entry.url).toBe('')
    }
  })

  it('builds hashtags only from alphanumeric-safe tags', () => {
    const out = buildSocialExport(
      { title: 'T', excerpt: 'e', tags: ['nyc-culture', 'new arrivals', '!!'] },
      canonical,
    )
    const x = out.entries.find((e) => e.platform === 'x')!
    expect(x.caption).toContain('#nycculture')
    expect(x.caption).toContain('#newarrivals')
    expect(x.caption).not.toContain('#!!')
  })
})
