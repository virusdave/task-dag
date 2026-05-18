/**
 * Unit tests for the static safety verifier.
 *
 * These exist as documentation of the verifier's contract and are run
 * by vitest when it's available. The pre-commit smoke gate does not
 * depend on them.
 */

import { describe, expect, it } from 'vitest'

import {
  verifyParser,
  type DialectPack,
  type TenantParserConfig,
} from '../index.js'

const emptyDialect: DialectPack<unknown> = {
  id: 'empty-v1',
  version: 1,
  tokens: {},
  macros: {},
  transforms: {},
}

function makeParser(overrides: Partial<TenantParserConfig> = {}): TenantParserConfig {
  return {
    configVersion: 1,
    parserId: 'test.x',
    scope: { tenantId: 'x', useCase: 'demo' },
    dialectRef: { id: 'empty-v1', version: 1 },
    detect: { prefixes: ['x'] },
    rules: [],
    ...overrides,
  }
}

describe('verifyParser', () => {
  it('accepts an empty parser', () => {
    const r = verifyParser(makeParser(), emptyDialect, new Set(['brand']))
    expect(r.ok).toBe(true)
  })

  it('rejects unknown tokens', () => {
    const r = verifyParser(
      makeParser({
        rules: [
          {
            id: 'r1',
            priority: 100,
            parser: { kind: 'token', token: 'mystery' },
            project: { brand: { literal: 'X' } },
            goldens: [],
          },
        ],
      }),
      emptyDialect,
      new Set(['brand']),
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'unknown_token')).toBe(true)
  })

  it('rejects projections that reference unknown captures', () => {
    const r = verifyParser(
      makeParser({
        rules: [
          {
            id: 'r1',
            priority: 100,
            parser: { kind: 'lit', value: 'foo' },
            project: { brand: { from: 'group' } },
            goldens: [],
          },
        ],
      }),
      emptyDialect,
      new Set(['brand']),
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'projection_from_unknown_capture')).toBe(true)
  })

  it('rejects projections to fields outside the use-case output schema', () => {
    const r = verifyParser(
      makeParser({
        rules: [
          {
            id: 'r1',
            priority: 100,
            parser: { kind: 'capture', name: 'g', expr: { kind: 'lit', value: 'a' } },
            project: { unknownField: { from: 'g' } },
            goldens: [],
          },
        ],
      }),
      emptyDialect,
      new Set(['brand']),
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'projection_unknown_field')).toBe(true)
  })

  it('rejects unbounded and over-large repeats', () => {
    const r = verifyParser(
      makeParser({
        rules: [
          {
            id: 'r1',
            priority: 100,
            parser: {
              kind: 'repeat',
              // @ts-expect-error — exercising missing max
              max: undefined,
              min: 1,
              expr: { kind: 'lit', value: 'a' },
            },
            project: { brand: { literal: 'X' } },
            goldens: [],
          },
        ],
      }),
      emptyDialect,
      new Set(['brand']),
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'repeat_unbounded')).toBe(true)
  })

  it('detects macro cycles', () => {
    const dialect: DialectPack<unknown> = {
      id: 'cyc-v1',
      version: 1,
      tokens: {},
      macros: {
        a: { params: [], body: { kind: 'macro', target: 'b' } },
        b: { params: [], body: { kind: 'macro', target: 'a' } },
      },
      transforms: {},
    }
    const r = verifyParser(
      makeParser({
        rules: [
          {
            id: 'r1',
            priority: 100,
            parser: { kind: 'macro', target: 'a' },
            project: { brand: { literal: 'X' } },
            goldens: [],
          },
        ],
      }),
      dialect,
      new Set(['brand']),
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'cycle_detected')).toBe(true)
  })

  it('rejects repeat whose body can match empty (optional)', () => {
    const r = verifyParser(
      makeParser({
        rules: [
          {
            id: 'r1',
            priority: 100,
            parser: {
              kind: 'repeat',
              min: 0,
              max: 8,
              expr: { kind: 'optional', expr: { kind: 'lit', value: 'a' } },
            },
            project: { brand: { literal: 'X' } },
            goldens: [],
          },
        ],
      }),
      emptyDialect,
      new Set(['brand']),
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'repeat_empty_body')).toBe(true)
  })

  it('rejects sepBy with empty separator', () => {
    const dialect: DialectPack<unknown> = {
      id: 'empty-v1',
      version: 1,
      tokens: { optWs: { expr: { kind: 'optional', expr: { kind: 'lit', value: ' ' } } } },
      macros: {},
      transforms: {},
    }
    const r = verifyParser(
      makeParser({
        rules: [
          {
            id: 'r1',
            priority: 100,
            parser: {
              kind: 'sepBy',
              min: 1,
              max: 8,
              expr: { kind: 'lit', value: 'a' },
              sep: { kind: 'token', token: 'optWs' },
            },
            project: { brand: { literal: 'X' } },
            goldens: [],
          },
        ],
      }),
      dialect,
      new Set(['brand']),
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'sepby_empty_separator')).toBe(true)
  })

  it('rejects dialectRef mismatch', () => {
    const r = verifyParser(
      makeParser({ dialectRef: { id: 'other', version: 1 } }),
      emptyDialect,
      new Set(['brand']),
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'dialect_ref_mismatch')).toBe(true)
  })

  it('rejects use-case mismatch when caller asserts a useCase', () => {
    const r = verifyParser(
      makeParser({ scope: { tenantId: 'x', useCase: 'demo' } }),
      emptyDialect,
      new Set(['brand']),
      'other-use-case',
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'use_case_mismatch')).toBe(true)
  })

  it('rejects transform whose version does not match the dialect', () => {
    const dialect: DialectPack<unknown> = {
      id: 'tv-v1',
      version: 1,
      tokens: {},
      macros: {},
      transforms: {
        upper: {
          version: 2,
          impl: () => undefined,
        },
      },
    }
    const r = verifyParser(
      makeParser({
        dialectRef: { id: 'tv-v1', version: 1 },
        rules: [
          {
            id: 'r1',
            priority: 100,
            parser: { kind: 'capture', name: 'x', expr: { kind: 'lit', value: 'a' } },
            project: {
              brand: { from: 'x', transforms: [{ name: 'upper', version: 1 }] },
            },
            goldens: [],
          },
        ],
      }),
      dialect,
      new Set(['brand']),
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'transform_version_mismatch')).toBe(true)
  })

  it('rejects duplicate rule IDs and duplicate captures', () => {
    const r = verifyParser(
      makeParser({
        rules: [
          {
            id: 'dup',
            priority: 100,
            parser: {
              kind: 'seq',
              items: [
                { kind: 'capture', name: 'x', expr: { kind: 'lit', value: 'a' } },
                { kind: 'capture', name: 'x', expr: { kind: 'lit', value: 'b' } },
              ],
            },
            project: { brand: { from: 'x' } },
            goldens: [],
          },
          {
            id: 'dup',
            priority: 50,
            parser: { kind: 'lit', value: 'z' },
            project: { brand: { literal: 'Z' } },
            goldens: [],
          },
        ],
      }),
      emptyDialect,
      new Set(['brand']),
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'duplicate_rule_id')).toBe(true)
    expect(r.issues.some((i) => i.code === 'duplicate_capture_name')).toBe(true)
  })
})
