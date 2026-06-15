import { describe, expect, it } from 'vitest'

import {
  FAQ_SOURCE_KEY_RE,
  FBUS_DEDICATED_FAQ_SOURCE_KEY,
  FBUS_FAQ_SOURCE_NAMESPACE,
  FBUS_GLOBAL_FAQ_SOURCE_KEY,
  FaqSourceKeySchema,
  FbusFaqSourceKeySchema,
  familyFromFaqSourceKey,
  fbusFaqSourceKey,
  isFaqSourceKey,
  isFbusFaqSourceKey,
  parseFaqSourceKey,
  seoModeForFaqSourceKey,
} from './faqSourceKey.js'

describe('faqSourceKey — grammar', () => {
  it.each([
    'fbus-global-faq',
    'fbus-deliverance-faq',
    'fbus-dedicated-faq',
    'fbus-conquest-faq',
    'fbus-tours-faq',
    'fbus-recurse-faq',
    'fbus-branding-faq',
    'fbus-compare-faq',
    'fbus-multi-word-family-faq', // multi-segment family slug
    'fbus-a-faq', // single-char family
    'fbus-f1-faq', // alnum family
  ])('accepts %s', (key) => {
    expect(isFaqSourceKey(key)).toBe(true)
    expect(FAQ_SOURCE_KEY_RE.test(key)).toBe(true)
  })

  it.each([
    '', // empty
    'fbus-faq', // no family
    'fbus--faq', // empty family
    'global-faq', // unknown / missing host namespace
    'fbnyc-global-faq', // host namespace not (yet) recognized
    'fbus-global', // missing -faq suffix
    'fbus-global-faqs', // wrong suffix
    'FBUS-global-faq', // uppercase namespace
    'fbus-Global-faq', // uppercase family
    'fbus-global-faq ', // trailing space
    ' fbus-global-faq', // leading space
    'fbus-global_faq', // underscore not allowed
    'fbus-glob al-faq', // space in family
    'fbus-deliverance-faq-extra', // trailing junk
  ])('rejects %s', (key) => {
    expect(isFaqSourceKey(key)).toBe(false)
    expect(parseFaqSourceKey(key)).toBeNull()
  })
})

describe('faqSourceKey — parsing & classification', () => {
  it('parses an FBUS LP-family key into its parts', () => {
    expect(parseFaqSourceKey('fbus-deliverance-faq')).toEqual({
      sourceKey: 'fbus-deliverance-faq',
      hostNamespace: 'fbus',
      family: 'deliverance',
      mode: 'sanitized',
      isFbus: true,
    })
  })

  it('keeps a multi-segment family slug intact', () => {
    expect(familyFromFaqSourceKey('fbus-multi-word-family-faq')).toBe('multi-word-family')
  })

  it('classifies every fbus key as sanitized-mode FBUS', () => {
    expect(isFbusFaqSourceKey('fbus-global-faq')).toBe(true)
    expect(seoModeForFaqSourceKey('fbus-global-faq')).toBe('sanitized')
  })

  it('returns null facts for non-keys', () => {
    expect(familyFromFaqSourceKey('nope')).toBeNull()
    expect(seoModeForFaqSourceKey('nope')).toBeNull()
    expect(isFbusFaqSourceKey('nope')).toBe(false)
  })
})

describe('faqSourceKey — builder', () => {
  it('builds a canonical key from a family slug', () => {
    expect(fbusFaqSourceKey('conquest')).toBe('fbus-conquest-faq')
    expect(fbusFaqSourceKey('multi-word')).toBe('fbus-multi-word-faq')
  })

  it('round-trips through parse', () => {
    const key = fbusFaqSourceKey('tours')
    expect(familyFromFaqSourceKey(key)).toBe('tours')
  })

  it.each(['', 'Bad', 'has space', 'trailing-', '-leading', 'under_score'])(
    'throws on malformed family %p',
    (family) => {
      expect(() => fbusFaqSourceKey(family)).toThrow(/Invalid FBUS FAQ family slug/)
    },
  )
})

describe('faqSourceKey — well-known structural keys', () => {
  it('pins the global + dedicated keys', () => {
    expect(FBUS_GLOBAL_FAQ_SOURCE_KEY).toBe('fbus-global-faq')
    expect(FBUS_DEDICATED_FAQ_SOURCE_KEY).toBe('fbus-dedicated-faq')
    expect(FBUS_FAQ_SOURCE_NAMESPACE).toBe('fbus')
  })
})

describe('faqSourceKey — zod schemas', () => {
  it('FaqSourceKeySchema accepts valid keys and rejects junk', () => {
    expect(FaqSourceKeySchema.safeParse('fbus-global-faq').success).toBe(true)
    expect(FaqSourceKeySchema.safeParse('global-faq').success).toBe(false)
  })

  it('FbusFaqSourceKeySchema only accepts FBUS keys', () => {
    expect(FbusFaqSourceKeySchema.safeParse('fbus-deliverance-faq').success).toBe(true)
    expect(FbusFaqSourceKeySchema.safeParse('not-a-key').success).toBe(false)
  })
})
