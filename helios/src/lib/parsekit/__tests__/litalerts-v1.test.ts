/**
 * End-to-end tests for parsekit + litalerts-v1 dialect against the
 * checked-in tenant fixtures.
 *
 * Mirrors the metrc-v1 test layout. Each tenant parser config under
 * test is the JSONC shape destined for the `helios-parser-configs`
 * repo at `use-cases/litalerts/parsers/<tenantId>.jsonc`.
 */

import { describe, expect, it } from 'vitest'

import {
  compileParser,
  parseWith,
  verifyParser,
} from '../index.js'
import {
  litalertsContract,
  litalertsOutputFields,
} from '../contracts/litalerts.js'
import { litalertsV1Dialect } from '../dialects/litalerts-v1.js'

import { LITALERTS_TENANT_CONFIGS } from './litalerts-v1-fixtures.js'

describe('litalerts-v1 dialect: static safety verify', () => {
  for (const cfg of LITALERTS_TENANT_CONFIGS) {
    it(`${cfg.parserId} passes verifyParser`, () => {
      const report = verifyParser(
        cfg,
        litalertsV1Dialect,
        litalertsOutputFields,
        litalertsContract.useCase,
      )
      if (!report.ok) {
        // eslint-disable-next-line no-console
        console.error(report.issues)
      }
      expect(report.ok).toBe(true)
    })
  }
})

describe('litalerts-v1 dialect: end-to-end goldens', () => {
  for (const cfg of LITALERTS_TENANT_CONFIGS) {
    const compiled = compileParser(cfg, litalertsV1Dialect, litalertsContract)
    for (const rule of cfg.rules) {
      for (const golden of rule.goldens) {
        if (golden.kind !== 'match') continue
        it(`${cfg.parserId} / ${golden.id}`, () => {
          const result = parseWith(compiled, golden.input, {
            snapshotSha: 'test',
          })
          if (!result.ok) {
            // eslint-disable-next-line no-console
            console.error(result)
          }
          expect(result.ok).toBe(true)
          if (result.ok) {
            expect(result.output).toEqual(golden.expected)
            expect(result.ruleId).toBe(rule.id)
          }
        })
      }
    }
  }
})
