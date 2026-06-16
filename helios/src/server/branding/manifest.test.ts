import { describe, expect, it } from 'vitest'

import { nonProductionFallbackPublicTokenSecret } from './opaqueRef.js'
import {
  BrandingManifestBuildError,
  buildBrandingOpaqueManifest,
  checkBrandingManifestConsistency,
  slugifyBrandName,
  type BrandPresenceRow,
} from './manifest.js'

const SECRET = nonProductionFallbackPublicTokenSecret
const OPTS = { secret: SECRET, secretSource: 'nonproduction-fallback' as const }

function row(overrides: Partial<BrandPresenceRow>): BrandPresenceRow {
  return {
    siteKey: 'bronx',
    sweedBrandId: 1234,
    brandName: 'Herb',
    forSaleVariantCount: 3,
    lastForSaleObservedAt: null,
    ...overrides,
  }
}

describe('slugifyBrandName (mirrors mss slugifyStorefrontPathSegment)', () => {
  it('lowercases, ampersand→and, collapses non-alnum to dashes, trims dashes', () => {
    expect(slugifyBrandName('  Foo  ')).toBe('foo')
    expect(slugifyBrandName('AB & CD!')).toBe('ab-and-cd')
    expect(slugifyBrandName('Cannaballs')).toBe('cannaballs')
    expect(slugifyBrandName('--Edge--')).toBe('edge')
  })

  it('returns empty for punctuation-only names', () => {
    expect(slugifyBrandName('***')).toBe('')
    expect(slugifyBrandName('   ')).toBe('')
  })
})

