/**
 * METRC v1 dialect pack for the pending-purchase product-name parser.
 *
 * Tokens are raw arcsecond parsers (regex-backed for speed) — the
 * "no regex primitive in v1" rule from EPIC §Security floor applies to
 * tenant-authored configs, not to dialect-internal token impls.
 *
 * Transforms are versioned (`version: 1`) and pure: given the same
 * (args, captures, output) they must produce the same mutation. This
 * matters for golden replay and the reconciler's proposal validator.
 *
 * Backed by ParsedProductName (see contracts/pendingPurchases.ts).
 */

import { z } from 'zod'
import { optionalWhitespace as aOptWs, regex as aRegex } from 'arcsecond'

import type {
  DialectPack,
  MacroDef,
  TokenDef,
  TransformContext,
  TransformDef,
} from '../types.js'
import type { ParsedProductName } from '../contracts/pendingPurchases.js'

// ---------------------------------------------------------------------
// Tokens (raw arcsecond parsers — return matched substring as string)
// ---------------------------------------------------------------------

const tokens: Record<string, TokenDef> = {
  /** `\s*-\s*` — dash with optional surrounding whitespace. */
  dash: { parser: aRegex(/^\s*-\s*/) as never },
  /** Single space. */
  sp: { parser: aRegex(/^ /) as never },
  /** Required whitespace. */
  ws: { parser: aRegex(/^\s+/) as never },
  /** Optional whitespace (zero or more). */
  optWs: { parser: aOptWs as never },
  /** One or more digits. */
  int: { parser: aRegex(/^\d+/) as never },
  /** Integer or decimal, e.g. `1`, `1.0`, `0.5`, `.5`. Leading dot is
   *  allowed (parseFloat treats `.5` as 0.5). */
  decimal: { parser: aRegex(/^\.?\d+(?:\.\d+)?/) as never },
  /** A grams suffix: `g`. */
  gramsSuffix: { parser: aRegex(/^g/i) as never },
  /** A milligrams suffix: `mg`. */
  milligramsSuffix: { parser: aRegex(/^mg/i) as never },
  /** Single-letter prevalence suffix: `(I)`, `(S)`, `(H)`. */
  prevalenceParen: { parser: aRegex(/^\([ISH]\)/i) as never },
  /** Text up to next dash — non-empty, no dashes. Trims internal
   *  whitespace via cleanCultivar at the projection step. */
  cultivarText: { parser: aRegex(/^[^-]+/) as never },
  /** Pack token like "10PK" / "2PK" — captures the integer. */
  packPK: { parser: aRegex(/^\d+PK/i) as never },
  /** Size text like `3.5g`, `1g`, `.5g`. Used as the trailing size slot
   *  in Curaleaf-style dash-separated names. */
  sizeText: { parser: aRegex(/^\.?\d+(?:\.\d+)?g/i) as never },
  /** Single-letter strain prevalence: `I`, `S`, or `H`. Used as the
   *  trailing prevalence slot in Curaleaf-style names. */
  prevToken: { parser: aRegex(/^[ISH]/) as never },
  /** Modifier-list element: `[^-]+`, but refuses to match a size-shaped
   *  token (`\.?\d+(?:\.\d+)?g(?:-|$)`) or a bare prevalence letter
   *  (`[ISH](?:-|$)`). This lets a greedy `sepBy` over modifiers stop
   *  cleanly at the trailing `-<size>-<prev>` slots without backtrack
   *  gymnastics. See the Curaleaf port. */
  modToken: {
    parser: aRegex(
      /^(?!\.?\d+(?:\.\d+)?g(?:-|$))(?![ISH](?:-|$))[^-]+/,
    ) as never,
  },
  /** Modifier-list separator: a literal `-`, but only when the NEXT
   *  token is NOT a trailing size (`\.?\d+(?:\.\d+)?g(?:-|$)`) or a
   *  bare prevalence (`[ISH](?:-|$)`).
   *
   *  Arcsecond's `sepBy` is non-backtracking: once a separator is
   *  consumed, sepBy commits to the next item. A naive `dash` separator
   *  therefore eats the dash before the trailing `-<size>-<prev>`
   *  slots, and the subsequent modToken refusal kills the whole match.
   *  This token's negative lookahead short-circuits sepBy cleanly. */
  modDash: {
    parser: aRegex(
      /^-(?![ISH](?:-|$))(?!\.?\d+(?:\.\d+)?g(?:-|$))/,
    ) as never,
  },
}

