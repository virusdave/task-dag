import { describe, expect, it } from 'vitest'

import {
  FAQ_SET_ID_RE,
  FBUS_DENY_TERMS,
  FBUS_EXTRA_DENY_TERMS,
  RAW_ONLY_TERMS,
  SEO_APPROVAL_ID_RE,
  buildFaqPageJsonLd,
  checkFaqSetApprovable,
  describeFbusLeaks,
  faqSetContentSha256,
  findFbusLeaks,
  findRawOnlyLeaks,
  hasFbusLeak,
  newFaqSetId,
  newSeoApprovalId,
  visibleFaqAnswer,
  type FaqItemInput,
} from './faqContent.js'
import { FBUS_GLOBAL_FAQ_SOURCE_KEY } from './faqSourceKey.js'

const baseItems = (): FaqItemInput[] => [
  {
    question: 'What are your store hours?',
    answer_raw: 'We are open 9am-9pm and stock fresh cannabis flower daily.',
    answer_sanitized: 'We are open 9am-9pm and restock our products daily.',
  },
]

const baseInput = () => ({ faq_set_id: 'faqset_x', scope: 'all', items: baseItems() })

describe('id minting', () => {
  it('mints structured, format-valid ids', () => {
    const now = new Date('2026-06-11T18:09:54Z')
    expect(FAQ_SET_ID_RE.test(newFaqSetId(now))).toBe(true)
    expect(SEO_APPROVAL_ID_RE.test(newSeoApprovalId(now))).toBe(true)
  })
})

describe('faqSetContentSha256', () => {
  it('is a hex sha256', () => {
    expect(faqSetContentSha256(baseInput())).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable regardless of item object key order', () => {
    const a = faqSetContentSha256(baseInput())
    const reordered = {
      faq_set_id: 'faqset_x',
      scope: 'all',
      items: [
        {
          answer_sanitized: baseItems()[0]!.answer_sanitized,
          answer_raw: baseItems()[0]!.answer_raw,
          question: baseItems()[0]!.question,
        },
      ],
    }
    expect(faqSetContentSha256(reordered)).toBe(a)
  })

  it('changes when faq_set_id changes', () => {
    expect(faqSetContentSha256({ ...baseInput(), faq_set_id: 'faqset_y' })).not.toBe(
      faqSetContentSha256(baseInput()),
    )
  })

  it('changes when scope changes', () => {
    expect(faqSetContentSha256({ ...baseInput(), scope: 'site-123' })).not.toBe(
      faqSetContentSha256(baseInput()),
    )
  })

  it('changes when question changes', () => {
    const items = baseItems()
    items[0] = { ...items[0]!, question: 'Different?' }
    expect(faqSetContentSha256({ ...baseInput(), items })).not.toBe(
      faqSetContentSha256(baseInput()),
    )
  })

  it('changes when answer_raw changes', () => {
    const items = baseItems()
    items[0] = { ...items[0]!, answer_raw: 'changed raw' }
    expect(faqSetContentSha256({ ...baseInput(), items })).not.toBe(
      faqSetContentSha256(baseInput()),
    )
  })

  it('changes when answer_sanitized changes', () => {
    const items = baseItems()
    items[0] = { ...items[0]!, answer_sanitized: 'changed sanitized' }
    expect(faqSetContentSha256({ ...baseInput(), items })).not.toBe(
      faqSetContentSha256(baseInput()),
    )
  })
})

describe('findRawOnlyLeaks', () => {
  it('flags whole-token cannabis terms case-insensitively', () => {
    expect(findRawOnlyLeaks('Try our THC gummies and CBD oil')).toEqual(
      expect.arrayContaining(['thc', 'gummies', 'cbd']),
    )
  })

  it('does not false-positive on substrings', () => {
    // "thc" inside "ethical", "dab" inside "database", "cbd" nowhere
    expect(findRawOnlyLeaks('Our ethical database approach')).toEqual([])
  })

  it('returns empty for clean sanitized copy', () => {
    expect(findRawOnlyLeaks('We restock our wellness products daily.')).toEqual([])
  })
})

