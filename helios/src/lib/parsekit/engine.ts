/**
 * parse pipeline:
 *
 *   raw input -> arcsecond run -> captures -> projection ->
 *   transforms -> output Zod -> useCase.semanticValidate -> result
 *
 * Per-rule, rules are tried in priority desc, id asc order; first
 * successful rule wins.
 */

import {
  endOfInput as aEnd,
  sequenceOf as aSeq,
  type Parser as AParser,
} from 'arcsecond'

import {
  DEFAULT_SAFETY_LIMITS,
  type CompiledParser,
  type CompiledRule,
  type DialectPack,
  type ParseResult,
  type Rule,
  type SafetyLimits,
  type TenantParserConfig,
  type TransformContext,
  type UseCaseContract,
  type ValueExpr,
} from './types.js'
import { compileExpr, type CaptureNode } from './compile.js'

export function compileParser<TOutput>(
  config: TenantParserConfig,
  dialect: DialectPack<TOutput>,
  contract: UseCaseContract<TOutput>,
): CompiledParser<TOutput> {
  // Identity invariants (cheap, fail-fast). The static safety verifier
  // also reports these as issues; the engine refuses outright because
  // compiling a parser against the wrong dialect or wrong use-case
  // contract is a programmer error, not a config issue.
  if (config.dialectRef.id !== dialect.id || config.dialectRef.version !== dialect.version) {
    throw new Error(
      `parsekit.compileParser: parser '${config.parserId}' dialectRef ` +
        `${config.dialectRef.id}@${config.dialectRef.version} does not match ` +
        `supplied dialect ${dialect.id}@${dialect.version}`,
    )
  }
  if (config.scope.useCase !== contract.useCase) {
    throw new Error(
      `parsekit.compileParser: parser '${config.parserId}' scope.useCase ` +
        `'${config.scope.useCase}' does not match contract useCase '${contract.useCase}'`,
    )
  }

  const sorted = [...config.rules]
    .filter((r) => r.enabled !== false)
    .sort((a, b) => (b.priority - a.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const rules: CompiledRule<TOutput>[] = sorted.map((rule) => {
    // Wrap each rule in `seq([parser, endOfInput])` so we don't accept
    // partial matches.
    const inner = compileExpr(rule.parser, dialect as DialectPack<unknown>)
    const withEnd = aSeq([inner, aEnd]).map((rs) => (rs as [CaptureNode, unknown])[0]) as AParser<CaptureNode>
    return { rule, parser: withEnd.map((n) => n.captures) as AParser<Record<string, string>> }
  })

  return { config, rules, dialect, contract }
}

export interface ParseOptions {
  snapshotSha?: string
  limits?: SafetyLimits
  callerContext?: unknown
}

export function parseWith<TOutput>(
  compiled: CompiledParser<TOutput>,
  input: string,
  opts: ParseOptions = {},
): ParseResult<TOutput> {
  const limits = opts.limits ?? DEFAULT_SAFETY_LIMITS
  const snapshotSha = opts.snapshotSha ?? 'unknown'
  const parserId = compiled.config.parserId

  if (input.length > limits.maxInputLength) {
    return {
      ok: false,
      reason: 'safety_aborted',
      parserId,
      snapshotSha,
      diagnostics: [
        {
          ruleId: '',
          reason: `input length ${input.length} exceeds limit ${limits.maxInputLength}`,
        },
      ],
    }
  }

  const diagnostics = []
  for (const cr of compiled.rules) {
    const r = cr.parser.run(input)
    if (r.isError) {
      diagnostics.push({
        ruleId: cr.rule.id,
        reason: typeof r.error === 'string' ? r.error : 'parse error',
        failureOffset: r.index,
      })
      continue
    }
    // Project + transform + zod + semantic
    const captures = r.result as Record<string, string>
    const projected = applyProjection(cr.rule, captures, compiled, opts.callerContext)
    if ('error' in projected) {
      diagnostics.push({ ruleId: cr.rule.id, reason: projected.error })
      continue
    }
    const schemaCheck = compiled.contract.outputSchema.safeParse(projected.value)
    if (!schemaCheck.success) {
      diagnostics.push({
        ruleId: cr.rule.id,
        reason: `output schema: ${schemaCheck.error.message}`,
      })
      continue
    }
    const semantic = compiled.contract.semanticValidate(schemaCheck.data)
    if (semantic.length > 0) {
      diagnostics.push({
        ruleId: cr.rule.id,
        reason: `semantic: ${semantic.map((i) => `${i.code}:${i.message}`).join('; ')}`,
      })
      continue
    }
    return {
      ok: true,
      output: schemaCheck.data,
      ruleId: cr.rule.id,
      parserId,
      snapshotSha,
    }
  }
  return {
    ok: false,
    reason: 'no_match',
    parserId,
    snapshotSha,
    diagnostics,
  }
}

// ---------------------------------------------------------------------

function applyProjection<TOutput>(
  rule: Rule,
  captures: Record<string, string>,
  compiled: CompiledParser<TOutput>,
  callerContext: unknown,
): { value: unknown } | { error: string } {
  const out: Record<string, unknown> = {}
  const ctx: TransformContext<TOutput> = {
    output: out as Partial<TOutput>,
    captures,
    callerContext,
  }
  // Per-field projection
  for (const [field, ve] of Object.entries(rule.project)) {
    try {
      out[field] = evalValueExpr(ve, ctx, compiled.dialect as DialectPack<unknown>)
    } catch (err) {
      return { error: `projection field '${field}': ${(err as Error).message}` }
    }
  }
  // Rule-level transforms run after all fields are projected; they can
  // observe and mutate the output object.
  if (rule.transforms) {
    for (const call of rule.transforms) {
      const def = compiled.dialect.transforms[call.name]
      if (!def) return { error: `transform '${call.name}' not found in dialect` }
      try {
        def.impl(call.args, ctx as TransformContext<unknown>)
      } catch (err) {
        return { error: `transform '${call.name}': ${(err as Error).message}` }
      }
    }
  }
  return { value: out }
}

function evalValueExpr(
  ve: ValueExpr,
  ctx: TransformContext<unknown>,
  dialect: DialectPack<unknown>,
): unknown {
  if ('literal' in ve) return ve.literal
  let v: unknown = ctx.captures[ve.from]
  if (v === undefined) {
    throw new Error(`missing capture '${ve.from}'`)
  }
  if (ve.transforms) {
    // Per-field transforms use a transient sub-context whose output is
    // a single-field bag {value}. Each transform mutates that bag's
    // .value, then we return it.
    const bag = { value: v }
    const subCtx: TransformContext<unknown> = {
      output: bag as unknown as Partial<unknown>,
      captures: ctx.captures,
      callerContext: ctx.callerContext,
    }
    for (const call of ve.transforms) {
      const def = dialect.transforms[call.name]
      if (!def) throw new Error(`transform '${call.name}' not found`)
      def.impl(call.args, subCtx)
    }
    v = bag.value
  }
  return v
}
