/**
 * Round-trip tests for compile + parseWith against a tiny demo
 * dialect. The scripts/parsekit-smoke.mts smoke runner exercises the
 * same surface in a way that does not require vitest.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { digits, letters } from 'arcsecond'

import {
  compileParser,
  parseWith,
  type DialectPack,
  type TenantParserConfig,
  type UseCaseContract,
} from '../index.js'

interface Out {
  brand: string
  category: string
  groupName: string
  packCount: number
}

const dialect: DialectPack<Out> = {
  id: 'demo',
  version: 1,
  tokens: {
    dash: { expr: { kind: 'lit', value: ' - ' } },
    word: { parser: letters as never },
    int: { parser: digits as never },
  },
  macros: {},
  transforms: {
    toInt: {
      version: 1,
      impl: (_a, ctx) => {
        const bag = ctx.output as { value: unknown }
        bag.value = parseInt(String(bag.value), 10)
      },
    },
  },
}

const contract: UseCaseContract<Out> = {
  useCase: 'demo',
  outputSchema: z.object({
    brand: z.string(),
    category: z.string(),
    groupName: z.string(),
    packCount: z.number().int().positive(),
  }),
  semanticValidate: () => [],
}

const cfg: TenantParserConfig = {
  configVersion: 1,
  parserId: 'demo.x',
  scope: { tenantId: 'x', useCase: 'demo' },
  dialectRef: { id: 'demo', version: 1 },
  detect: { prefixes: ['Bytes'] },
  rules: [
    {
      id: 'r1',
      priority: 100,
      parser: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: 'Bytes' },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'group', expr: { kind: 'token', token: 'word' } },
          { kind: 'token', token: 'dash' },
          { kind: 'lit', value: 'Edibles' },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'pc', expr: { kind: 'token', token: 'int' } },
        ],
      },
      project: {
        brand: { literal: 'Bytes' },
        category: { literal: 'Edibles' },
        groupName: { from: 'group' },
        packCount: { from: 'pc', transforms: [{ name: 'toInt', version: 1 }] },
      },
      goldens: [],
    },
  ],
}

describe('parseWith', () => {
  const compiled = compileParser(cfg, dialect, contract)

  it('parses a matching input through the full pipeline', () => {
    const r = parseWith(compiled, 'Bytes - Watermelon - Edibles - 10')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.output).toEqual({
        brand: 'Bytes',
        category: 'Edibles',
        groupName: 'Watermelon',
        packCount: 10,
      })
      expect(r.ruleId).toBe('r1')
    }
  })

  it('returns no_match for unrelated input', () => {
    const r = parseWith(compiled, 'something else entirely')
    expect(r.ok).toBe(false)
  })

  it('rejects partial matches (parser requires endOfInput)', () => {
    const r = parseWith(compiled, 'Bytes - Watermelon - Edibles - 10 extra')
    expect(r.ok).toBe(false)
  })

  it('aborts on oversized input', () => {
    const r = parseWith(compiled, 'a'.repeat(10_000))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('safety_aborted')
  })
})
