#!/usr/bin/env tsx
/**
 * parsekit foundation smoke test.
 *
 * Builds a tiny throwaway dialect (just enough vocabulary to recognise
 * a Bytes-style edible name), compiles a single-rule tenant parser,
 * runs the verifier, parses a few inputs, and asserts the output.
 *
 * Run with:  npx tsx scripts/parsekit-smoke.mts
 */

import { z } from 'zod'
import { letters, digits } from 'arcsecond'

import {
  compileParser,
  parseWith,
  verifyParser,
  type DialectPack,
  type TenantParserConfig,
  type UseCaseContract,
} from '../src/lib/parsekit/index.js'

interface DemoOutput {
  brand: string
  category: string
  groupName: string
  packCount: number
}

const dialect: DialectPack<DemoOutput> = {
  id: 'demo-v1',
  version: 1,
  tokens: {
    dash: { expr: { kind: 'lit', value: ' - ' } },
    word: { parser: letters as never },
    int: { parser: digits as never },
  },
  macros: {
    'brand-dash-group-dash-family-dash-count': {
      params: ['brand', 'family'],
      body: {
        kind: 'seq',
        items: [
          { kind: 'lit', value: '${brand}', caseInsensitive: true },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'group', expr: { kind: 'token', token: 'word' } },
          { kind: 'token', token: 'dash' },
          { kind: 'lit', value: '${family}', caseInsensitive: true },
          { kind: 'token', token: 'dash' },
          { kind: 'capture', name: 'packCount', expr: { kind: 'token', token: 'int' } },
        ],
      },
    },
  },
  transforms: {
    toInt: {
      impl: (_args, ctx) => {
        const bag = ctx.output as { value: unknown }
        bag.value = parseInt(String(bag.value), 10)
      },
    },
  },
}

const contract: UseCaseContract<DemoOutput> = {
  useCase: 'demo',
  outputSchema: z.object({
    brand: z.string(),
    category: z.string(),
    groupName: z.string(),
    packCount: z.number().int().positive(),
  }),
  semanticValidate: (v) => (v.brand && v.category ? [] : [{ code: 'missing', message: 'brand/category required' }]),
}

const parser: TenantParserConfig = {
  configVersion: 1,
  parserId: 'demo.bytes',
  scope: { tenantId: 'bytes', useCase: 'demo' },
  dialectRef: { id: 'demo-v1', version: 1 },
  detect: { prefixes: ['Bytes'] },
  rules: [
    {
      id: 'bytes-edibles-v1',
      priority: 100,
      parser: {
        kind: 'macro',
        target: 'brand-dash-group-dash-family-dash-count',
        args: { brand: 'Bytes', family: 'Edibles' },
      },
      project: {
        brand: { literal: 'Bytes' },
        category: { literal: 'Edibles' },
        groupName: { from: 'group' },
        packCount: { from: 'packCount', transforms: [{ name: 'toInt', version: 1 }] },
      },
      goldens: [
        {
          kind: 'match',
          id: 'g1',
          input: 'Bytes - Watermelon - Edibles - 10',
          expected: { brand: 'Bytes', category: 'Edibles', groupName: 'Watermelon', packCount: 10 },
        },
      ],
    },
  ],
}

const allowed = new Set(['brand', 'category', 'groupName', 'packCount'])
const report = verifyParser(parser, dialect as DialectPack<unknown>, allowed)
console.log('verify:', report.ok ? 'OK' : 'ISSUES', JSON.stringify(report.issues))
if (!report.ok) {
  process.exit(1)
}

const compiled = compileParser(parser, dialect, contract)

const cases = [
  'Bytes - Watermelon - Edibles - 10',
  'Bytes - Peach - Edibles - 5',
  'Unrelated string',
  '', // empty
]
let allOk = true
for (const c of cases) {
  const r = parseWith(compiled, c)
  console.log(c.padEnd(40), '->', r.ok ? `OK ${JSON.stringify(r.output)}` : `FAIL ${r.reason}`)
  // Sanity asserts on the first two
  if (c === 'Bytes - Watermelon - Edibles - 10') {
    if (!r.ok || r.output.groupName !== 'Watermelon' || r.output.packCount !== 10) allOk = false
  }
  if (c === 'Bytes - Peach - Edibles - 5') {
    if (!r.ok || r.output.groupName !== 'Peach' || r.output.packCount !== 5) allOk = false
  }
  if (c === 'Unrelated string' && r.ok) allOk = false
}
if (!allOk) {
  console.error('SMOKE FAILED')
  process.exit(1)
}
console.log('SMOKE PASSED')
