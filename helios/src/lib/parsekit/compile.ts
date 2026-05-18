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
  everyCharUntil as aEveryCharUntil,
  fail as aFail,
  many as aMany,
  optionalWhitespace as aOptWs,
  possibly as aPossibly,
  sepBy as aSepBy,
  sequenceOf as aSeq,
  str as aStr,
  succeedWith as aSucceed,
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
  listCaptures: Record<string, string[]>
}

const EMPTY: CaptureNode = { text: '', captures: {}, listCaptures: {} }

function ok(
  text: string,
  captures: Record<string, string> = {},
  listCaptures: Record<string, string[]> = {},
): CaptureNode {
  return { text, captures, listCaptures }
}

function mergeMap<V>(a: Record<string, V>, b: Record<string, V>): Record<string, V> {
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
        listCaptures: node.listCaptures,
      })) as AParser<CaptureNode>
    }
    case 'captureMany':
      return compileCaptureMany(expr.name, expr.expr, dialect)
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
    case 'consumeUntil':
      return compileConsumeUntil(expr.terminator, expr.minLen ?? 1, dialect)
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
    return aSucceed(EMPTY) as AParser<CaptureNode>
  }
  return aSeq(parts).map((nodes) => {
    const ns = nodes as CaptureNode[]
    let text = ''
    let caps: Record<string, string> = {}
    let lists: Record<string, string[]> = {}
    for (const n of ns) {
      text += n.text
      caps = mergeMap(caps, n.captures)
      lists = mergeMap(lists, n.listCaptures)
    }
    return { text, captures: caps, listCaptures: lists }
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
      return aFail(
        `parsekit: repeat count ${rs.length} outside [${min}, ${max}]`,
      ) as AParser<CaptureNode>
    }
    let text = ''
    let caps: Record<string, string> = {}
    let lists: Record<string, string[]> = {}
    for (const n of rs) {
      text += n.text
      caps = mergeMap(caps, n.captures)
      lists = mergeMap(lists, n.listCaptures)
    }
    return aSucceed({ text, captures: caps, listCaptures: lists }) as AParser<CaptureNode>
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
      return aFail(
        `parsekit: sepBy count ${rs.length} outside [${lo}, ${hi}]`,
      ) as AParser<CaptureNode>
    }
    let text = ''
    let caps: Record<string, string> = {}
    let lists: Record<string, string[]> = {}
    for (const n of rs) {
      text += n.text
      caps = mergeMap(caps, n.captures)
      lists = mergeMap(lists, n.listCaptures)
    }
    return aSucceed({ text, captures: caps, listCaptures: lists }) as AParser<CaptureNode>
  }) as AParser<CaptureNode>
}

/**
 * Compile a `captureMany(name, body)` node. The body MUST be either
 * `repeat` or `sepBy`; we compile the inner body element (not the
 * whole repeat/sepBy) and then run arcsecond's many/sepBy directly so
 * we keep access to the *array* of child CaptureNodes rather than the
 * joined text. Each child's `.text` becomes one item in the list
 * capture `listCaptures[name]`.
 */
function compileCaptureMany(
  name: string,
  body: Expr,
  dialect: DialectPack<unknown>,
): AParser<CaptureNode> {
  if (body.kind === 'repeat') {
    const inner = compileExpr(body.expr, dialect)
    const min = body.min
    const max = body.max
    return aMany(inner).chain((rsRaw) => {
      const rs = rsRaw as CaptureNode[]
      if (rs.length < min || rs.length > max) {
        return aFail(
          `parsekit: captureMany('${name}') repeat count ${rs.length} outside [${min}, ${max}]`,
        ) as AParser<CaptureNode>
      }
      return aSucceed(buildListCapture(name, rs)) as AParser<CaptureNode>
    }) as AParser<CaptureNode>
  }
  if (body.kind === 'sepBy') {
    const innerBody = compileExpr(body.expr, dialect)
    const innerSep = compileExpr(body.sep, dialect)
    const lo = body.min ?? 0
    const hi = body.max ?? Number.POSITIVE_INFINITY
    return aSepBy(innerSep)(innerBody).chain((rsRaw) => {
      const rs = rsRaw as CaptureNode[]
      if (rs.length < lo || rs.length > hi) {
        return aFail(
          `parsekit: captureMany('${name}') sepBy count ${rs.length} outside [${lo}, ${hi}]`,
        ) as AParser<CaptureNode>
      }
      // sepBy text reconstruction needs the original separator text
      // between items; we don't have it here, but the parsed string IS
      // already advanced past the separators, so we just join with a
      // single space placeholder for the .text return (it's not used
      // anywhere meaningful — list-capture consumers read listCaptures).
      return aSucceed(buildListCapture(name, rs, ' ')) as AParser<CaptureNode>
    }) as AParser<CaptureNode>
  }
  throw new Error(
    `parsekit: captureMany body must be 'repeat' or 'sepBy' (got '${body.kind}')`,
  )
}

function buildListCapture(
  name: string,
  rs: CaptureNode[],
  textJoiner = '',
): CaptureNode {
  const items: string[] = []
  let text = ''
  for (const n of rs) {
    items.push(n.text)
    text += (text.length > 0 ? textJoiner : '') + n.text
  }
  return {
    text,
    captures: {},
    listCaptures: { [name]: items },
  }
}

function compileConsumeUntil(
  terminator: Expr,
  minLen: number,
  dialect: DialectPack<unknown>,
): AParser<CaptureNode> {
  const term = compileExpr(terminator, dialect) as AParser<unknown>
  return aEveryCharUntil(term).chain((sRaw) => {
    const s = sRaw as string
    if (s.length < minLen) {
      return aFail(
        `parsekit: consumeUntil consumed ${s.length} chars, min ${minLen}`,
      ) as AParser<CaptureNode>
    }
    return aSucceed(ok(s)) as AParser<CaptureNode>
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
      case 'captureMany':
        return { kind: 'captureMany', name: e.name, expr: walk(e.expr) }
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
      case 'consumeUntil':
        return { kind: 'consumeUntil', terminator: walk(e.terminator), minLen: e.minLen }
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