describe('buildBrandingOpaqueManifest', () => {
  it('derives opaque refs that match the frozen golden vectors', () => {
    const result = buildBrandingOpaqueManifest(
      [row({ siteKey: 'bronx', sweedBrandId: 1234, brandName: 'Herb' })],
      OPTS,
    )
    expect(result.entries).toEqual([
      { site_key: 'bronx', literal_slug: 'herb', sweed_brand_id: 1234, opaque_ref: 'h78SFgtcQNLHNzKo37r1' },
    ])
  })

  it('applies the mss canonical-presence inclusion filters', () => {
    const result = buildBrandingOpaqueManifest(
      [
        row({ siteKey: 'bronx', sweedBrandId: 1234, brandName: 'Herb', forSaleVariantCount: 3 }),
        row({ siteKey: 'midtown', sweedBrandId: 1, brandName: 'Cannaballs', forSaleVariantCount: 0, lastForSaleObservedAt: new Date('2026-01-01T00:00:00Z') }),
        row({ siteKey: 'queens', sweedBrandId: 5, brandName: 'Elsewhere' }), // non-FB-US site
        row({ siteKey: 'bronx', sweedBrandId: 6, brandName: '   ' }), // empty name
        row({ siteKey: 'bronx', sweedBrandId: 9, brandName: 'DEAD - Old Brand' }), // operator-retired name
        row({ siteKey: 'bronx', sweedBrandId: 7, brandName: '***' }), // empty slug
        row({ siteKey: 'bronx', sweedBrandId: 8, brandName: 'NeverSold', forSaleVariantCount: 0, lastForSaleObservedAt: null }), // never for sale
      ],
      OPTS,
    )
    expect(result.entries.map((e) => [e.site_key, e.literal_slug, e.sweed_brand_id])).toEqual([
      ['bronx', 'herb', 1234],
      ['midtown', 'cannaballs', 1],
    ])
    expect(result.summary).toMatchObject({
      includedBrands: 2,
      skippedNotFbUsSite: 1,
      skippedEmptyName: 1,
      skippedRetiredName: 1,
      skippedEmptySlug: 1,
      skippedNotForSale: 1,
      slugCollisionGroups: 0,
    })
  })

  it('merges same (site, slug) rows with the same brand id', () => {
    const result = buildBrandingOpaqueManifest(
      [
        row({ siteKey: 'bronx', sweedBrandId: 1234, brandName: 'Herb', forSaleVariantCount: 2 }),
        row({ siteKey: 'bronx', sweedBrandId: 1234, brandName: 'Herb', forSaleVariantCount: 5 }),
      ],
      OPTS,
    )
    expect(result.entries).toHaveLength(1)
    expect(result.summary.mergedDuplicateSlugRows).toBe(1)
  })

  it('resolves a slug collision by skipping the disabled (not-for-sale-anywhere) duplicate', () => {
    // Mirrors the live bronx/dr-jekyll-and-mr-high collision: brand 1902 is
    // live (for sale at midtown), brand 16413 is a stale bronx-only dup.
    const result = buildBrandingOpaqueManifest(
      [
        row({ siteKey: 'bronx', sweedBrandId: 16413, brandName: 'Dr Jekyll and Mr High', forSaleVariantCount: 0, lastForSaleObservedAt: new Date('2026-05-21T14:09:57Z') }),
        row({ siteKey: 'bronx', sweedBrandId: 1902, brandName: 'Dr. Jekyll And Mr. High', forSaleVariantCount: 0, lastForSaleObservedAt: new Date('2026-06-04T21:27:47Z') }),
        row({ siteKey: 'midtown', sweedBrandId: 1902, brandName: 'Dr. Jekyll And Mr. High', forSaleVariantCount: 2, lastForSaleObservedAt: new Date('2026-06-16T19:54:00Z') }),
      ],
      OPTS,
    )
    // bronx keeps only the live brand (1902); midtown keeps 1902 normally.
    expect(result.entries.map((e) => [e.site_key, e.literal_slug, e.sweed_brand_id])).toEqual([
      ['bronx', 'dr-jekyll-and-mr-high', 1902],
      ['midtown', 'dr-jekyll-and-mr-high', 1902],
    ])
    expect(result.summary).toMatchObject({
      slugCollisionGroups: 1,
      ambiguousCollisionGroups: 0,
      droppedCollisionBrands: 1,
    })
    expect(result.collisions).toHaveLength(1)
    const collision = result.collisions[0]
    expect(collision).toMatchObject({
      siteKey: 'bronx',
      literalSlug: 'dr-jekyll-and-mr-high',
      resolution: 'skipped-disabled',
      winnerBrandId: 1902,
    })
    expect(collision.brands.map((b) => [b.sweedBrandId, b.brandWideActive, b.selected])).toEqual([
      [1902, true, true],
      [16413, false, false],
    ])
  })

  it('resolves an ambiguous slug collision (>1 live brand) by deterministic winner + flags it', () => {
    const result = buildBrandingOpaqueManifest(
      [
        row({ siteKey: 'bronx', sweedBrandId: 1234, brandName: 'Herb', forSaleVariantCount: 2, lastForSaleObservedAt: new Date('2026-06-01T00:00:00Z') }),
        row({ siteKey: 'bronx', sweedBrandId: 5678, brandName: 'herb', forSaleVariantCount: 9, lastForSaleObservedAt: new Date('2026-06-10T00:00:00Z') }),
      ],
      OPTS,
    )
    // Both live; higher for-sale count wins (5678).
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].sweed_brand_id).toBe(5678)
    expect(result.summary).toMatchObject({ slugCollisionGroups: 1, ambiguousCollisionGroups: 1, droppedCollisionBrands: 1 })
    expect(result.collisions[0].resolution).toBe('ambiguous')
    expect(result.collisions[0].winnerBrandId).toBe(5678)
  })

  it('resolves an all-disabled slug collision (0 live brands) as ambiguous by most-recent-for-sale', () => {
    const result = buildBrandingOpaqueManifest(
      [
        row({ siteKey: 'bronx', sweedBrandId: 1234, brandName: 'Herb', forSaleVariantCount: 0, lastForSaleObservedAt: new Date('2026-05-01T00:00:00Z') }),
        row({ siteKey: 'bronx', sweedBrandId: 5678, brandName: 'herb', forSaleVariantCount: 0, lastForSaleObservedAt: new Date('2026-06-01T00:00:00Z') }),
      ],
      OPTS,
    )
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].sweed_brand_id).toBe(5678) // more recent last-for-sale
    expect(result.summary).toMatchObject({ slugCollisionGroups: 1, ambiguousCollisionGroups: 1 })
    expect(result.collisions[0].resolution).toBe('ambiguous')
  })

  it('breaks an exact collision tie deterministically by lowest sweedBrandId (input-order independent)', () => {
    const rows = [
      row({ siteKey: 'bronx', sweedBrandId: 5678, brandName: 'Herb', forSaleVariantCount: 0, lastForSaleObservedAt: new Date('2026-06-01T00:00:00Z') }),
      row({ siteKey: 'bronx', sweedBrandId: 1234, brandName: 'herb', forSaleVariantCount: 0, lastForSaleObservedAt: new Date('2026-06-01T00:00:00Z') }),
    ]
    const a = buildBrandingOpaqueManifest(rows, OPTS)
    const b = buildBrandingOpaqueManifest([...rows].reverse(), OPTS)
    expect(a.entries[0].sweed_brand_id).toBe(1234)
    expect(b.entries[0].sweed_brand_id).toBe(1234)
    expect(a.collisions).toEqual(b.collisions)
  })

  it('does not let a retired-named (DEAD-) row mark a brand live in a collision', () => {
    // brand 5678 only appears as a DEAD- row with forSale>0 — it must NOT
    // count as live; brand 1234 (present, not for sale) is the lone winner.
    const result = buildBrandingOpaqueManifest(
      [
        row({ siteKey: 'bronx', sweedBrandId: 1234, brandName: 'Herb', forSaleVariantCount: 0, lastForSaleObservedAt: new Date('2026-06-01T00:00:00Z') }),
        row({ siteKey: 'bronx', sweedBrandId: 5678, brandName: 'DEAD - Herb', forSaleVariantCount: 9, lastForSaleObservedAt: new Date('2026-06-10T00:00:00Z') }),
      ],
      OPTS,
    )
    // The DEAD- row is skipped entirely, so there is no collision at all.
    expect(result.entries.map((e) => e.sweed_brand_id)).toEqual([1234])
    expect(result.summary).toMatchObject({ skippedRetiredName: 1, slugCollisionGroups: 0 })
  })

  it('throws on an invalid sweedBrandId', () => {
    expect(() => buildBrandingOpaqueManifest([row({ sweedBrandId: 0 })], OPTS)).toThrow(BrandingManifestBuildError)
    expect(() => buildBrandingOpaqueManifest([row({ sweedBrandId: -1 })], OPTS)).toThrow(BrandingManifestBuildError)
    expect(() => buildBrandingOpaqueManifest([row({ sweedBrandId: 1.5 })], OPTS)).toThrow(BrandingManifestBuildError)
  })

  it('allows the same slug at different sites (per-site scoping)', () => {
    const result = buildBrandingOpaqueManifest(
      [
        row({ siteKey: 'bronx', sweedBrandId: 1234, brandName: 'Herb' }),
        row({ siteKey: 'midtown', sweedBrandId: 5678, brandName: 'Herb' }),
      ],
      OPTS,
    )
    expect(result.entries).toHaveLength(2)
  })

  it('is deterministic and sorted by (site_key, literal_slug, sweed_brand_id)', () => {
    const rows = [
      row({ siteKey: 'midtown', sweedBrandId: 1, brandName: 'Zeta' }),
      row({ siteKey: 'bronx', sweedBrandId: 42, brandName: 'Alpha' }),
      row({ siteKey: 'bronx', sweedBrandId: 987654, brandName: 'Beta' }),
    ]
    const a = buildBrandingOpaqueManifest(rows, OPTS).entries
    const b = buildBrandingOpaqueManifest([...rows].reverse(), OPTS).entries
    expect(a).toEqual(b)
    expect(a.map((e) => [e.site_key, e.literal_slug])).toEqual([
      ['bronx', 'alpha'],
      ['bronx', 'beta'],
      ['midtown', 'zeta'],
    ])
  })
})

