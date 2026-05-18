/**
 * parsekit config loader — directory of JSONC parser configs →
 * validated, compiled, snapshot-stamped `CompiledRelease`.
 *
 * The loader is intentionally strict and all-or-nothing:
 *   - if **any** file fails to parse, validate, verify, compile, or
 *     pass its recorded goldens, the whole snapshot is rejected and
 *     the caller keeps serving the previously-released snapshot;
 *   - the `errors` array lists every failure across every file, so a
 *     single load attempt surfaces the full set of issues for triage.
 *
 * Pure Node — no fetch / no git / no UI. The git mirror + periodic
 * refresh + registry live alongside in this directory.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { parse as parseJsonc, type ParseError } from 'jsonc-parser'

import { compileParser, parseWith } from '../engine.js'
import type {
  CompiledParser,
  CompiledRelease,
  DialectPack,
  TenantParserConfig,
  UseCaseContract,
} from '../types.js'
import { verifyParser } from '../verify.js'

export interface LoaderRegistries {
  /** dialect id → DialectPack. The loader compares `dialectRef.version`
   *  to the pack's own `version` and rejects mismatched configs. */
  dialects: Map<string, DialectPack<unknown>>
  /** useCase id → contract. The loader uses
   *  `useCaseContract.outputSchema` for projection-field validation. */
  contracts: Map<string, UseCaseContract<unknown>>
}

export interface LoadError {
  /** Repo-relative path of the offending file, or '<directory>'. */
  path: string
  code:
    | 'directory_missing'
    | 'directory_unreadable'
    | 'jsonc_parse_failed'
    | 'schema_invalid'
    | 'dialect_unknown'
    | 'dialect_version_mismatch'
    | 'contract_unknown'
    | 'verify_failed'
    | 'compile_failed'
    | 'golden_failed'
  message: string
  details?: unknown
}

export interface LoadResult {
  release: CompiledRelease | null
  errors: LoadError[]
  /** Files considered. Useful for "no parsers found" diagnostics. */
  considered: string[]
}

export interface LoadOptions {
  /** Absolute path to the configs root (mirrors the helios-parser-configs
   *  repo layout: `use-cases/<useCase>/parsers/<tenantId>.jsonc`). */
  dir: string
  /** Snapshot identifier for the resulting release. Typically a git
   *  commit sha; can be any stable string. */
  sha: string
  registries: LoaderRegistries
}

const PARSERS_GLOB_SEGMENTS = ['use-cases', '*', 'parsers']