// ---------------------------------------------------------------------
// Macros (none in v1 slice — tenants compose tokens directly)
// ---------------------------------------------------------------------

const macros: Record<string, MacroDef> = {}

// ---------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------

const NAME_ALIASES = new Map<string, string>([
  ['Happy Purp', 'Happy Purps'],
  ['#JUAN-ROLL', '#Juan Roll'],
  ['Select Essentials', 'Select'],
])

const PREVALENCE_MAP = new Map<string, string>([
  ['I', 'Indica'],
  ['S', 'Sativa'],
  ['H', 'Hybrid'],
])

function formatGramsNumber(value: number): string {
  return `${Number.parseFloat(value.toFixed(2))}g`
}

/** Per-value transform helper: read+write the transient bag from a per-field projection. */
function bagOf(ctx: TransformContext<unknown>): { value: unknown } {
  return ctx.output as unknown as { value: unknown }
}

/** Throw if the per-field bag value is not a string[]. List transforms
 *  call this so misuse on a scalar source surfaces as a parse error
 *  rather than a silent miscompute. */
function assertListBag(bag: { value: unknown }, transformName: string): void {
  if (!Array.isArray(bag.value)) {
    throw new Error(
      `${transformName}: expected list source (use { fromList: ... }); got ${typeof bag.value}`,
    )
  }
}