describe('checkBrandingManifestConsistency', () => {
  it('passes a well-formed entry set', () => {
    expect(
      checkBrandingManifestConsistency([
        { site_key: 'bronx', literal_slug: 'herb', sweed_brand_id: 1234, opaque_ref: 'h78SFgtcQNLHNzKo37r1' },
      ]),
    ).toEqual([])
  })

  it('flags a duplicate opaque ref mapping to two brand ids', () => {
    const errors = checkBrandingManifestConsistency([
      { site_key: 'bronx', literal_slug: 'herb', sweed_brand_id: 1234, opaque_ref: 'AAAAAAAAAAAAAAAAAAAA' },
      { site_key: 'bronx', literal_slug: 'leaf', sweed_brand_id: 4321, opaque_ref: 'AAAAAAAAAAAAAAAAAAAA' },
    ])
    expect(errors.some((e) => e.includes('opaque-ref collision'))).toBe(true)
  })

  it('flags a literal slug equal to an opaque ref in the same location', () => {
    const errors = checkBrandingManifestConsistency([
      { site_key: 'bronx', literal_slug: 'collide', sweed_brand_id: 1, opaque_ref: 'ZZZZZZZZZZZZZZZZZZZZ' },
      { site_key: 'bronx', literal_slug: 'leaf', sweed_brand_id: 2, opaque_ref: 'collide' },
    ])
    expect(errors.some((e) => e.includes('literal slug equals an opaque ref'))).toBe(true)
  })
})
