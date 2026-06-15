import { describe, expect, it } from 'vitest'

import { parseSegmentMembersResponse } from './customers.js'

const SEG = 10282

describe('parseSegmentMembersResponse (fail-closed segment.get parser)', () => {
  it('parses a bare array of {id}', () => {
    const out = parseSegmentMembersResponse([{ id: 1 }, { id: 2 }], SEG)
    expect(out.map((m) => m.customerId)).toEqual([1, 2])
  })

  it('parses { customers: [...] } with customerId field', () => {
    const out = parseSegmentMembersResponse({ customers: [{ customerId: 5 }, { customerId: 6 }] }, SEG)
    expect(out.map((m) => m.customerId)).toEqual([5, 6])
  })

  it('parses { data: [...] } and nested customer.id', () => {
    const out = parseSegmentMembersResponse({ data: [{ customer: { id: 9 } }] }, SEG)
    expect(out.map((m) => m.customerId)).toEqual([9])
  })

  it('parses nested { segment: { members: [...] } }', () => {
    const out = parseSegmentMembersResponse({ segment: { members: [{ clientId: 11 }] } }, SEG)
    expect(out.map((m) => m.customerId)).toEqual([11])
  })

  it('parses bare scalar ids', () => {
    const out = parseSegmentMembersResponse([1, 2, 3], SEG)
    expect(out.map((m) => m.customerId)).toEqual([1, 2, 3])
  })

  it('carries enabled + dateOnEnter when present', () => {
    const out = parseSegmentMembersResponse(
      { customers: [{ id: 1, enabled: false, dateOnEnter: '2026-01-02' }] },
      SEG,
    )
    expect(out[0]).toEqual({ customerId: 1, enabled: false, dateOnEnter: '2026-01-02' })
  })

  it('dedups repeated customer ids', () => {
    const out = parseSegmentMembersResponse({ customers: [{ id: 7 }, { id: 7 }, { id: 8 }] }, SEG)
    expect(out.map((m) => m.customerId)).toEqual([7, 8])
  })

  it('returns [] for a recognised-but-empty member array', () => {
    expect(parseSegmentMembersResponse({ customers: [] }, SEG)).toEqual([])
    expect(parseSegmentMembersResponse([], SEG)).toEqual([])
  })

  it('returns [] for an explicit zero-count envelope', () => {
    expect(parseSegmentMembersResponse({ totalCount: 0 }, SEG)).toEqual([])
    expect(parseSegmentMembersResponse({ segment: { totalCustomers: 0 } }, SEG)).toEqual([])
  })

  it('THROWS (fail-closed) on an unrecognised envelope', () => {
    expect(() => parseSegmentMembersResponse({ weird: { shape: true } }, SEG)).toThrow(/unrecognised shape/)
    expect(() => parseSegmentMembersResponse('nope', SEG)).toThrow(/unrecognised shape/)
  })

  it('THROWS when a non-empty member array yields zero parseable ids', () => {
    expect(() => parseSegmentMembersResponse({ customers: [{ foo: 'bar' }, { baz: 1 }] }, SEG)).toThrow(
      /none had a parseable customer id/,
    )
  })

  it('ignores unparseable members but keeps parseable ones', () => {
    const out = parseSegmentMembersResponse({ customers: [{ id: 1 }, { foo: 'x' }, { customerId: 2 }] }, SEG)
    expect(out.map((m) => m.customerId)).toEqual([1, 2])
  })
})
