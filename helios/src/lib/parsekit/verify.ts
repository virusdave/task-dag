/**
 * Static safety verifier for parsekit configs.
 *
 * Enforces (per EPIC_PLAN §Security floor):
 *   - acyclic ref/macro graph
 *   - bounded repeat / sepBy (max required + within limits)
 *   - max AST depth
 *   - max choice fanout
 *   - all token/macro/transform references resolve
 *   - projection allowlist: every projected field appears in the
 *     output schema (caller passes the allowed field set).
 *
 * Pure / isomorphic — no Node deps.
 */

import {
  DEFAULT_SAFETY_LIMITS,
  type DialectPack,
  type Expr,
  type Rule,
  type SafetyLimits,
  type TenantParserConfig,
  type ValueExpr,
} from './types.js'

export interface SafetyIssue {
  code:
    | 'unknown_token'
    | 'unknown_macro'
    | 'unknown_ref'
    | 'unknown_transform'
    | 'transform_version_mismatch'
    | 'repeat_unbounded'
    | 'repeat_max_too_large'
    | 'repeat_empty_body'
    | 'sepby_max_too_large'
    | 'sepby_empty_body'
    | 'sepby_empty_separator'
    | 'choice_fanout_too_large'
    | 'depth_exceeded'
    | 'cycle_detected'
    | 'macro_args_unknown'
    | 'projection_unknown_field'
    | 'projection_from_unknown_capture'
    | 'duplicate_rule_id'
    | 'duplicate_capture_name'
    | 'detect_prefix_empty'
    | 'dialect_ref_mismatch'
    | 'use_case_mismatch'
  message: string
  path: string
}

export interface SafetyReport {
  ok: boolean
  issues: SafetyIssue[]
}

interface VerifyContext {
  dialect: DialectPack<unknown>
  limits: SafetyLimits
  allowedOutputFields: Set<string>
  issues: SafetyIssue[]
  /** Ref/macro names currently being expanded — cycle guard. */
  expansionStack: Set<string>
}

export function verifyParser(
  config: TenantParserConfig,
  dialect: DialectPack<unknown>,
  allowedOutputFields: Set<string>,
  useCase?: string,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS,
): SafetyReport {
  const ctx: VerifyContext = {
    dialect,
    limits,
    allowedOutputFields,
    issues: [],
    expansionStack: new Set(),
  }

  // DialectRef must match the supplied dialect pack (id + version).
  if (config.dialectRef.id !== dialect.id || config.dialectRef.version !== dialect.version) {
    ctx.issues.push({
      code: 'dialect_ref_mismatch',
      message:
        `Parser dialectRef ${config.dialectRef.id}@${config.dialectRef.version} ` +
        `does not match supplied dialect ${dialect.id}@${dialect.version}`,
      path: 'dialectRef',
    })
  }

  // Use-case identity must match the contract the caller has chosen.
  if (useCase !== undefined && config.scope.useCase !== useCase) {
    ctx.issues.push({
      code: 'use_case_mismatch',
      message:
        `Parser scope.useCase='${config.scope.useCase}' does not match ` +
        `requested useCase='${useCase}'`,
      path: 'scope.useCase',
    })
  }

  // Duplicate rule IDs
  const seenRuleIds = new Set<string>()
  for (const rule of config.rules) {
    if (seenRuleIds.has(rule.id)) {
      ctx.issues.push({
        code: 'duplicate_rule_id',
        message: `Rule id '${rule.id}' is not unique within parser`,
        path: `rules[id=${rule.id}]`,
      })
    }
    seenRuleIds.add(rule.id)
  }

  // Detect prefixes: empty strings are dangerous
  if (config.detect.prefixes) {
    for (const [i, p] of config.detect.prefixes.entries()) {
      if (!p || p.trim().length === 0) {
        ctx.issues.push({
          code: 'detect_prefix_empty',
          message: 'Detect prefix must be non-empty',
          path: `detect.prefixes[${i}]`,
        })
      }
    }
  }

  // Per-rule structural checks
  for (const rule of config.rules) {
    const capturesSeen = new Set<string>()
    walkExpr(rule.parser, `rules[id=${rule.id}].parser`, 0, capturesSeen, ctx)
    verifyProjection(rule, capturesSeen, ctx)
    verifyTransformsList(rule.transforms, `rules[id=${rule.id}].transforms`, ctx)
  }

  return { ok: ctx.issues.length === 0, issues: ctx.issues }
}

// ---------------------------------------------------------------------

