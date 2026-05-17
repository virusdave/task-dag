/**
 * Compile a parsekit Expr (using a DialectPack's tokens + macros) into
 * an arcsecond parser whose result is `CaptureNode = { text, captures }`.
 *
 * - `text` is the matched substring (concatenation of children).
 * - `captures` is the merged map of named captures inside this subtree.
 *
 * Strictly pure / isomorphic; assumes the parser has already passed
 * verifyParser() so we may throw on structural problems we see here
 * (they should have been reported as issues earlier).
 */

import {
  between as aBetween,
  char as aChar,
  choice as aChoice,
  digits as aDigits,
  endOfInput as aEnd,
  many as aMany,
  optionalWhitespace as aOptWs,
  possibly as aPossibly,
  sepBy as aSepBy,
  sequenceOf as aSeq,
  str as aStr,
  whitespace as aWs,
  type Parser as AParser,
} from 'arcsecond'

import type {
  DialectPack,
  Expr,
  MacroDef,
  TokenDef,
} from './types.js'

export interface CaptureNode {
  text: string
  captures: Record<string, string>
}

const EMPTY: CaptureNode = { text: '', captures: {} }

function ok(text: string, captures: Record<string, string> = {}): CaptureNode {
  return { text, captures }
}

function mergeCaptures(a: Record<string, string>, b: Record<string, string>): Record<string, string> {
  // Right-biased merge keeps "last seen" semantics, which matches the
  // sequential order children are walked in.
  if (Object.keys(a).length === 0) return b
  if (Object.keys(b).length === 0) return a
  return { ...a, ...b }
}

// ---------------------------------------------------------------------

export function compileExpr(
  expr: Expr,
  dialect: DialectPack<unknown>,
): AParser<CaptureNode> {
  switch (expr.kind) {
    case 'lit':
      return compileLit(expr.value, expr.caseInsensitive === true)
    case 'token':
      return compileToken(expr.token, dialect)
    case 'seq':
      return compileSeq(expr.items.map((e) => compileExpr(e, dialect)))
    case 'choice':
      return compileChoice(expr.items.map((e) => compileExpr(e, dialect)))
    case 'capture': {
      const inner = compileExpr(expr.expr, dialect)
      return inner.map((node: CaptureNode) => ({
        text: node.text,
        captures: { ...node.captures, [expr.name]: node.text },
      })) as AParser<CaptureNode>
    }
    case 'optional': {
      const inner = compileExpr(expr.expr, dialect)
      return aPossibly(inner).map((r) => (r === null ? EMPTY : (r as CaptureNode))) as AParser<CaptureNode>
    }
    case 'repeat':
      return compileRepeat(expr.expr, expr.min, expr.max, dialect)
    case 'between': {
      const l = compileExpr(expr.left, dialect)
      const r = compileExpr(expr.right, dialect)
      const body = compileExpr(expr.expr, dialect)
      return aBetween(l)(r)(body).map((node) => node as CaptureNode)
    }
    case 'sepBy':
      return compileSepBy(expr.expr, expr.sep, expr.min, expr.max, dialect)
    case 'macro':
      return compileMacro(expr.target, expr.args, dialect)
    case 'ref':
      throw new Error(`parsekit: 'ref' is not supported in v1 (target='${expr.target}')`)
  }
}

// ---------------------------------------------------------------------

function compileLit(value: string, ci: boolean): AParser<CaptureNode> {
  if (!ci) {
    return aStr(value).map((s) => ok(s as string)) as AParser<CaptureNode>
  }
  // Case-insensitive: match each character against either case.
  const lower = value.toLowerCase()
  const upper = value.toUpperCase()
  const charParsers: AParser<string>[] = []
  for (let i = 0; i < value.length; i++) {
    const lo = lower[i]
    const hi = upper[i]
    if (lo === hi) {
      charParsers.push(aChar(lo) as AParser<string>)
    } else {
      charParsers.push(aChoice([aChar(lo), aChar(hi)]) as AParser<string>)
    }
  }
  return aSeq(charParsers).map((chars) => ok((chars as string[]).join(''))) as AParser<CaptureNode>
}

function compileToken(name: string, dialect: DialectPack<unknown>): AParser<CaptureNode> {
  const def: TokenDef | undefined = dialect.tokens[name]
  if (!def) {
    throw new Error(`parsekit: unknown token '${name}' (dialect=${dialect.id})`)
  }
  if (def.expr) return compileExpr(def.expr, dialect)
  if (def.parser) {
    return (def.parser as AParser<unknown>).map((v) => {
      // Raw parser is expected to return a string (the matched text).
      // If it returns anything else, we coerce to its String value.
      const text = typeof v === 'string' ? v : v == null ? '' : String(v)
      return ok(text)
    }) as AParser<CaptureNode>
  }
  throw new Error(`parsekit: token '${name}' has neither expr nor parser`)
}

