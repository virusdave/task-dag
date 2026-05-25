/**
 * Compile a proposed LitAlerts tenant config JSONC and dry-run it
 * against a single listing string, without writing or committing
 * anything. Used by the per-listing details page on
 * /config/parsing/litalerts/:competitor/listing/:fuzzyHash to show
 * the operator how a pending edit *would* parse a real observed
 * row before they hit "Apply & push".
 *
 * Failure modes mirror applyConfig.ts so the UI can render the same
 * error shapes consistently.
 */

import { parse as parseJsonc, type ParseError } from 'jsonc-parser'

import { compileParser, parseWith } from '../../lib/parsekit/engine.js'
import { verifyParser } from '../../lib/parsekit/verify.js'
import { litalertsContract, litalertsOutputFields } from '../../lib/parsekit/contracts/litalerts.js'
import { litalertsV1Dialect } from '../../lib/parsekit/dialects/litalerts-v1.js'
import type { TenantParserConfig } from '../../lib/parsekit/types.js'
import type { ParsekitParseAttempt } from './litalertsLookup.js'
import { descriptorToParsedListing } from './litalertsLookup.js'
import type { FuzzyVariantDescriptor } from '../../lib/parsekit/contracts/litalerts.js'

const USE_CASE = 'litalerts'
const DEFAULT_DIALECT_ID = 'litalerts-v1'

export type DryRunFailureCode =
  | 'invalid_jsonc'
  | 'schema_invalid'
  | 'identity_mismatch'
  | 'dialect_unknown'
  | 'dialect_version_mismatch'
  | 'verify_failed'
  | 'compile_failed'

export interface DryRunFailure {
  ok: false
  code: DryRunFailureCode
  message: string
  detail?: unknown
}

export interface DryRunSuccess {
  ok: true
  attempt: ParsekitParseAttempt
}

export type DryRunResult = DryRunSuccess | DryRunFailure

export interface DryRunInput {
  tenantId: string
  jsonc: string
  listingName: string
}

export function dryRunLitalertsTenantConfig(input: DryRunInput): DryRunResult {
  // 1. Parse JSONC.
  const parseErrors: ParseError[] = []
  const config = parseJsonc(input.jsonc, parseErrors, {
    disallowComments: false,
    allowTrailingComma: false,
  }) as unknown as TenantParserConfig | undefined
  if (parseErrors.length > 0 || !config) {
    return {
      ok: false,
      code: 'invalid_jsonc',
      message: `${parseErrors.length} JSONC parse error(s)`,
      detail: parseErrors.map(({ error, offset, length }) => ({ error, offset, length })),
    }
  }

  // 2. Structural guard.
  const schemaIssue = validateConfigShape(config)
  if (schemaIssue) {
    return { ok: false, code: 'schema_invalid', message: schemaIssue }
  }

  // 3. Identity guard.
  if (config.scope.useCase !== USE_CASE) {
    return {
      ok: false,
      code: 'identity_mismatch',
      message: `scope.useCase must be "${USE_CASE}"; got "${config.scope.useCase}"`,
    }
  }
  if (config.scope.tenantId !== input.tenantId) {
    return {
      ok: false,
      code: 'identity_mismatch',
      message: `scope.tenantId must be "${input.tenantId}"; got "${config.scope.tenantId}"`,
    }
  }

  // 4. Dialect resolution.
  if (config.dialectRef.id !== DEFAULT_DIALECT_ID) {
    return {
      ok: false,
      code: 'dialect_unknown',
      message: `only "${DEFAULT_DIALECT_ID}" is supported for litalerts in this MVP; got "${config.dialectRef.id}"`,
    }
  }
  if (config.dialectRef.version !== litalertsV1Dialect.version) {
    return {
      ok: false,
      code: 'dialect_version_mismatch',
      message: `dialectRef.version must be ${litalertsV1Dialect.version}; got ${config.dialectRef.version}`,
    }
  }

  const verifyReport = verifyParser(
    config,
    litalertsV1Dialect,
    litalertsOutputFields,
    litalertsContract.useCase,
  )
  if (!verifyReport.ok) {
    return {
      ok: false,
      code: 'verify_failed',
      message: `${verifyReport.issues.length} safety issue(s)`,
      detail: verifyReport.issues,
    }
  }

  let compiled
  try {
    compiled = compileParser(config, litalertsV1Dialect, litalertsContract)
  } catch (err) {
    return { ok: false, code: 'compile_failed', message: err instanceof Error ? err.message : String(err) }
  }

  const cleaned = (input.listingName ?? '').trim()
  if (cleaned.length === 0) {
    return {
      ok: true,
      attempt: {
        parsed: null,
        parserId: config.parserId,
        snapshotSha: 'dry-run',
        reason: 'parse_failed',
        failureDetail: 'empty listingName',
      },
    }
  }
  let result
  try {
    result = parseWith(compiled, cleaned, { snapshotSha: 'dry-run' })
  } catch (err) {
    return {
      ok: true,
      attempt: {
        parsed: null,
        parserId: config.parserId,
        snapshotSha: 'dry-run',
        reason: 'parse_failed',
        failureDetail: `threw: ${err instanceof Error ? err.message : String(err)}`,
      },
    }
  }
  if (!result.ok) {
    return {
      ok: true,
      attempt: {
        parsed: null,
        parserId: config.parserId,
        snapshotSha: 'dry-run',
        reason: 'parse_failed',
        failureDetail: result.diagnostics?.length
          ? result.diagnostics.map((d) => `${d.ruleId || '-'}=${d.reason}`).join('; ')
          : result.reason,
      },
    }
  }
  return {
    ok: true,
    attempt: {
      parsed: descriptorToParsedListing(result.output as FuzzyVariantDescriptor),
      parserId: config.parserId,
      snapshotSha: 'dry-run',
      reason: null,
    },
  }
}

function validateConfigShape(config: unknown): string | null {
  if (typeof config !== 'object' || config === null) return 'config is not an object'
  const c = config as Record<string, unknown>
  if (c.configVersion !== 1) return `configVersion must be 1 (got ${JSON.stringify(c.configVersion)})`
  if (typeof c.parserId !== 'string' || c.parserId.length === 0) return 'parserId must be a non-empty string'
  if (typeof c.scope !== 'object' || c.scope === null) return 'scope must be an object'
  const scope = c.scope as Record<string, unknown>
  if (typeof scope.tenantId !== 'string' || scope.tenantId.length === 0) return 'scope.tenantId must be a non-empty string'
  if (typeof scope.useCase !== 'string' || scope.useCase.length === 0) return 'scope.useCase must be a non-empty string'
  if (typeof c.dialectRef !== 'object' || c.dialectRef === null) return 'dialectRef must be an object'
  const dref = c.dialectRef as Record<string, unknown>
  if (typeof dref.id !== 'string' || dref.id.length === 0) return 'dialectRef.id must be a non-empty string'
  if (typeof dref.version !== 'number' || !Number.isInteger(dref.version)) return 'dialectRef.version must be an integer'
  if (typeof c.detect !== 'object' || c.detect === null) return 'detect must be an object'
  if (!Array.isArray(c.rules) || c.rules.length === 0) return 'rules must be a non-empty array'
  return null
}
