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
      skippedEmptySlug: 1,
      skippedNotForSale: 1,
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

  it('throws on a (site, slug) collision to a different brand id (mss collision)', () => {
    expect(() =>
      buildBrandingOpaqueManifest(
        [
          row({ siteKey: 'bronx', sweedBrandId: 1234, brandName: 'Herb' }),
          row({ siteKey: 'bronx', sweedBrandId: 5678, brandName: 'herb' }),
        ],
        OPTS,
      ),
    ).toThrow(BrandingManifestBuildError)
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
