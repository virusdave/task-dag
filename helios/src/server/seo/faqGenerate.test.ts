import { describe, expect, it } from 'vitest'

import { parseFaqGenerationContent } from './faqGenerate.js'

describe('parseFaqGenerationContent', () => {
  it('parses a well-formed items array', () => {
    const json = JSON.stringify({
      items: [
        {
          question: 'What do you offer?',
          answer_raw: 'We offer cannabis products.',
          answer_sanitized: 'We offer a curated selection of products.',
        },
      ],
    })
    const items = parseFaqGenerationContent(json)
    expect(items).toHaveLength(1)
    expect(items[0]!.question).toBe('What do you offer?')
  })

  it('trims whitespace', () => {
    const json = JSON.stringify({
      items: [{ question: '  Q?  ', answer_raw: '  raw  ', answer_sanitized: '  san  ' }],
    })
    expect(parseFaqGenerationContent(json)[0]).toEqual({
      question: 'Q?',
      answer_raw: 'raw',
      answer_sanitized: 'san',
    })
  })

  it('throws when items is missing', () => {
    expect(() => parseFaqGenerationContent(JSON.stringify({ foo: 1 }))).toThrow()
  })

  it('throws when an item is missing a variant', () => {
    const json = JSON.stringify({ items: [{ question: 'Q', answer_raw: 'r' }] })
    expect(() => parseFaqGenerationContent(json)).toThrow()
  })

  it('throws when an item field is empty', () => {
    const json = JSON.stringify({
      items: [{ question: 'Q', answer_raw: 'r', answer_sanitized: '' }],
    })
    expect(() => parseFaqGenerationContent(json)).toThrow()
  })

  it('throws on an empty items array', () => {
    expect(() => parseFaqGenerationContent(JSON.stringify({ items: [] }))).toThrow()
  })
})