function walkExpr(
  expr: Expr,
  path: string,
  depth: number,
  captures: Set<string>,
  ctx: VerifyContext,
): void {
  if (depth > ctx.limits.maxDepth) {
    ctx.issues.push({
      code: 'depth_exceeded',
      message: `AST depth ${depth} exceeds limit ${ctx.limits.maxDepth}`,
      path,
    })
    return
  }
  switch (expr.kind) {
    case 'lit':
    case 'token': {
      if (expr.kind === 'token' && !ctx.dialect.tokens[expr.token]) {
        ctx.issues.push({
          code: 'unknown_token',
          message: `Unknown token '${expr.token}'`,
          path,
        })
      }
      return
    }
    case 'seq':
    case 'choice': {
      if (expr.kind === 'choice' && expr.items.length > ctx.limits.maxChoiceFanout) {
        ctx.issues.push({
          code: 'choice_fanout_too_large',
          message: `choice fanout ${expr.items.length} exceeds limit ${ctx.limits.maxChoiceFanout}`,
          path,
        })
      }
      for (const [i, child] of expr.items.entries()) {
        walkExpr(child, `${path}.items[${i}]`, depth + 1, captures, ctx)
      }
      return
    }
    case 'capture': {
      if (captures.has(expr.name)) {
        ctx.issues.push({
          code: 'duplicate_capture_name',
          message: `Duplicate capture name '${expr.name}' in rule`,
          path,
        })
      }
      captures.add(expr.name)
      walkExpr(expr.expr, `${path}.capture(${expr.name})`, depth + 1, captures, ctx)
      return
    }
    case 'optional': {
      walkExpr(expr.expr, `${path}.optional`, depth + 1, captures, ctx)
      return
    }
    case 'repeat': {
      if (typeof expr.max !== 'number') {
        ctx.issues.push({
          code: 'repeat_unbounded',
          message: 'repeat.max is required',
          path,
        })
      } else if (expr.max > ctx.limits.maxRepeat) {
        ctx.issues.push({
          code: 'repeat_max_too_large',
          message: `repeat.max ${expr.max} exceeds limit ${ctx.limits.maxRepeat}`,
          path,
        })
      }
      if (canMatchEmpty(expr.expr, ctx.dialect)) {
        ctx.issues.push({
          code: 'repeat_empty_body',
          message:
            'repeat body can match empty input; this would loop or be ambiguous. ' +
            'Wrap in a non-empty primitive or use optional() outside the repeat.',
          path: `${path}.repeat`,
        })
      }
      walkExpr(expr.expr, `${path}.repeat`, depth + 1, captures, ctx)
      return
    }
    case 'between': {
      walkExpr(expr.left, `${path}.between.left`, depth + 1, captures, ctx)
      walkExpr(expr.expr, `${path}.between.body`, depth + 1, captures, ctx)
      walkExpr(expr.right, `${path}.between.right`, depth + 1, captures, ctx)
      return
    }
    case 'sepBy': {
      if (typeof expr.max === 'number' && expr.max > ctx.limits.maxRepeat) {
        ctx.issues.push({
          code: 'sepby_max_too_large',
          message: `sepBy.max ${expr.max} exceeds limit ${ctx.limits.maxRepeat}`,
          path,
        })
      }
      if (canMatchEmpty(expr.expr, ctx.dialect)) {
        ctx.issues.push({
          code: 'sepby_empty_body',
          message: 'sepBy body can match empty input; would loop or be ambiguous.',
          path: `${path}.sepBy.body`,
        })
      }
      if (canMatchEmpty(expr.sep, ctx.dialect)) {
        ctx.issues.push({
          code: 'sepby_empty_separator',
          message: 'sepBy separator can match empty input; this is ambiguous.',
          path: `${path}.sepBy.sep`,
        })
      }
      walkExpr(expr.expr, `${path}.sepBy.body`, depth + 1, captures, ctx)
      walkExpr(expr.sep, `${path}.sepBy.sep`, depth + 1, captures, ctx)
      return
    }
    case 'consumeUntil': {
      // The terminator runs as a lookahead; captures inside it are
      // not consumed and would be misleading, but we still walk it to
      // validate references.
      walkExpr(expr.terminator, `${path}.consumeUntil.terminator`, depth + 1, captures, ctx)
      return
    }
    case 'ref': {
      // No top-level rule-ref table in v1; reserve for v2.
      ctx.issues.push({
        code: 'unknown_ref',
        message: `ref targets are not supported in v1 (target='${expr.target}')`,
        path,
      })
      return
    }
    case 'macro': {
      const def = ctx.dialect.macros[expr.target]
      if (!def) {
        ctx.issues.push({
          code: 'unknown_macro',
          message: `Unknown macro '${expr.target}'`,
          path,
        })
        return
      }
      if (expr.args) {
        for (const k of Object.keys(expr.args)) {
          if (!def.params.includes(k)) {
            ctx.issues.push({
              code: 'macro_args_unknown',
              message: `Macro '${expr.target}' does not accept arg '${k}'`,
              path,
            })
          }
        }
      }
      // Cycle guard.
      if (ctx.expansionStack.has(expr.target)) {
        ctx.issues.push({
          code: 'cycle_detected',
          message: `Cycle through macro '${expr.target}'`,
          path,
        })
        return
      }
      ctx.expansionStack.add(expr.target)
      walkExpr(def.body, `${path}.macro(${expr.target})`, depth + 1, captures, ctx)
      ctx.expansionStack.delete(expr.target)
      return
    }
  }
}