const transforms: Record<string, TransformDef<ParsedProductName>> = {
  /** Trim whitespace + strip `(I|S|H)` suffix + apply NAME_ALIASES.
   *  TODO(parsekit-configs): NAME_ALIASES should migrate to per-tenant
   *  config via the generic `mapValue` transform (Phase 6.5). */
  cleanCultivar: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const s = String(bag.value ?? '')
      const trimmed = s.trim().replace(/\s*\((?:I|S|H)\)\s*$/i, '')
      bag.value = NAME_ALIASES.get(trimmed) ?? trimmed
    },
  },
  /** Parse a string of ONLY digits into an integer. Throws if the
   *  string contains anything else (so "10PK" no longer silently
   *  becomes 10 — the parser is forced to capture only the digits). */
  parseIntStrict: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const s = String(bag.value ?? '').trim()
      if (!/^\d+$/.test(s)) {
        throw new Error(
          `parseIntStrict: value '${s}' is not a pure integer string`,
        )
      }
      bag.value = Number.parseInt(s, 10)
    },
  },
  /** Parse string → number, then format as `Xg`. */
  formatGrams: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const n = Number.parseFloat(String(bag.value))
      bag.value = formatGramsNumber(n)
    },
  },
  /** Format string as `Nmg` (the input is the milligram count as string). */
  formatMilligrams: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const n = Number.parseInt(String(bag.value), 10)
      bag.value = `${n}mg`
    },
  },
  /** Derive prevalence from `(I)|(S)|(H)` capture; output `'Indica'|'Sativa'|'Hybrid'|null`. */
  prevalenceFromParen: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const m = /\((I|S|H)\)/i.exec(String(bag.value ?? ''))
      bag.value = m ? PREVALENCE_MAP.get(m[1].toUpperCase()) ?? null : null
    },
  },
  /**
   * Rule-level transform: set `variantTab` from a size field + the
   * already-projected `packCount`.
   * args: { sizeField: string }
   *  - if packCount > 1: variantTab = `${packCount}x ${size}`
   *  - else:             variantTab = size
   */
  composeVariantTab: {
    version: 1,
    argsSchema: z.object({ sizeField: z.string().min(1) }).strict(),
    impl: (args, ctx) => {
      const a = args as { sizeField: string }
      const out = ctx.output as Record<string, unknown>
      const pack = Number(out.packCount ?? 1)
      const size = String(out[a.sizeField] ?? '')
      out.variantTab = pack > 1 ? `${pack}x ${size}` : size
    },
  },
  /**
   * Rule-level transform: build `variantName` from named output fields.
   * args: { fields: string[] }  → variantName = fields.map(f => output[f]).join(' ')
   * Default fields: ['brand', 'groupName', 'variantTab'].
   */
  composeVariantName: {
    version: 1,
    argsSchema: z
      .object({ fields: z.array(z.string().min(1)).min(1).optional() })
      .strict()
      .optional(),
    impl: (args, ctx) => {
      const a = (args ?? {}) as { fields?: string[] }
      const out = ctx.output as Record<string, unknown>
      const fields = a.fields ?? ['brand', 'groupName', 'variantTab']
      out.variantName = fields.map((f) => String(out[f] ?? '')).join(' ')
    },
  },
  /**
   * Rule-level transform: copy one output field into another.
   * args: { from: string, to: string }
   */
  copyField: {
    version: 1,
    argsSchema: z.object({ from: z.string().min(1), to: z.string().min(1) }).strict(),
    impl: (args, ctx) => {
      const a = args as { from: string; to: string }
      const out = ctx.output as Record<string, unknown>
      out[a.to] = out[a.from]
    },
  },
  /**
   * Title-case the value only if it is entirely uppercase. Mirrors the
   * legacy parseMoonlitName behavior:
   *   `rawCultivar === rawCultivar.toUpperCase() ? toTitleCase(rawCultivar) : rawCultivar`
   */
  titleCaseIfAllUpper: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const s = String(bag.value ?? '').trim()
      if (s.length === 0 || s !== s.toUpperCase()) {
        bag.value = s
        return
      }
      bag.value = s
        .toLowerCase()
        .split(/\s+/)
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join(' ')
    },
  },
  /**
   * Per-field transform: prepend a static string to the current value.
   * args: { prefix: string }
   */
  prepend: {
    version: 1,
    argsSchema: z.object({ prefix: z.string() }).strict(),
    impl: (args, ctx) => {
      const a = args as { prefix: string }
      const bag = bagOf(ctx)
      bag.value = `${a.prefix}${String(bag.value ?? '')}`
    },
  },
  /**
   * Rule-level transform: derive `size` from a "total grams" capture
   * divided by `output.packCount`, formatted via formatGrams().
   * args: { totalCapture: string, packField?: string = 'packCount',
   *         targetField?: string = 'size' }
   * Mirrors the legacy Smartbud/Cannabals Gummy Brick math.
   */
  sizeFromTotalAndPack: {
    version: 1,
    argsSchema: z
      .object({
        totalCapture: z.string().min(1),
        packField: z.string().min(1).optional(),
        targetField: z.string().min(1).optional(),
      })
      .strict(),
    impl: (args, ctx) => {
      const a = args as {
        totalCapture: string
        packField?: string
        targetField?: string
      }
      const out = ctx.output as Record<string, unknown>
      const packField = a.packField ?? 'packCount'
      const targetField = a.targetField ?? 'size'
      const total = Number.parseFloat(ctx.captures[a.totalCapture] ?? '0')
      const pack = Number(out[packField] ?? 1)
      const per = pack > 0 ? total / pack : total
      out[targetField] = formatGramsNumber(per)
    },
  },
  /**
   * Generic table lookup. Per-field; replaces the input value with
   * `table[normalize(input)]` if present, else with `default` if
   * provided, else passes the original input through.
   *
   * args: { table, default?, caseInsensitive?, trim? }
   *
   * Use cases: brand aliasing (`Grassroots` → `Grass Roots`),
   * label normalization (`(I)` → `Indica`), category mapping. Replaces
   * the dialect-internal NAME_ALIASES / PREVALENCE_MAP tables with
   * per-tenant data in the configs repo.
   */
  mapValue: {
    version: 1,
    argsSchema: z
      .object({
        table: z.record(z.string(), z.string()),
        default: z.string().optional(),
        caseInsensitive: z.boolean().optional(),
        trim: z.boolean().optional(),
      })
      .strict(),
    impl: (args, ctx) => {
      const a = args as {
        table: Record<string, string>
        default?: string
        caseInsensitive?: boolean
        trim?: boolean
      }
      const bag = bagOf(ctx)
      let key = String(bag.value ?? '')
      if (a.trim) key = key.trim()
      const table: Record<string, string> = a.caseInsensitive
        ? Object.fromEntries(Object.entries(a.table).map(([k, v]) => [k.toLowerCase(), v]))
        : a.table
      const lookup = a.caseInsensitive ? key.toLowerCase() : key
      if (Object.prototype.hasOwnProperty.call(table, lookup)) {
        bag.value = table[lookup]
        return
      }
      if (a.default !== undefined) {
        bag.value = a.default
        return
      }
      // Sparse-table passthrough: preserve original input.
      bag.value = bag.value
    },
  },
  /**
   * List-aware (per-field): drop items from a list-source value whose
   * string matches `pattern` (a JS regex; `caseInsensitive` optional).
   * Input MUST be an array (use after `{ fromList: ... }`).
   *
   * args: { pattern: string, caseInsensitive?: boolean }
   */
  filterTokens: {
    version: 1,
    argsSchema: z
      .object({ pattern: z.string().min(1), caseInsensitive: z.boolean().optional() })
      .strict(),
    impl: (args, ctx) => {
      const a = args as { pattern: string; caseInsensitive?: boolean }
      const bag = bagOf(ctx)
      assertListBag(bag, 'filterTokens')
      const re = new RegExp(a.pattern, a.caseInsensitive ? 'i' : undefined)
      bag.value = (bag.value as string[]).filter((s) => !re.test(s))
    },
  },
  /**
   * List-aware (per-field): return the FIRST item from a list-source
   * value matching `pattern`, or `''` if none. Reduces the value from
   * `string[]` to `string`.
   *
   * args: { pattern: string, caseInsensitive?: boolean, default?: string }
   */
  findToken: {
    version: 1,
    argsSchema: z
      .object({
        pattern: z.string().min(1),
        caseInsensitive: z.boolean().optional(),
        default: z.string().optional(),
      })
      .strict(),
    impl: (args, ctx) => {
      const a = args as { pattern: string; caseInsensitive?: boolean; default?: string }
      const bag = bagOf(ctx)
      assertListBag(bag, 'findToken')
      const re = new RegExp(a.pattern, a.caseInsensitive ? 'i' : undefined)
      const hit = (bag.value as string[]).find((s) => re.test(s))
      bag.value = hit ?? a.default ?? ''
    },
  },
  /**
   * List-aware (per-field): join a list-source value with a string
   * separator. Reduces the value from `string[]` to `string`.
   *
   * args: { sep: string }
   */
  joinTokens: {
    version: 1,
    argsSchema: z.object({ sep: z.string() }).strict(),
    impl: (args, ctx) => {
      const a = args as { sep: string }
      const bag = bagOf(ctx)
      assertListBag(bag, 'joinTokens')
      bag.value = (bag.value as string[]).join(a.sep)
    },
  },
  /**
   * Per-field: strip a literal suffix off the current string value if it
   * ends with that suffix; otherwise pass the value through unchanged.
   * args: { suffix: string, caseInsensitive?: boolean }
   *
   * Use case: turn the pack-token text `10PK` (returned by `findToken`)
   * into the bare integer string `10` for `parseIntStrict`. Stays a
   * narrow scalar primitive — no regex DSL.
   */
  stripSuffix: {
    version: 1,
    argsSchema: z
      .object({ suffix: z.string().min(1), caseInsensitive: z.boolean().optional() })
      .strict(),
    impl: (args, ctx) => {
      const a = args as { suffix: string; caseInsensitive?: boolean }
      const bag = bagOf(ctx)
      const s = String(bag.value ?? '')
      if (s.length < a.suffix.length) {
        bag.value = s
        return
      }
      const tail = s.slice(-a.suffix.length)
      const match = a.caseInsensitive
        ? tail.toLowerCase() === a.suffix.toLowerCase()
        : tail === a.suffix
      bag.value = match ? s.slice(0, -a.suffix.length) : s
    },
  },
  /**
   * Per-field: remove literal substrings from the current string value
   * (each value removed wherever it occurs), in the order given.
   *
   * args: { values: string[] }
   *
   * Use case: Curaleaf's `.replace('Diamond Infused','').replace('Glass Tip Infused','')`
   * and `.replace('Essentials Briq ','')` cleanups. Deliberately literal
   * and ordered — does NOT become a regex replace DSL.
   */
  removeSubstrings: {
    version: 1,
    argsSchema: z
      .object({ values: z.array(z.string().min(1)).min(1) })
      .strict(),
    impl: (args, ctx) => {
      const a = args as { values: string[] }
      const bag = bagOf(ctx)
      let s = String(bag.value ?? '')
      for (const v of a.values) {
        s = s.split(v).join('')
      }
      bag.value = s
    },
  },
  /** Set a literal value on the output (escape hatch for derived constants). */
  setLiteral: {
    version: 1,
    argsSchema: z.object({ field: z.string().min(1), value: z.unknown() }).strict(),
    impl: (args, ctx) => {
      const a = args as { field: string; value: unknown }
      const out = ctx.output as Record<string, unknown>
      out[a.field] = a.value
    },
  },
}

// ---------------------------------------------------------------------

export const metrcV1Dialect: DialectPack<ParsedProductName> = {
  id: 'metrc-v1',
  version: 1,
  tokens,
  macros,
  transforms,
}
