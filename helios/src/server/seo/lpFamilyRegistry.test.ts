import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { fbusFaqSourceKey } from './faqSourceKey.js'
import {
  getLpFamily,
  getLpFamilyRegistry,
  LP_FAMILY_REGISTRY_PROVENANCE,
  LP_FAMILY_REGISTRY_SCHEMA_ID,
  listLpFamilies,
  lpFamilyFaqSourceKey,
  lpFamilyIds,
  resolveLpFamilyId,
} from './lpFamilyRegistry.js'

describe('lpFamilyRegistry', () => {
  it('parses the vendored artifact at load (would throw on a malformed copy)', () => {
    const registry = getLpFamilyRegistry()
    expect(registry.schema).toBe(LP_FAMILY_REGISTRY_SCHEMA_ID)
    expect(registry.site_id).toBe('freshlybakedus')
    expect(registry.canonical_host).toBe('freshlybaked.us')
    expect(registry.families.length).toBeGreaterThan(0)
  })

  it('carries the operator-confirmed family set (deliverance, recurse, tours, branding, compare)', () => {
    expect([...lpFamilyIds()].sort()).toEqual(
      ['branding', 'compare', 'deliverance', 'recurse', 'tours'].sort(),
    )
  })

  it('resolves the conquest alias to the compare family', () => {
    expect(resolveLpFamilyId('conquest')).toBe('compare')
    expect(getLpFamily('conquest')?.id).toBe('compare')
    expect(getLpFamily('compare')?.id).toBe('compare')
  })

  it('returns null for an unknown family', () => {
    expect(resolveLpFamilyId('not-a-family')).toBeNull()
    expect(getLpFamily('not-a-family')).toBeNull()
  })

  it('derives the FBUS source key per family (and via alias)', () => {
    for (const id of lpFamilyIds()) {
      expect(lpFamilyFaqSourceKey(id)).toBe(fbusFaqSourceKey(id))
    }
    // alias resolves to the canonical id's key
    expect(lpFamilyFaqSourceKey('conquest')).toBe('fbus-compare-faq')
    expect(lpFamilyFaqSourceKey('deliverance')).toBe('fbus-deliverance-faq')
  })

  it('throws on an unknown family when minting a source key', () => {
    expect(() => lpFamilyFaqSourceKey('nope')).toThrow(/Unknown LP family/)
  })

  it('every family has the route scoping + provenance P5 consumes', () => {
    for (const family of listLpFamilies()) {
      expect(family.canonical_representative_route.startsWith('/')).toBe(true)
      expect(family.widget_route_patterns.length).toBeGreaterThan(0)
      expect(family.route_patterns.length).toBeGreaterThan(0)
      expect(family.sample_crawl_routes.length).toBeGreaterThan(0)
      expect(family.indexability_policy.kind).toMatch(/^(all_variants|variant_overrides)$/)
    }
  })

  it('pins the upstream mss source SHA for provenance', () => {
    expect(LP_FAMILY_REGISTRY_PROVENANCE.repo).toBe('Nicponskis/mostly-static-sites')
    expect(LP_FAMILY_REGISTRY_PROVENANCE.commitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(LP_FAMILY_REGISTRY_PROVENANCE.blobSha).toMatch(/^[0-9a-f]{40}$/)
  })

  // Bind the committed audit artifact (the byte-for-byte upstream JSON) to
  // the runtime const + the pinned blob sha, so neither can silently drift.
  describe('vendored audit artifact', () => {
    const jsonBuffer = readFileSync(new URL('./lpFamilyRegistry.generated.json', import.meta.url))

    it("git blob sha of the committed JSON equals the pinned provenance blobSha", () => {
      // git blob sha = sha1("blob <byteLength>\0" + content)
      const blobSha = createHash('sha1')
        .update(`blob ${jsonBuffer.length}\0`)
        .update(jsonBuffer)
        .digest('hex')
      expect(blobSha).toBe(LP_FAMILY_REGISTRY_PROVENANCE.blobSha)
    })

    it('runtime const is a faithful mirror of the committed JSON', () => {
      const fromJson: unknown = JSON.parse(jsonBuffer.toString('utf8'))
      // getLpFamilyRegistry() returns the zod-validated runtime const; it must
      // deep-equal the parsed JSON artifact (zod only validates, never reshapes).
      expect(getLpFamilyRegistry()).toEqual(fromJson)
    })
  })
})
