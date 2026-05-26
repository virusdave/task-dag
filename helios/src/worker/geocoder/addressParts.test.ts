import { describe, expect, it } from 'vitest'

import { normaliseAddressParts } from './addressParts.js'

describe('normaliseAddressParts', () => {
  it('lowercases, single-spaces, and strips punctuation while preserving raw casing', () => {
    const r = normaliseAddressParts({
      line1: '  123  Main   St.  ',
      line2: 'Apt #4B',
      city: 'Brooklyn',
      state: 'NY',
      zip: '11201',
    })
    expect(r.rawLine1).toBe('123  Main   St.')
    expect(r.rawLine2).toBe('Apt #4B')
    expect(r.rawCity).toBe('Brooklyn')
    expect(r.rawState).toBe('NY')
    expect(r.rawZip).toBe('11201')
    expect(r.normalized).toBe('123 main st apt #4b brooklyn ny 11201')
  })

  it('treats two physically-equal addresses with different formatting as the same dedup key', () => {
    const a = normaliseAddressParts({
      line1: '450 Broadway, Floor 2',
      city: 'New York',
      state: 'NY',
      zip: '10013',
    })
    const b = normaliseAddressParts({
      line1: '  450   broadway   floor   2  ',
      city: 'New York',
      state: 'ny',
      zip: '10013',
    })
    expect(a.normalized).toBe(b.normalized)
    expect(a.normalized).toBe('450 broadway floor 2 new york ny 10013')
  })

  it('produces the same normalized key whether line2 is null or empty', () => {
    const withNull = normaliseAddressParts({
      line1: '1 World Trade Center',
      line2: null,
      city: 'New York',
      state: 'NY',
      zip: '10007',
    })
    const withEmpty = normaliseAddressParts({
      line1: '1 World Trade Center',
      line2: '',
      city: 'New York',
      state: 'NY',
      zip: '10007',
    })
    expect(withNull.normalized).toBe(withEmpty.normalized)
    expect(withNull.normalized).toBe('1 world trade center new york ny 10007')
  })

  it('preserves apostrophes, ampersands, hyphens, slashes, and # in normalized form', () => {
    const r = normaliseAddressParts({
      line1: "O'Brien & Wallace-Smith Bldg #3",
      city: 'Jersey City',
      state: 'NJ',
      zip: '07302',
    })
    expect(r.normalized).toBe("o'brien & wallace-smith bldg #3 jersey city nj 07302")
  })

  it('collapses ZIP to 5 digits regardless of input format (ZIP+4, with hyphen, with spaces)', () => {
    expect(normaliseAddressParts({ zip: '11201-1234' }).normalized).toBe('11201')
    expect(normaliseAddressParts({ zip: '  11201  ' }).normalized).toBe('11201')
    expect(normaliseAddressParts({ zip: '112011234' }).normalized).toBe('11201')
  })

  it('omits empty components from the joined key but keeps raw fields null', () => {
    const r = normaliseAddressParts({
      line1: '500 Henry St',
      line2: null,
      city: '',
      state: 'NY',
      zip: '11231',
    })
    expect(r.rawCity).toBeNull()
    expect(r.rawLine2).toBeNull()
    expect(r.normalized).toBe('500 henry st ny 11231')
  })

  it('returns empty normalized when every component is blank or missing', () => {
    expect(normaliseAddressParts({}).normalized).toBe('')
    expect(
      normaliseAddressParts({
        line1: '   ',
        line2: '',
        city: null,
        state: undefined,
        zip: '',
      }).normalized,
    ).toBe('')
  })

  it('does not strip the # unit marker', () => {
    const r = normaliseAddressParts({ line1: 'Suite #200' })
    expect(r.normalized).toBe('suite #200')
  })

  it('handles bizarre punctuation runs without leaving double spaces', () => {
    const r = normaliseAddressParts({
      line1: '12,, Park.... Ave;;',
      city: '"Hoboken"',
      state: '(NJ)',
      zip: '07030',
    })
    expect(r.normalized).toBe('12 park ave hoboken nj 07030')
  })

  it('strips non-digit ZIP characters but keeps a non-US-shaped ZIP raw', () => {
    // 6-character UK-ish input: raw is preserved untouched, normalized
    // takes the first 5 digits (here only 2 -> dropped from the key).
    const r = normaliseAddressParts({ zip: 'SW1A 1' })
    expect(r.rawZip).toBe('SW1A 1')
    expect(r.normalized).toBe('') // no other components, and zip has < 5 digits
  })
})