function compileSeq(parts: AParser<CaptureNode>[]): AParser<CaptureNode> {
  if (parts.length === 0) {
    return aStr('').map(() => EMPTY) as AParser<CaptureNode>
  }
  return aSeq(parts).map((nodes) => {
    const ns = nodes as CaptureNode[]
    let text = ''
    let caps: Record<string, string> = {}
    for (const n of ns) {
      text += n.text
      caps = mergeCaptures(caps, n.captures)
    }
    return { text, captures: caps }
  }) as AParser<CaptureNode>
}

function compileChoice(opts: AParser<CaptureNode>[]): AParser<CaptureNode> {
  return aChoice(opts) as AParser<CaptureNode>
}

function compileRepeat(
  body: Expr,
  min: number,
  max: number,
  dialect: DialectPack<unknown>,
): AParser<CaptureNode> {
  const inner = compileExpr(body, dialect)
  // arcsecond's `many` is 0..n with no upper bound. We post-validate to
  // enforce min/max and cap at our safety limit.
  return aMany(inner).chain((rsRaw) => {
    const rs = rsRaw as CaptureNode[]
    if (rs.length < min || rs.length > max) {
      // Force a failure: use a never-matching parser. We import from
      // arcsecond's choice with no alternatives — simulate via a parser
      // that always fails.
      return aStr('\u0000__parsekit_repeat_oob__').map(() => EMPTY) as AParser<CaptureNode>
    }
    return aStr('').map(() => {
      let text = ''
      let caps: Record<string, string> = {}
      for (const n of rs) {
        text += n.text
        caps = mergeCaptures(caps, n.captures)
      }
      return { text, captures: caps }
    }) as AParser<CaptureNode>
  }) as AParser<CaptureNode>
}

function compileSepBy(
  body: Expr,
  sep: Expr,
  min: number | undefined,
  max: number | undefined,
  dialect: DialectPack<unknown>,
): AParser<CaptureNode> {
  const innerBody = compileExpr(body, dialect)
  const innerSep = compileExpr(sep, dialect)
  return aSepBy(innerSep)(innerBody).chain((rsRaw) => {
    const rs = rsRaw as CaptureNode[]
    const lo = min ?? 0
    const hi = max ?? Number.POSITIVE_INFINITY
    if (rs.length < lo || rs.length > hi) {
      return aStr('\u0000__parsekit_sepby_oob__').map(() => EMPTY) as AParser<CaptureNode>
    }
    return aStr('').map(() => {
      let text = ''
      let caps: Record<string, string> = {}
      for (const n of rs) {
        text += n.text
        caps = mergeCaptures(caps, n.captures)
      }
      return { text, captures: caps }
    }) as AParser<CaptureNode>
  }) as AParser<CaptureNode>
}

function compileMacro(
  name: string,
  args: Record<string, unknown> | undefined,
  dialect: DialectPack<unknown>,
): AParser<CaptureNode> {
  const def: MacroDef | undefined = dialect.macros[name]
  if (!def) {
    throw new Error(`parsekit: unknown macro '${name}' (dialect=${dialect.id})`)
  }
  const expanded = expandMacro(def, args ?? {})
  return compileExpr(expanded, dialect)
}

/**
 * Expand `${param}` placeholders inside a macro's body. Currently we
 * support substitution in `lit.value` only — that is enough to template
 * brand/family literals into shared macros (see EPIC_PLAN §4
 * "metrc.brand-dash-group-dash-family-dash-...").
 */
function expandMacro(def: MacroDef, args: Record<string, unknown>): Expr {
  const subst = (s: string): string =>
    s.replace(/\$\{(\w+)\}/g, (_m, name) => {
      const v = args[name]
      if (v == null) return ''
      return String(v)
    })
  const walk = (e: Expr): Expr => {
    switch (e.kind) {
      case 'lit':
        return { kind: 'lit', value: subst(e.value), caseInsensitive: e.caseInsensitive }
      case 'token':
        return e
      case 'seq':
        return { kind: 'seq', items: e.items.map(walk) }
      case 'choice':
        return { kind: 'choice', items: e.items.map(walk) }
      case 'capture':
        return { kind: 'capture', name: e.name, expr: walk(e.expr) }
      case 'optional':
        return { kind: 'optional', expr: walk(e.expr) }
      case 'repeat':
        return { kind: 'repeat', expr: walk(e.expr), min: e.min, max: e.max }
      case 'between':
        return {
          kind: 'between',
          expr: walk(e.expr),
          left: walk(e.left),
          right: walk(e.right),
        }
      case 'sepBy':
        return { kind: 'sepBy', expr: walk(e.expr), sep: walk(e.sep), min: e.min, max: e.max }
      case 'ref':
        return e
      case 'macro':
        return { kind: 'macro', target: e.target, args: e.args }
    }
  }
  return walk(def.body)
}

// ---------------------------------------------------------------------
// Re-export a few useful raw arcsecond parsers so dialect packs that
// want to ship efficient primitives don't all have to import arcsecond
// directly.
// ---------------------------------------------------------------------

export const _raw = {
  digits: aDigits,
  ws: aWs,
  optWs: aOptWs,
  end: aEnd,
}
