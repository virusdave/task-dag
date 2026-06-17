import { describe, expect, it } from 'vitest'

import {
  isValidSourceKey,
  newSourceItemId,
  normalizeSourceUrl,
  normalizeTagList,
  SOURCE_ITEM_ID_RE,
  sourceItemCanonicalPayload,
  sourceItemDedupHash,
  validateSourceItemInput,
} from './sourceContent.js'

describe('newSourceItemId', () => {
  it('matches the structured id grammar and embeds the UTC timestamp', () => {
    const now = new Date('2026-06-17T04:55:40.000Z')
    const id = newSourceItemId(now)
    expect(id).toMatch(SOURCE_ITEM_ID_RE)
    expect(id.startsWith('seosrc_2026-06-17_045540_')).toBe(true)
  })

  it('mints distinct ids for the same instant (random suffix)', () => {
    const now = new Date('2026-06-17T04:55:40.000Z')
    expect(newSourceItemId(now)).not.toBe(newSourceItemId(now))
  })
})

describe('normalizeSourceUrl', () => {
  it('returns null for empty / whitespace / nullish input', () => {
    expect(normalizeSourceUrl(null)).toBeNull()
    expect(normalizeSourceUrl(undefined)).toBeNull()
    expect(normalizeSourceUrl('')).toBeNull()
    expect(normalizeSourceUrl('   ')).toBeNull()
  })

  it('lowercases scheme + host, drops the fragment, strips a trailing slash', () => {
    expect(normalizeSourceUrl('HTTPS://Eater.com/NYC/Post/#section')).toBe(
      'https://eater.com/NYC/Post',
    )
  })

  it('keeps the query string and a root path slash', () => {
    expect(normalizeSourceUrl('https://eater.com/?utm=1')).toBe('https://eater.com/?utm=1')
  })

  it('falls back to a trimmed string for unparseable input', () => {
    expect(normalizeSourceUrl('  not a url  ')).toBe('not a url')
  })
})

describe('normalizeTagList', () => {
  it('trims, lowercases, drops empties, and dedups preserving first-seen order', () => {
    expect(normalizeTagList([' Local ', 'NEWS', 'local', '', '  ', 'events'])).toEqual([
      'local',
      'news',
      'events',
    ])
  })

  it('returns [] for null/undefined', () => {
    expect(normalizeTagList(null)).toEqual([])
    expect(normalizeTagList(undefined)).toEqual([])
  })
})

describe('sourceItemDedupHash', () => {
  const base = { sourceKey: 'nyc-eater', url: 'https://eater.com/a', title: 'A' }

  it('is a 64-char lowercase hex digest', () => {
    expect(sourceItemDedupHash(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable across calls', () => {
    expect(sourceItemDedupHash(base)).toBe(sourceItemDedupHash(base))
  })

  it('dedups URL spelling variants (case host, trailing slash, fragment)', () => {
    const a = sourceItemDedupHash({ ...base, url: 'https://eater.com/a' })
    const b = sourceItemDedupHash({ ...base, url: 'HTTPS://Eater.com/a/#x' })
    expect(a).toBe(b)
  })

  it('is title-independent when a URL is present', () => {
    const a = sourceItemDedupHash({ ...base, title: 'A' })
    const b = sourceItemDedupHash({ ...base, title: 'A totally different title' })
    expect(a).toBe(b)
  })

  it('keys on the title (normalized) when there is no URL', () => {
    const a = sourceItemDedupHash({ sourceKey: 'fb-internal', url: null, title: 'New drop' })
    const b = sourceItemDedupHash({ sourceKey: 'fb-internal', url: '', title: '  new   drop ' })
    const c = sourceItemDedupHash({ sourceKey: 'fb-internal', url: null, title: 'Other news' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('separates identical links across different sources', () => {
    const a = sourceItemDedupHash({ ...base, sourceKey: 'nyc-eater' })
    const b = sourceItemDedupHash({ ...base, sourceKey: 'mjbiz-daily' })
    expect(a).not.toBe(b)
  })

  it('distinguishes a url-keyed item from a title-keyed item', () => {
    const withUrl = sourceItemDedupHash({ sourceKey: 's', url: 'https://x.com/a', title: 'a' })
    const noUrl = sourceItemDedupHash({ sourceKey: 's', url: null, title: 'a' })
    expect(withUrl).not.toBe(noUrl)
  })
})

describe('sourceItemCanonicalPayload', () => {
  it('omits the title_key when a URL is present, includes it otherwise', () => {
    const withUrl = JSON.parse(
      sourceItemCanonicalPayload({ sourceKey: 's', url: 'https://x.com/a', title: 'Hi' }),
    )
    expect(withUrl.title_key).toBeNull()
    expect(withUrl.url).toBe('https://x.com/a')

    const noUrl = JSON.parse(
      sourceItemCanonicalPayload({ sourceKey: 's', url: null, title: 'Hi There' }),
    )
    expect(noUrl.url).toBeNull()
    expect(noUrl.title_key).toBe('hi there')
  })
})

describe('isValidSourceKey', () => {
  it('accepts bounded lowercase-kebab slugs', () => {
    expect(isValidSourceKey('nyc-eater')).toBe(true)
    expect(isValidSourceKey('mjbiz-daily')).toBe(true)
    expect(isValidSourceKey('abc')).toBe(true)
  })

  it('rejects too-short, uppercase, or edge-hyphen slugs', () => {
    expect(isValidSourceKey('ab')).toBe(false)
    expect(isValidSourceKey('NYC')).toBe(false)
    expect(isValidSourceKey('-bad')).toBe(false)
    expect(isValidSourceKey('bad-')).toBe(false)
    expect(isValidSourceKey('has space')).toBe(false)
  })
})

describe('validateSourceItemInput', () => {
  it('passes a valid input', () => {
    expect(
      validateSourceItemInput({ sourceKey: 'nyc-eater', title: 'A post', url: 'https://x/y' }),
    ).toEqual([])
  })

  it('flags an invalid source_key and an empty title', () => {
    const problems = validateSourceItemInput({ sourceKey: 'BAD', title: '   ' })
    expect(problems.map((p) => p.field).sort()).toEqual(['sourceKey', 'title'])
  })
})
