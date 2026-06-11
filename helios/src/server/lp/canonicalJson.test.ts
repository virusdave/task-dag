import { describe, expect, it } from 'vitest'

import { canonicalJsonStringify } from './canonicalJson.js'

describe('canonicalJsonStringify', () => {
  it('sorts object keys deterministically regardless of insertion order', () => {
    const a = canonicalJsonStringify({ b: 1, a: 2, c: 3 })
    const b = canonicalJsonStringify({ c: 3, a: 2, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":2,"b":1,"c":3}')
  })

  it('preserves array order and recurses', () => {
    expect(canonicalJsonStringify({ z: [{ y: 1, x: 2 }], a: 'k' })).toBe('{"a":"k","z":[{"x":2,"y":1}]}')
  })

  it('drops undefined-valued keys (matches JSON.stringify)', () => {
    expect(canonicalJsonStringify({ a: undefined, b: 1 })).toBe('{"b":1}')
  })

  it('handles primitives and null', () => {
    expect(canonicalJsonStringify(null)).toBe('null')
    expect(canonicalJsonStringify('x')).toBe('"x"')
    expect(canonicalJsonStringify(42)).toBe('42')
    expect(canonicalJsonStringify(true)).toBe('true')
  })

  it('throws on non-finite numbers', () => {
    expect(() => canonicalJsonStringify(Number.NaN)).toThrow()
  })
})
