import { describe, expect, it } from 'vitest'

import {
  deriveFreshlyBakedUsBrandOpaqueRef,
  deriveFreshlyBakedUsOpaquePublicRef,
  freshlyBakedUsOpaquePublicRefLength,
  nonProductionFallbackPublicTokenSecret,
} from './opaqueRef.js'

// Two independent kinds of test:
//
//  1. PROPERTY tests assert the scheme's invariants (determinism, fixed
//     length, URL-safe charset, scope namespacing, brand-id uniqueness).
//
//  2. KNOWN-ANSWER TEST VECTORS (like RFC 2104 HMAC vectors, NOT
//     auto-captured snapshots) freeze the public URL contract. These MUST
//     be byte-identical to the vectors frozen in the authoritative mss
//     module (`apps/freshlybakedus-site/lib/opaque-public-ref-core.test.ts`).
//     They ARE the cross-repo contract: if Helios's replica drifts from
//     mss the manifest's opaque refs point at pages mss never generated and
//     live, already-approved Google-Ads URLs 404 (parent EPIC_PLAN §7).
//     A failure here means "you just broke the URL contract"; the fix is to
//     revert, never to regenerate the constant. There is deliberately no
//     `--update` workflow.
const SECRET = nonProductionFallbackPublicTokenSecret

describe('opaque-public-ref scheme — properties', () => {
  it('is deterministic, fixed-length, and URL-safe', () => {
    const ref = deriveFreshlyBakedUsOpaquePublicRef(SECRET, 'fbus-go', 'x')

    expect(ref).toBe(deriveFreshlyBakedUsOpaquePublicRef(SECRET, 'fbus-go', 'x'))
    expect(ref).toHaveLength(freshlyBakedUsOpaquePublicRefLength)
    expect(ref).toMatch(/^[A-Za-z0-9_-]+$/u)
  })

  it('namespaces by scope (no cross-surface collision for equal values)', () => {
    expect(deriveFreshlyBakedUsOpaquePublicRef(SECRET, 'a', 'v')).not.toBe(
      deriveFreshlyBakedUsOpaquePublicRef(SECRET, 'b', 'v'),
    )
  })

  it('brand refs are brand-name-free and distinct per immutable brand id', () => {
    const ref = deriveFreshlyBakedUsBrandOpaqueRef(SECRET, 1234)

    expect(ref).toHaveLength(freshlyBakedUsOpaquePublicRefLength)
    expect(ref).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(deriveFreshlyBakedUsBrandOpaqueRef(SECRET, 42)).not.toBe(ref)
  })

  it('a different secret produces a different ref', () => {
    expect(deriveFreshlyBakedUsBrandOpaqueRef('some-other-secret', 1234)).not.toBe(
      deriveFreshlyBakedUsBrandOpaqueRef(SECRET, 1234),
    )
  })
})

describe('opaque-public-ref scheme — frozen cross-repo URL-contract vectors', () => {
  it('generic ref matches the frozen known-answer vector', () => {
    expect(
      deriveFreshlyBakedUsOpaquePublicRef(SECRET, 'fbus-go', 'bronx\u0000static\u0000buy-legal'),
    ).toBe('pML_SSmfqOqxSlHIQ3QM')
  })

  it('branding refs match the frozen known-answer vectors', () => {
    expect(deriveFreshlyBakedUsBrandOpaqueRef(SECRET, 1)).toBe('43HM0632radpVvEdiYWj')
    expect(deriveFreshlyBakedUsBrandOpaqueRef(SECRET, 42)).toBe('-NjvyVs1MrN2lrEA71Vv')
    expect(deriveFreshlyBakedUsBrandOpaqueRef(SECRET, 1234)).toBe('h78SFgtcQNLHNzKo37r1')
    expect(deriveFreshlyBakedUsBrandOpaqueRef(SECRET, 987654)).toBe('7UJAMUE0KiXD3vZgHQiU')
  })
})