export function loadParserConfigsFromDir(opts: LoadOptions): LoadResult {
  const { dir, sha, registries } = opts
  const errors: LoadError[] = []
  const considered: string[] = []

  if (!existsSync(dir)) {
    return {
      release: null,
      errors: [
        {
          path: '<directory>',
          code: 'directory_missing',
          message: `parser-configs directory does not exist: ${dir}`,
        },
      ],
      considered: [],
    }
  }
  let parserFiles: string[]
  try {
    parserFiles = discoverParserFiles(dir)
  } catch (err) {
    return {
      release: null,
      errors: [
        {
          path: '<directory>',
          code: directoryErrorCode(err),
          message: stringifyError(err),
        },
      ],
      considered: [],
    }
  }
  considered.push(...parserFiles)

  const parsers = new Map<string, CompiledParser<unknown>>()
  for (const filePath of parserFiles) {
    const relPath = filePath.slice(dir.length).replace(/^\/+/, '')

    let raw: string
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (err) {
      errors.push({ path: relPath, code: 'directory_unreadable', message: stringifyError(err) })
      continue
    }

    const parseErrors: ParseError[] = []
    const config = parseJsonc(raw, parseErrors, {
      disallowComments: false,
      allowTrailingComma: false,
    }) as unknown as TenantParserConfig | undefined
    if (parseErrors.length > 0 || !config) {
      errors.push({
        path: relPath,
        code: 'jsonc_parse_failed',
        message: `${parseErrors.length} JSONC parse error(s)`,
        details: parseErrors.map(({ error, offset, length }) => ({
          error,
          offset,
          length,
        })),
      })
      continue
    }

    const schemaIssue = validateConfigShape(config)
    if (schemaIssue) {
      errors.push({ path: relPath, code: 'schema_invalid', message: schemaIssue })
      continue
    }

    const dialect = registries.dialects.get(config.dialectRef.id)
    if (!dialect) {
      errors.push({
        path: relPath,
        code: 'dialect_unknown',
        message: `unknown dialect id "${config.dialectRef.id}"`,
      })
      continue
    }
    if (dialect.version !== config.dialectRef.version) {
      errors.push({
        path: relPath,
        code: 'dialect_version_mismatch',
        message: `dialect "${dialect.id}" version mismatch: pack=${dialect.version}, config=${config.dialectRef.version}`,
      })
      continue
    }

    const contract = registries.contracts.get(config.scope.useCase)
    if (!contract) {
      errors.push({
        path: relPath,
        code: 'contract_unknown',
        message: `no contract registered for useCase "${config.scope.useCase}"`,
      })
      continue
    }

    // verifyParser needs the projection-field allowlist + the use-case
    // identity. We derive the allowlist from the zod object schema, the
    // same way pendingPurchasesContract exposes pendingPurchasesOutputFields.
    const outputFields = deriveOutputFieldSet(contract)
    const report = verifyParser(config, dialect, outputFields, contract.useCase)
    if (!report.ok) {
      errors.push({
        path: relPath,
        code: 'verify_failed',
        message: `${report.issues.length} safety issue(s)`,
        details: report.issues,
      })
      continue
    }

    let compiled: CompiledParser<unknown>
    try {
      compiled = compileParser(config, dialect, contract)
    } catch (err) {
      errors.push({ path: relPath, code: 'compile_failed', message: stringifyError(err) })
      continue
    }

    const goldenIssue = runGoldens(compiled, config)
    if (goldenIssue) {
      errors.push({ path: relPath, code: 'golden_failed', message: goldenIssue.message, details: goldenIssue.details })
      continue
    }

    parsers.set(config.parserId, compiled)
  }

  if (errors.length > 0) {
    return { release: null, errors, considered }
  }

  const contractsByUseCase = new Map<string, UseCaseContract<unknown>>()
  for (const cp of parsers.values()) {
    contractsByUseCase.set(cp.contract.useCase, cp.contract)
  }

  return {
    release: { sha, parsers, contractsByUseCase },
    errors,
    considered,
  }
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function discoverParserFiles(dir: string): string[] {
  // Discover by walking `use-cases/<useCase>/parsers/<tenantId>.jsonc`.
  const out: string[] = []
  const useCasesDir = join(dir, PARSERS_GLOB_SEGMENTS[0])
  for (const useCase of safeReaddir(useCasesDir)) {
    const parsersDir = join(useCasesDir, useCase, PARSERS_GLOB_SEGMENTS[2])
    let entries: string[]
    try {
      entries = readdirSync(parsersDir)
    } catch {
      continue // empty / missing parsers dir for that use-case is fine
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonc')) continue
      const full = join(parsersDir, entry)
      if (!statSync(full).isFile()) continue
      out.push(full)
    }
  }
  return out.sort()
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((entry) => {
      try {
        return statSync(join(dir, entry)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

function directoryErrorCode(err: unknown): LoadError['code'] {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  ) {
    return 'directory_missing'
  }
  return 'directory_unreadable'
}

/**
 * Cheap structural guard. Full AST validation lives in `verifyParser`;
 * this only catches "this isn't a TenantParserConfig at all" so the
 * downstream code can rely on the shape.
 */
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

function deriveOutputFieldSet(contract: UseCaseContract<unknown>): Set<string> {
  const schemaShape = (contract.outputSchema as { shape?: Record<string, unknown> }).shape
  if (schemaShape && typeof schemaShape === 'object') {
    return new Set(Object.keys(schemaShape))
  }
  // The contract's outputSchema is meant to be a zod object; if a future
  // contract uses something else, the caller should pre-build the field
  // set and pass it through a separate channel.
  throw new Error(`contract for "${contract.useCase}" does not expose a zod object shape`)
}

interface GoldenIssue {
  message: string
  details: unknown
}

function runGoldens(
  compiled: CompiledParser<unknown>,
  config: TenantParserConfig,
): GoldenIssue | null {
  for (const rule of config.rules) {
    for (const golden of rule.goldens) {
      if (golden.kind === 'match') {
        const result = parseWith(compiled, golden.input, { snapshotSha: 'loader-validate' })
        if (!result.ok) {
          return {
            message: `golden "${golden.id}" failed to parse`,
            details: result,
          }
        }
        if (result.ruleId !== rule.id) {
          return {
            message: `golden "${golden.id}" expected rule "${rule.id}" but matched "${result.ruleId}"`,
            details: result,
          }
        }
        if (!deepEqual(result.output, golden.expected)) {
          return {
            message: `golden "${golden.id}" output mismatch`,
            details: { expected: golden.expected, actual: result.output },
          }
        }
      } else {
        // kind === 'no_match'
        const result = parseWith(compiled, golden.input, { snapshotSha: 'loader-validate' })
        if (result.ok) {
          return {
            message: `golden "${golden.id}" expected no_match but parsed`,
            details: result,
          }
        }
      }
    }
  }
  return null
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const aKeys = Object.keys(ao).sort()
    const bKeys = Object.keys(bo).sort()
    if (aKeys.length !== bKeys.length) return false
    for (let i = 0; i < aKeys.length; i += 1) {
      if (aKeys[i] !== bKeys[i]) return false
      if (!deepEqual(ao[aKeys[i]!], bo[bKeys[i]!])) return false
    }
    return true
  }
  return false
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
