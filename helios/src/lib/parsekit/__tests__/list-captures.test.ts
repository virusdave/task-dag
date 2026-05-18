/**
 * End-to-end coverage for the captureMany / fromList / list-aware
 * transform pipeline and the generic mapValue lookup transform.
 *
 * These features land alongside the Curaleaf port (Phase 6) where a
 * variable-length modifier-token list with an optional `\d+PK` pack
 * token at unknown position needs first-class list semantics.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  compileParser,
  parseWith,
  verifyParser,
  type DialectPack,
  type TenantParserConfig,
  type UseCaseContract,
} from '../index.js'
import { metrcV1Dialect } from '../dialects/metrc-v1.js'

// A tiny test contract whose output fields cover the shapes the
// captureMany pipeline produces: a scalar (pack), a string (cultivar),
// and a brand-aliased label.
interface Out {
  pack: string
  cultivar: string
  brand: string
}

const contract: UseCaseContract<Out> = {
  useCase: 'list-capture-test',
  outputSchema: z.object({
    pack: z.string(),
    cultivar: z.string(),
    brand: z.string(),
  }),
  semanticValidate: () => [],
}

const OUT_FIELDS = new Set<string>(['pack', 'cultivar', 'brand'])

describe('captureMany + fromList + list transforms', () => {
  // Models a stripped-down Curaleaf-style input:
  //   "Grassroots-Dark Heart-2PK-Cookies-1g"
  // Brand at position 0, then a variable-length list of modifiers
  // separated by '-' with an inline pack token (\d+PK) at unknown
  // position, then a trailing '-' + sizeText we ignore here.
  const cfg: TenantParserConfig = {
    configVersion: 1,
    parserId: 'list-capture-test.demo',
    scope: { tenantId: 'demo', useCase: 'list-capture-test' },
    dialectRef: { id: 'metrc-v1', version: 1 },
    detect: { prefixes: ['Grassroots'] },
    rules: [
      {
        id: 'r1',
        priority: 100,
        parser: {
          kind: 'seq',
          items: [
            { kind: 'capture', name: 'brand', expr: { kind: 'token', token: 'cultivarText' } },
            { kind: 'token', token: 'dash' },
            {
              kind: 'captureMany',
              name: 'mods',
              expr: {
                kind: 'sepBy',
                min: 1,
                max: 8,
                expr: { kind: 'token', token: 'cultivarText' },
                sep: { kind: 'token', token: 'dash' },
              },
            },
            { kind: 'token', token: 'optWs' },
          ],
        },
        project: {
          brand: {
            from: 'brand',
            transforms: [
              {
                name: 'mapValue',
                version: 1,
                args: {
                  table: { Grassroots: 'Grass Roots', Anthm: 'Anthem' },
                  trim: true,
                },
              },
            ],
          },
          // Pluck the pack token out of the list.
          pack: {
            fromList: 'mods',
            transforms: [
              {
                name: 'findToken',
                version: 1,
                args: { pattern: '^\\d+PK$', caseInsensitive: true, default: '1PK' },
              },
            ],
          },
          // Filter the pack token out, then join the remaining modifiers.
          cultivar: {
            fromList: 'mods',
            transforms: [
              {
                name: 'filterTokens',
                version: 1,
                args: { pattern: '^\\d+PK$', caseInsensitive: true },
              },
              { name: 'joinTokens', version: 1, args: { sep: ' ' } },
            ],
          },
        },
        goldens: [],
      },
    ],
  }

  // A locally-cloned dialect with `cultivarText` made stricter so the
  // first modifier text doesn't eat the rest of the string. The shared
  // metrc-v1 cultivarText matches `[^-]+` which is what we want here
  // (each list item is a non-dash run; dashes are the separator).
  const dialect: DialectPack<unknown> = metrcV1Dialect as unknown as DialectPack<unknown>

  it('passes static safety verify', () => {
    const r = verifyParser(cfg, dialect, OUT_FIELDS, contract.useCase)
    if (!r.ok) {
      console.error(r.issues)
    }
    expect(r.ok).toBe(true)
  })

  it('captureMany / findToken / filterTokens / joinTokens / mapValue end-to-end', () => {
    const compiled = compileParser(cfg, dialect as DialectPack<Out>, contract)
    const r = parseWith(compiled, 'Grassroots-Dark Heart-2PK-Cookies')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.output).toEqual({
        brand: 'Grass Roots',
        pack: '2PK',
        cultivar: 'Dark Heart Cookies',
      })
    }
  })

  it('findToken returns default when no list item matches', () => {
    const compiled = compileParser(cfg, dialect as DialectPack<Out>, contract)
    const r = parseWith(compiled, 'Grassroots-Wedding Cake')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.output.pack).toBe('1PK')
      expect(r.output.cultivar).toBe('Wedding Cake')
    }
  })

  it('mapValue passes the original value through when the table has no match and no default', () => {
    const compiled = compileParser(cfg, dialect as DialectPack<Out>, contract)
    const r = parseWith(compiled, 'Unknown-Brand-Strain')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.output.brand).toBe('Unknown') // not in table, no default -> passthrough
    }
  })
})

describe('captureMany verifier guardrails', () => {
  it('rejects captureMany whose body is neither repeat nor sepBy', () => {
    const bad: TenantParserConfig = {
      configVersion: 1,
      parserId: 't.bad',
      scope: { tenantId: 't', useCase: 'list-capture-test' },
      dialectRef: { id: 'metrc-v1', version: 1 },
      detect: { prefixes: ['x'] },
      rules: [
        {
          id: 'r1',
          priority: 100,
          parser: {
            kind: 'captureMany',
            name: 'mods',
            expr: { kind: 'lit', value: 'x' },
          },
          project: { pack: { fromList: 'mods' } },
          goldens: [],
        },
      ],
    }
    const r = verifyParser(
      bad,
      metrcV1Dialect as unknown as DialectPack<unknown>,
      OUT_FIELDS,
      'list-capture-test',
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'capturemany_body_invalid')).toBe(true)
  })

  it('rejects fromList referencing a scalar capture', () => {
    const bad: TenantParserConfig = {
      configVersion: 1,
      parserId: 't.bad',
      scope: { tenantId: 't', useCase: 'list-capture-test' },
      dialectRef: { id: 'metrc-v1', version: 1 },
      detect: { prefixes: ['x'] },
      rules: [
        {
          id: 'r1',
          priority: 100,
          parser: {
            kind: 'capture',
            name: 'x',
            expr: { kind: 'token', token: 'cultivarText' },
          },
          // scalar `x` consumed via `fromList` — should be flagged.
          project: { pack: { fromList: 'x' } },
          goldens: [],
        },
      ],
    }
    const r = verifyParser(
      bad,
      metrcV1Dialect as unknown as DialectPack<unknown>,
      OUT_FIELDS,
      'list-capture-test',
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'projection_capture_kind_mismatch')).toBe(true)
  })

  it('rejects captureMany with nested named captures in its body', () => {
    const bad: TenantParserConfig = {
      configVersion: 1,
      parserId: 't.bad',
      scope: { tenantId: 't', useCase: 'list-capture-test' },
      dialectRef: { id: 'metrc-v1', version: 1 },
      detect: { prefixes: ['x'] },
      rules: [
        {
          id: 'r1',
          priority: 100,
          parser: {
            kind: 'captureMany',
            name: 'mods',
            expr: {
              kind: 'sepBy',
              min: 1,
              max: 4,
              expr: {
                kind: 'capture',
                name: 'inner',
                expr: { kind: 'token', token: 'cultivarText' },
              },
              sep: { kind: 'token', token: 'dash' },
            },
          },
          project: { pack: { fromList: 'mods' } },
          goldens: [],
        },
      ],
    }
    const r = verifyParser(
      bad,
      metrcV1Dialect as unknown as DialectPack<unknown>,
      OUT_FIELDS,
      'list-capture-test',
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'capturemany_nested_capture')).toBe(true)
  })
})
