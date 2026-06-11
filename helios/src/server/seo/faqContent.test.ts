import { describe, expect, it } from 'vitest'

import {
  FAQ_SET_ID_RE,
  SEO_APPROVAL_ID_RE,
  buildFaqPageJsonLd,
  checkFaqSetApprovable,
  faqSetContentSha256,
  findRawOnlyLeaks,
  newFaqSetId,
  newSeoApprovalId,
  visibleFaqAnswer,
  type FaqItemInput,
} from './faqContent.js'

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