describe('checkFaqSetApprovable', () => {
  it('passes a clean set', () => {
    expect(checkFaqSetApprovable(baseItems())).toEqual([])
  })

  it('rejects an empty set', () => {
    expect(checkFaqSetApprovable([]).length).toBeGreaterThan(0)
  })

  it('rejects empty fields', () => {
    const problems = checkFaqSetApprovable([
      { question: '', answer_raw: '', answer_sanitized: '' },
    ])
    expect(problems.some((p) => p.field === 'question')).toBe(true)
    expect(problems.some((p) => p.field === 'answer_raw')).toBe(true)
    expect(problems.some((p) => p.field === 'answer_sanitized')).toBe(true)
  })

  it('rejects raw-only terms leaking into the shared question', () => {
    const problems = checkFaqSetApprovable([
      {
        question: 'How much THC is in your products?',
        answer_raw: 'Varies by product.',
        answer_sanitized: 'Varies by product.',
      },
    ])
    expect(problems.some((p) => p.field === 'question')).toBe(true)
  })

  it('rejects raw-only terms leaking into the sanitized answer', () => {
    const problems = checkFaqSetApprovable([
      {
        question: 'What do you sell?',
        answer_raw: 'We sell cannabis flower.',
        answer_sanitized: 'We sell cannabis flower.',
      },
    ])
    expect(problems.some((p) => p.field === 'answer_sanitized')).toBe(true)
  })
})

describe('checkFaqSetApprovable — FBUS-strict enforcement (CI gate 2)', () => {
  // An FBUS set whose shared question + sanitized answer are clean, with a
  // raw answer that legitimately carries the NYC/raw variant.
  const fbusCleanItems = (): FaqItemInput[] => [
    {
      question: 'What are your store hours?',
      answer_raw: 'We are open 9am-9pm; see our cannabis flower menu at freshlybaked.nyc.',
      answer_sanitized: 'We are open 9am-9pm and restock our products daily.',
    },
  ]

  it('passes an FBUS set whose shared/sanitized fields are clean (raw may carry NYC copy)', () => {
    expect(checkFaqSetApprovable(fbusCleanItems(), { sourceKey: FBUS_GLOBAL_FAQ_SOURCE_KEY })).toEqual(
      [],
    )
  })

  it('does NOT subject the raw answer to the FBUS rule', () => {
    const problems = checkFaqSetApprovable(fbusCleanItems(), {
      sourceKey: FBUS_GLOBAL_FAQ_SOURCE_KEY,
    })
    expect(problems.every((p) => p.field !== 'answer_raw')).toBe(true)
  })

  it('rejects an FBUS-extra meta-term (flower) in the sanitized answer that the host-agnostic rule tolerates', () => {
    const items: FaqItemInput[] = [
      {
        question: 'What do you stock?',
        answer_raw: 'Fresh flower daily.',
        answer_sanitized: 'Our finest flower today.',
      },
    ]
    // Host-agnostic rule tolerates "flower" → approvable.
    expect(checkFaqSetApprovable(items)).toEqual([])
    // FBUS rule rejects it.
    const problems = checkFaqSetApprovable(items, { sourceKey: FBUS_GLOBAL_FAQ_SOURCE_KEY })
    expect(problems.some((p) => p.field === 'answer_sanitized')).toBe(true)
  })

  it('rejects an FBUS-extra meta-term (strains) in the shared question', () => {
    const problems = checkFaqSetApprovable(
      [
        {
          question: 'Which strains are popular?',
          answer_raw: 'Many options.',
          answer_sanitized: 'Many options.',
        },
      ],
      { sourceKey: FBUS_GLOBAL_FAQ_SOURCE_KEY },
    )
    expect(problems.some((p) => p.field === 'question')).toBe(true)
  })

  it('rejects a .nyc host/URL leaking into the sanitized answer for an FBUS set', () => {
    const problems = checkFaqSetApprovable(
      [
        {
          question: 'Where else can I shop?',
          answer_raw: 'Visit us in store.',
          answer_sanitized: 'Visit our sibling at https://www.freshlybaked.nyc/menu.',
        },
      ],
      { sourceKey: FBUS_GLOBAL_FAQ_SOURCE_KEY },
    )
    expect(problems.some((p) => p.field === 'answer_sanitized')).toBe(true)
  })

  it('rejects the "Freshly Baked NYC" brand phrase in the shared question for an FBUS set', () => {
    const problems = checkFaqSetApprovable(
      [
        {
          question: 'Are you the Freshly Baked NYC company?',
          answer_raw: 'We are a sister brand.',
          answer_sanitized: 'We are a sister brand.',
        },
      ],
      { sourceKey: FBUS_GLOBAL_FAQ_SOURCE_KEY },
    )
    expect(problems.some((p) => p.field === 'question')).toBe(true)
  })

  it('still rejects plain raw-only terms (thc) for an FBUS set (superset behavior)', () => {
    const problems = checkFaqSetApprovable(
      [
        {
          question: 'How much THC?',
          answer_raw: 'Varies.',
          answer_sanitized: 'Varies.',
        },
      ],
      { sourceKey: FBUS_GLOBAL_FAQ_SOURCE_KEY },
    )
    expect(problems.some((p) => p.field === 'question')).toBe(true)
  })

  it('keeps the host-agnostic behavior unchanged for a non-FBUS / null source key', () => {
    // "flower" in the sanitized answer is an FBUS-extra term, but the
    // host-agnostic rule (no/empty source key) tolerates it.
    const items: FaqItemInput[] = [
      {
        question: 'What do you stock?',
        answer_raw: 'Fresh flower daily.',
        answer_sanitized: 'Our finest flower today.',
      },
    ]
    expect(checkFaqSetApprovable(items)).toEqual([])
    expect(checkFaqSetApprovable(items, { sourceKey: null })).toEqual([])
    expect(checkFaqSetApprovable(items, {})).toEqual([])
  })

  it('fails closed on a non-null but unrecognized source key', () => {
    const problems = checkFaqSetApprovable(baseItems(), { sourceKey: 'not-a-real-key' })
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.some((p) => p.itemIndex === -1)).toBe(true)
  })

  it('ignores a whitespace-only source key (treated as no source key)', () => {
    expect(checkFaqSetApprovable(baseItems(), { sourceKey: '   ' })).toEqual([])
  })
})

