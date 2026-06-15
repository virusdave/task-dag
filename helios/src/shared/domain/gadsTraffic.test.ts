import { describe, expect, it } from 'vitest'

import { isPaidGadsTraffic } from './gadsTraffic.js'

// Encodes the P0 audit §2.2 truth table verbatim
// (docs/helios/gads-landing-analytics/P0_AUDIT.md). This is the
// mandated P2 unit test for the locked paid-GAds-traffic predicate.
describe('isPaidGadsTraffic (P0 §2.2 truth table)', () => {
  const cases: Array<{
    keyType: string | null
    flags: string[] | null
    expected: boolean
    why: string
  }> = [
    { keyType: 'gclid', flags: null, expected: true, why: 'gclid click id' },
    { keyType: 'gbraid', flags: [], expected: true, why: 'gbraid click id' },
    { keyType: 'wbraid', flags: ['paid_google'], expected: true, why: 'wbraid click id' },
    {
      keyType: 'gclid',
      flags: ['bot_suspected'],
      expected: false,
      why: 'bot exclusion overrides a gclid key',
    },
    {
      keyType: 'cookie',
      flags: ['paid_google'],
      expected: true,
      why: 'explicit paid_google tag on a fallback key',
    },
    { keyType: 'cookie', flags: null, expected: false, why: 'bare cookie fallback' },
    { keyType: 'session', flags: [], expected: false, why: 'bare session fallback' },
    { keyType: 'default', flags: null, expected: false, why: 'bare default fallback' },
    { keyType: null, flags: ['paid_google'], expected: true, why: 'paid_google with no key type' },
    { keyType: null, flags: null, expected: false, why: 'no key type, no flags' },
    {
      keyType: 'gclid',
      flags: ['paid_google', 'bot_suspected'],
      expected: false,
      why: 'bot exclusion overrides gclid + paid_google',
    },
  ]

  for (const { keyType, flags, expected, why } of cases) {
    it(`${why}: keyType=${keyType ?? 'null'} flags=${JSON.stringify(flags)} -> ${expected}`, () => {
      expect(isPaidGadsTraffic(keyType, flags)).toBe(expected)
    })
  }

  it('treats a non-array traffic_flags value as no flags (defensive)', () => {
    // The decoder should hand us an array or null, but never trust it.
    expect(isPaidGadsTraffic('cookie', 'paid_google' as unknown as string[])).toBe(false)
    expect(isPaidGadsTraffic('gclid', {} as unknown as string[])).toBe(true)
  })
})
