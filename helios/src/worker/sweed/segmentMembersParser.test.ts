import { describe, expect, it } from 'vitest'

import { parseSegmentResultPage } from './customers.js'

const SEG = 1532

// Shape verified live (segment 1532 @ state dealer 210248, 2026-06):
//   { total, withEmail, withPhone, lastUpdated,
//     customers: { page, pageSize, totalCount, data: [ { customerId, dateOnEnter, … } ] } }
function page(data: unknown[], totalCount = data.length): Record<string, unknown> {
  return {
    total: totalCount,
    withEmail: 0,
    withPhone: 0,
    lastUpdated: '2026-06-15T03:36:03Z',
    customers: { page: 1, pageSize: 500, totalCount, data },
  }
}

describe('parseSegmentResultPage (fail-closed segment.result.list parser)', () => {
  it('parses the verified customers.data shape (string customerId + dateOnEnter)', () => {
    const out = parseSegmentResultPage(
      page([
        { customerId: '404200', dateOnEnter: '2025-07-15T12:34:56Z', customerName: 'x', age: 36 },
        { customerId: '407358', dateOnEnter: '2025-07-15T23:48:44Z' },
      ]),
      SEG,
    )
    expect(out.members).toEqual([
      { customerId: 404200, dateOnEnter: '2025-07-15T12:34:56Z' },
      { customerId: 407358, dateOnEnter: '2025-07-15T23:48:44Z' },
    ])
    expect(out.totalCount).toBe(2)
    expect(out.pageRowCount).toBe(2)
  })

  it('does not cache PII (only customerId + dateOnEnter survive)', () => {
    const out = parseSegmentResultPage(
      page([{ customerId: '1', customerName: 'Jane', dateOfBirth: '1990-01-01', hasEmail: true }]),
      SEG,
    )
    expect(out.members[0]).toEqual({ customerId: 1, dateOnEnter: null })
    expect(Object.keys(out.members[0]!)).toEqual(['customerId', 'dateOnEnter'])
  })

  it('reads totalCount from customers.totalCount (drives pagination)', () => {
    const out = parseSegmentResultPage(page([{ customerId: '1' }], 1412), SEG)
    expect(out.totalCount).toBe(1412)
    expect(out.pageRowCount).toBe(1)
  })

  it('falls back to top-level total when customers.totalCount is absent', () => {
    const raw = { total: 99, customers: { data: [{ customerId: '5' }] } }
    expect(parseSegmentResultPage(raw, SEG).totalCount).toBe(99)
  })

  it('tolerates a bare top-level data array', () => {
    const out = parseSegmentResultPage({ data: [{ customerId: '7' }], total: 1 }, SEG)
    expect(out.members.map((m) => m.customerId)).toEqual([7])
  })

  it('returns an empty page for a recognised-but-empty data array', () => {
    const out = parseSegmentResultPage(page([], 0), SEG)
    expect(out.members).toEqual([])
    expect(out.totalCount).toBe(0)
    expect(out.pageRowCount).toBe(0)
  })

  it('returns empty for an explicit zero-count envelope with no data array', () => {
    expect(parseSegmentResultPage({ total: 0, customers: { totalCount: 0 } }, SEG).members).toEqual([])
  })

  it('skips rows with no parseable customerId but keeps the rest', () => {
    const out = parseSegmentResultPage(page([{ customerId: '1' }, { foo: 'x' }, { customerId: '2' }]), SEG)
    expect(out.members.map((m) => m.customerId)).toEqual([1, 2])
  })

  it('THROWS (fail-closed) on an unrecognised envelope', () => {
    expect(() => parseSegmentResultPage({ weird: true }, SEG)).toThrow(/unrecognised shape/)
    expect(() => parseSegmentResultPage('nope', SEG)).toThrow(/unrecognised shape/)
    expect(() => parseSegmentResultPage([1, 2, 3], SEG)).toThrow(/unrecognised shape/)
  })

  it('THROWS when a non-empty page yields zero parseable customerIds', () => {
    expect(() => parseSegmentResultPage(page([{ foo: 'a' }, { bar: 'b' }]), SEG)).toThrow(
      /none had a parseable customerId/,
    )
  })
})
