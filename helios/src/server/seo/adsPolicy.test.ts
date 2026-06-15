import { describe, expect, it } from 'vitest'

import {
  describeAdsPolicyViolations,
  findAdsPolicyViolations,
  findFaqAdsPolicyProblems,
  hasAdsPolicyViolation,
  type AdsPolicyCategory,
} from './adsPolicy.js'
import type { FaqItemInput } from './faqContent.js'

function categories(text: string): AdsPolicyCategory[] {
  return [...new Set(findAdsPolicyViolations(text).map((f) => f.category))]
}

describe('findAdsPolicyViolations — category detection', () => {
  it('flags medical / therapeutic claims', () => {
    expect(categories('This product treats anxiety and offers real pain relief.')).toContain(
      'medical',
    )
    expect(hasAdsPolicyViolation('Our gummies are clinically proven and FDA approved.')).toBe(
      true,
    )
    expect(categories('It cures everything.')).toEqual(['medical'])
  })

  it('flags overbroad legality claims', () => {
    expect(categories('This is 100% legal in all 50 states.')).toContain('legal')
    expect(hasAdsPolicyViolation('No prescription needed, totally legal.')).toBe(true)
  })

  it('flags recreational effect claims', () => {
    expect(categories('These will get you high and are very intoxicating.')).toContain('effect')
    expect(hasAdsPolicyViolation('A guaranteed high every time.')).toBe(true)
  })

  it('flags competitor disparagement', () => {
    expect(categories('We are better than our competitors, unlike other dispensaries.')).toContain(
      'disparagement',
    )
  })

  it('flags unsourced price / availability promises', () => {
    expect(categories('We have the lowest price and offer a price match guarantee.')).toContain(
      'price_availability',
    )
    expect(hasAdsPolicyViolation('Always in stock, guaranteed in stock.')).toBe(true)
  })

  it('detects multiple distinct categories in one text', () => {
    const cats = categories(
      'It cures pain, is 100% legal, will get you high, beat the competition, cheapest around.',
    )
    expect(cats.sort()).toEqual(
      ['disparagement', 'effect', 'legal', 'medical', 'price_availability'].sort(),
    )
  })
})

describe('findAdsPolicyViolations — false-positive guards', () => {
  it('returns nothing for ordinary retail FAQ copy', () => {
    const clean = [
      'What are your store hours? We are open 9am-9pm daily and restock our products often.',
      'Treat yourself to our loyalty program and earn points on every order.',
      'There is a lot of buzz about our new menu — secure your favorites early.',
      'Our baked goods are made fresh; a manicure is not included, but the procedure to order is easy.',
      'We offer competitive prices and fast, reliable delivery across the city.',
    ].join(' ')
    expect(findAdsPolicyViolations(clean)).toEqual([])
  })

  it('does not flag the brand word "baked" or everyday "treat"', () => {
    expect(hasAdsPolicyViolation('Freshly Baked is the best — come treat yourself!')).toBe(false)
  })

  it('matches whole tokens only ("cure" not "secure"/"manicure"/"procedure")', () => {
    expect(hasAdsPolicyViolation('Please secure your appointment; the procedure is quick.')).toBe(
      false,
    )
  })

  it('handles empty / nullish text without throwing', () => {
    expect(findAdsPolicyViolations('')).toEqual([])
    // @ts-expect-error exercising the runtime null guard
    expect(findAdsPolicyViolations(null)).toEqual([])
  })
})

describe('findAdsPolicyViolations — matching semantics', () => {
  it('is case-insensitive', () => {
    expect(hasAdsPolicyViolation('CLINICALLY PROVEN to work')).toBe(true)
  })

  it('tolerates hyphen-vs-space in multi-word phrases', () => {
    expect(categories('a mind-altering experience')).toContain('effect')
    expect(categories('a mind altering experience')).toContain('effect')
  })

  it('reports each distinct phrase once', () => {
    const findings = findAdsPolicyViolations('cheapest, cheapest, the cheapest of all')
    expect(findings.filter((f) => f.phrase === 'cheapest')).toHaveLength(1)
  })
})

describe('describeAdsPolicyViolations', () => {
  it('emits <category>:<phrase> markers', () => {
    expect(describeAdsPolicyViolations('it cures all')).toEqual(['medical:cures'])
    expect(describeAdsPolicyViolations('squeaky clean retail copy')).toEqual([])
  })
})

describe('findFaqAdsPolicyProblems', () => {
  const items = (): FaqItemInput[] => [
    {
      question: 'Do you have the lowest price?',
      answer_raw: 'Yes, our cannabis flower cures anxiety.',
      answer_sanitized: 'Yes, we restock our products daily.',
    },
    {
      question: 'When are you open?',
      answer_raw: 'We are open 9am-9pm.',
      answer_sanitized: 'We are open 9am-9pm.',
    },
  ]

  it('finds per-item, per-field violations across raw, sanitized, and the shared question', () => {
    const problems = findFaqAdsPolicyProblems(items())
    // item 0 question: price_availability; item 0 answer_raw: medical
    expect(problems).toEqual(
      expect.arrayContaining([
        { itemIndex: 0, field: 'question', category: 'price_availability', phrase: 'lowest price' },
        { itemIndex: 0, field: 'answer_raw', category: 'medical', phrase: 'cures' },
      ]),
    )
    // The clean second item contributes nothing.
    expect(problems.every((p) => p.itemIndex === 0)).toBe(true)
  })

  it('returns an empty list for fully clean items', () => {
    const clean: FaqItemInput[] = [
      {
        question: 'When do you restock?',
        answer_raw: 'We restock our shelves every morning.',
        answer_sanitized: 'We restock our shelves every morning.',
      },
    ]
    expect(findFaqAdsPolicyProblems(clean)).toEqual([])
  })
})
