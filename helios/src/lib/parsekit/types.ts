/**
 * parsekit core types
 *
 * Isomorphic — no Node-only deps. Mirrors the AST + dialect + contract
 * shapes from docs/helios/parsekit/EPIC_PLAN.md.
 *
 * The runtime identity is `ParserScope = { tenantId, useCase }`.
 * `dialect` is an imported reference with `{ id, version }`, NOT part
 * of identity. `UseCaseContract<T>` owns `outputSchema` + semantic
 * validation; dialects are syntax libraries only.
 */

import type { ZodType } from 'zod'
import type { Parser as ArcsecondParser } from 'arcsecond'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue }

// ---------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------

export type Expr =
  | { kind: 'lit'; value: string; caseInsensitive?: boolean }
  | { kind: 'token'; token: string }
  | { kind: 'seq'; items: Expr[] }
  | { kind: 'choice'; items: Expr[] }
  | { kind: 'capture'; name: string; expr: Expr }
  | { kind: 'optional'; expr: Expr }
  | { kind: 'repeat'; expr: Expr; min: number; max: number }
  | { kind: 'between'; expr: Expr; left: Expr; right: Expr }
  | { kind: 'sepBy'; expr: Expr; sep: Expr; min?: number; max?: number }
  /** Consume input characters until `terminator` would succeed (lookahead).
   *  Terminator is NOT consumed. Captured text is the consumed run.
   *  Always requires at least 1 char unless `minLen: 0`. */
  | { kind: 'consumeUntil'; terminator: Expr; minLen?: number }
  | { kind: 'ref'; target: string }
  | { kind: 'macro'; target: string; args?: Record<string, JsonValue> }

export interface TransformCall {
  name: string
  version: number
  args?: Record<string, JsonValue>
}

export type ValueExpr =
  | { from: string; transforms?: TransformCall[] }
  | { literal: JsonValue }

export type Projection = Record<string, ValueExpr>

export type GoldenCase =
  | { kind: 'match'; id: string; input: string; expected: unknown }
  | { kind: 'no_match'; id: string; input: string }

export interface DetectSpec {
  prefixes?: string[]
  predicates?: { name: string; args?: JsonValue }[]
}

export interface Rule {
  id: string
  priority: number
  enabled?: boolean
  parser: Expr
  project: Projection
  transforms?: TransformCall[]
  goldens: GoldenCase[]
  notes?: string[]
}

export interface ParserScope {
  tenantId: string
  useCase: string
}

export interface TenantParserConfig {
  configVersion: 1
  parserId: string
  scope: ParserScope
  dialectRef: { id: string; version: number }
  detect: DetectSpec
  rules: Rule[]
}

// ---------------------------------------------------------------------
// Dialect pack & use-case contract
// ---------------------------------------------------------------------

export interface MacroDef {
  /** Parameter names this macro accepts; args validated to be a subset. */
  params: string[]
  /** Body is an Expr template; `${param}` interpolation in `lit.value`
   *  and `args` lookup are resolved at compile time. */
  body: Expr
}

export interface TokenDef {
  /** Either an Expr (compiled like any other AST node) or a raw
   *  arcsecond parser. The raw form lets a dialect ship efficient
   *  primitives (e.g. number/decimal scanners) without round-tripping
   *  through the AST. */
  expr?: Expr
  parser?: ArcsecondParser<unknown>
}

export interface TransformContext<TOutput> {
  /** The output object being built (mutable during the transforms
   *  pass). Transforms can read prior fields and mutate to derive
   *  new ones. */
  output: Partial<TOutput>
  /** The raw capture map produced by the parser, before projection. */
  captures: Record<string, string>
  /** Parse-time context passed by the caller (e.g. distributor names,
   *  manifest hints). */
  callerContext: unknown
}

export type TransformImpl<TOutput> = (
  args: Record<string, JsonValue> | undefined,
  ctx: TransformContext<TOutput>,
) => void

export interface TransformDef<TOutput> {
  /** Args schema. Validated before the transform runs. */
  argsSchema?: ZodType<unknown>
  /** Required to be a pure function of (args, captures, output). */
  impl: TransformImpl<TOutput>
}

export interface DialectPack<TOutput = unknown> {
  id: string
  version: number
  tokens: Record<string, TokenDef>
  macros: Record<string, MacroDef>
  transforms: Record<string, TransformDef<TOutput>>
}

export interface ValidationIssue {
  code: string
  message: string
  path?: string
}

export interface UseCaseContract<T> {
  useCase: string
  outputSchema: ZodType<T>
  semanticValidate: (value: T) => ValidationIssue[]
}

// ---------------------------------------------------------------------
// Release manifest
// ---------------------------------------------------------------------

export interface ReleaseManifest {
  sha: string
  schemaVersion: 1
  parsers: Array<{ parserId: string; useCase: string; tenantId: string; path: string }>
  dialects: Array<{ id: string; version: number; path: string }>
}

// ---------------------------------------------------------------------
// Compiled forms
// ---------------------------------------------------------------------

export interface CompiledRule<TOutput> {
  rule: Rule
  parser: ArcsecondParser<Record<string, string>>
}

export interface CompiledParser<TOutput> {
  config: TenantParserConfig
  rules: CompiledRule<TOutput>[]
  dialect: DialectPack<TOutput>
  contract: UseCaseContract<TOutput>
}

export interface CompiledRelease {
  sha: string
  parsers: Map<string, CompiledParser<unknown>>
  contractsByUseCase: Map<string, UseCaseContract<unknown>>
}

// ---------------------------------------------------------------------
// Parse results
// ---------------------------------------------------------------------

export interface ParseDiagnostic {
  ruleId: string
  failureOffset?: number
  reason: string
}

export interface ParseSuccess<T> {
  ok: true
  output: T
  ruleId: string
  parserId: string
  snapshotSha: string
}

export interface ParseFailure {
  ok: false
  reason: 'no_match' | 'validation_error' | 'tenant_unavailable' | 'safety_aborted'
  parserId?: string
  snapshotSha?: string
  diagnostics: ParseDiagnostic[]
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure

// ---------------------------------------------------------------------
// Safety limits (enforced by verify + parse-time budget)
// ---------------------------------------------------------------------

export interface SafetyLimits {
  /** Max AST node depth (recursive count for any subtree). */
  maxDepth: number
  /** Max branches in a single `choice`. */
  maxChoiceFanout: number
  /** Hard cap on `repeat.max` and `sepBy.max`. */
  maxRepeat: number
  /** Max input length parse will accept. */
  maxInputLength: number
}

export const DEFAULT_SAFETY_LIMITS: SafetyLimits = {
  maxDepth: 32,
  maxChoiceFanout: 64,
  maxRepeat: 64,
  maxInputLength: 2048,
}
