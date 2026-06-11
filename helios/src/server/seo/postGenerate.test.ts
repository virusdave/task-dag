import { describe, expect, it } from 'vitest'

import { parsePostGenerationContent } from './postGenerate.js'

function validDraftJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    slug: 'summer-rooftop-events',
    title: 'Summer Rooftop Events',
    meta_description: 'The best rooftop happenings this summer.',
    excerpt: 'A roundup of NYC rooftop events.',
    tags: ['nyc-culture', 'events'],
    body_raw: 'Rooftop season is here with cannabis-friendly meetups.',
    body_sanitized: 'Rooftop season is here with friendly meetups.',
    ...overrides,
  })
}

describe('parsePostGenerationContent', () => {
  it('parses a well-formed draft', () => {
    const draft = parsePostGenerationContent(validDraftJson())
    expect(draft.slug).toBe('summer-rooftop-events')
    expect(draft.tags).toEqual(['nyc-culture', 'events'])
    expect(draft.title).toBe('Summer Rooftop Events')
  })

  it('lowercases the slug and trims string fields', () => {
    const draft = parsePostGenerationContent(
      validDraftJson({ slug: 'Summer-Rooftop-Events', title: '  Trimmed  ' }),
    )
    expect(draft.slug).toBe('summer-rooftop-events')
    expect(draft.title).toBe('Trimmed')
  })

  it('drops empty/blank tags', () => {
    const draft = parsePostGenerationContent(validDraftJson({ tags: ['a', '', '  ', 'b'] }))
    expect(draft.tags).toEqual(['a', 'b'])
  })

  it('throws on an invalid slug', () => {
    expect(() => parsePostGenerationContent(validDraftJson({ slug: 'Not A Slug!' }))).toThrow()
  })

  it('throws when a required field is missing', () => {
    expect(() =>
      parsePostGenerationContent(JSON.stringify({ slug: 'x', title: 'y' })),
    ).toThrow()
  })

  it('throws when tags is not an array', () => {
    expect(() => parsePostGenerationContent(validDraftJson({ tags: 'nope' }))).toThrow()
  })

  it('throws when a required field is empty', () => {
    expect(() => parsePostGenerationContent(validDraftJson({ body_sanitized: '' }))).toThrow()
  })
})