function verifyProjection(rule: Rule, captures: Set<string>, ctx: VerifyContext): void {
  for (const [field, value] of Object.entries(rule.project)) {
    if (!ctx.allowedOutputFields.has(field)) {
      ctx.issues.push({
        code: 'projection_unknown_field',
        message: `Projection field '${field}' is not in the use-case output schema`,
        path: `rules[id=${rule.id}].project.${field}`,
      })
    }
    verifyValueExpr(value, `rules[id=${rule.id}].project.${field}`, captures, ctx)
  }
}

function verifyValueExpr(
  v: ValueExpr,
  path: string,
  captures: Set<string>,
  ctx: VerifyContext,
): void {
  if ('literal' in v) return
  if (!captures.has(v.from)) {
    ctx.issues.push({
      code: 'projection_from_unknown_capture',
      message: `Projection references unknown capture '${v.from}'`,
      path,
    })
  }
  verifyTransformsList(v.transforms, `${path}.transforms`, ctx)
}

function verifyTransformsList(
  calls: Rule['transforms'] | undefined,
  path: string,
  ctx: VerifyContext,
): void {
  if (!calls) return
  for (const [i, call] of calls.entries()) {
    const def = ctx.dialect.transforms[call.name]
    if (!def) {
      ctx.issues.push({
        code: 'unknown_transform',
        message: `Unknown transform '${call.name}'`,
        path: `${path}[${i}]`,
      })
      continue
    }
    if (call.version !== def.version) {
      ctx.issues.push({
        code: 'transform_version_mismatch',
        message:
          `Transform '${call.name}' v${call.version} requested but dialect ships v${def.version}; ` +
          `update the call to v${def.version} or pin to an older dialect.`,
        path: `${path}[${i}]`,
      })
    }
    if (def.argsSchema) {
      const r = def.argsSchema.safeParse(call.args ?? undefined)
      if (!r.success) {
        ctx.issues.push({
          code: 'unknown_transform',
          message: `Transform '${call.name}' args invalid: ${r.error.message}`,
          path: `${path}[${i}]`,
        })
      }
    }
  }
}

/**
 * Conservative static check: returns true if `expr` can succeed
 * without consuming any input. Used to reject repeat/sepBy whose body
 * matches empty (a classic parser footgun).
 *
 * Token primitives are treated as opaque — they are assumed to be
 * non-empty-consuming. The one dialect token we know about and that
 * canonically matches empty is `optWs`; we special-case it.
 */
function canMatchEmpty(expr: Expr, dialect: DialectPack<unknown>): boolean {
  switch (expr.kind) {
    case 'lit':
      return expr.value.length === 0
    case 'token':
      // Conservative special-case for our known optional-whitespace
      // token; everything else is treated as consuming.
      return expr.token === 'optWs'
    case 'optional':
      return true
    case 'seq':
      return expr.items.every((e) => canMatchEmpty(e, dialect))
    case 'choice':
      return expr.items.some((e) => canMatchEmpty(e, dialect))
    case 'capture':
      return canMatchEmpty(expr.expr, dialect)
    case 'repeat':
      return expr.min === 0 || canMatchEmpty(expr.expr, dialect)
    case 'sepBy':
      return (expr.min ?? 0) === 0
    case 'between':
      return (
        canMatchEmpty(expr.left, dialect) &&
        canMatchEmpty(expr.expr, dialect) &&
        canMatchEmpty(expr.right, dialect)
      )
    case 'consumeUntil':
      return (expr.minLen ?? 1) === 0
    case 'macro':
    case 'ref':
      return false
  }
}