describe('FBUS stricter denylist (.us sanitized host)', () => {
  it('is a strict superset of RAW_ONLY_TERMS', () => {
    for (const term of RAW_ONLY_TERMS) {
      expect(FBUS_DENY_TERMS).toContain(term)
    }
    expect(FBUS_DENY_TERMS.length).toBeGreaterThan(RAW_ONLY_TERMS.length)
  })

  it('adds the §5-named ambiguous meta-terms the host-agnostic list tolerates', () => {
    // These are deliberately ABSENT from RAW_ONLY_TERMS but REQUIRED for FBUS.
    for (const term of ['flower', 'flowers', 'strain', 'strains']) {
      expect(RAW_ONLY_TERMS).not.toContain(term)
      expect(FBUS_EXTRA_DENY_TERMS).toContain(term)
      expect(findRawOnlyLeaks(`Our finest ${term} today`)).toEqual([])
      expect(findFbusLeaks(`Our finest ${term} today`).terms).toContain(term)
    }
  })
})

describe('findFbusLeaks', () => {
  it('returns fully clean for sanitized retail copy', () => {
    const leaks = findFbusLeaks('We are open 9am-9pm and restock our products daily.')
    expect(leaks.terms).toEqual([])
    expect(leaks.nycHosts).toEqual([])
    expect(leaks.nycBrandPhrase).toBe(false)
    expect(hasFbusLeak('We are open 9am-9pm and restock our products daily.')).toBe(false)
    expect(describeFbusLeaks('We are open 9am-9pm and restock our products daily.')).toEqual([])
  })

  it('flags both raw-only and FBUS-extra meta-terms, whole-token & case-insensitive', () => {
    const leaks = findFbusLeaks('Fresh CANNABIS Flower and premium Strains in stock')
    expect(leaks.terms).toEqual(expect.arrayContaining(['cannabis', 'flower', 'strains']))
  })

  it('does not false-positive on substrings of meta-terms', () => {
    // "cartridge" near "Descartes", "bud" inside "budget", "flower" inside
    // "flowering" should NOT match; "cbg" nowhere.
    const leaks = findFbusLeaks('Descartes budget for the flowering catalog')
    expect(leaks.terms).toEqual([])
  })

  it('still tolerates generic everyday words excluded by design', () => {
    // We deliberately do NOT deny these to avoid heavy false positives.
    const leaks = findFbusLeaks('High-quality service, our bar is open, join the green initiative')
    expect(leaks.terms).toEqual([])
  })

  it('catches singular and plural/spaced pre-roll variants', () => {
    for (const variant of ['preroll', 'pre-roll', 'prerolls', 'pre-rolls', 'pre roll', 'pre rolls']) {
      expect(findFbusLeaks(`We stock ${variant} options`).terms).toContain(variant)
    }
  })

  it('detects any *.nyc host and captures it', () => {
    const leaks = findFbusLeaks('Visit our sibling at https://www.freshlybaked.nyc/menu today')
    expect(leaks.nycHosts).toContain('www.freshlybaked.nyc')
    expect(hasFbusLeak('https://www.freshlybaked.nyc/menu')).toBe(true)
  })

  it('detects a bare freshlybaked.nyc host', () => {
    expect(findFbusLeaks('email us at hi@freshlybaked.nyc').nycHosts).toContain('freshlybaked.nyc')
  })

  it('does not treat a bare "nyc" word or non-.nyc host as a leak', () => {
    const leaks = findFbusLeaks('We serve all of NYC from our nyc-area warehouse at example.nycdata.com')
    expect(leaks.nycHosts).toEqual([])
    expect(leaks.nycBrandPhrase).toBe(false)
    expect(leaks.terms).toEqual([])
  })

  it('conservatively flags a .nyc label even mid-host (fail-closed)', () => {
    // foo.nyc.evil.com embeds a `.nyc` host label; we fail closed and flag
    // it rather than risk missing a disguised sibling-brand reference.
    expect(findFbusLeaks('see foo.nyc.evil.com').nycHosts).toContain('foo.nyc')
  })

  it('detects the "Freshly Baked NYC" brand phrase regardless of spacing/case', () => {
    expect(findFbusLeaks('A Freshly Baked NYC company').nycBrandPhrase).toBe(true)
    expect(findFbusLeaks('freshly   baked   nyc').nycBrandPhrase).toBe(true)
  })

  it('describeFbusLeaks surfaces every category as markers', () => {
    const markers = describeFbusLeaks(
      'Our Freshly Baked NYC flower menu lives at https://shop.freshlybaked.nyc',
    )
    expect(markers).toContain('flower')
    expect(markers).toContain('.nyc-url:shop.freshlybaked.nyc')
    expect(markers).toContain('nyc-brand-phrase')
  })
})

describe('buildFaqPageJsonLd (no cloaking)', () => {
  it('uses the visible answer exactly for the chosen mode', () => {
    const items = baseItems()
    const rawLd = buildFaqPageJsonLd(items, 'raw') as {
      mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>
    }
    const sanLd = buildFaqPageJsonLd(items, 'sanitized') as {
      mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>
    }
    expect(rawLd.mainEntity[0]!.name).toBe(items[0]!.question)
    expect(rawLd.mainEntity[0]!.acceptedAnswer.text).toBe(visibleFaqAnswer(items[0]!, 'raw'))
    expect(sanLd.mainEntity[0]!.acceptedAnswer.text).toBe(
      visibleFaqAnswer(items[0]!, 'sanitized'),
    )
    expect(rawLd.mainEntity[0]!.acceptedAnswer.text).not.toBe(
      sanLd.mainEntity[0]!.acceptedAnswer.text,
    )
  })
})
