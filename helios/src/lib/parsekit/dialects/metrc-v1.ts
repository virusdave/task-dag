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
  /** Integer or decimal, e.g. `1`, `1.0`, `0.5`. */
  decimal: { parser: aRegex(/^\d+(?:\.\d+)?/) as never },
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

const transforms: Record<string, TransformDef<ParsedProductName>> = {
  /** Trim whitespace + strip `(I|S|H)` suffix + apply NAME_ALIASES. */
  cleanCultivar: {
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const s = String(bag.value ?? '')
      const trimmed = s.trim().replace(/\s*\((?:I|S|H)\)\s*$/i, '')
      bag.value = NAME_ALIASES.get(trimmed) ?? trimmed
    },
  },
  /** Parse string → integer. */
  parseIntStrict: {
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      bag.value = Number.parseInt(String(bag.value), 10)
    },
  },
  /** Parse string → number, then format as `Xg`. */
  formatGrams: {
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const n = Number.parseFloat(String(bag.value))
      bag.value = formatGramsNumber(n)
    },
  },
  /** Format string as `Nmg` (the input is the milligram count as string). */
  formatMilligrams: {
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const n = Number.parseInt(String(bag.value), 10)
      bag.value = `${n}mg`
    },
  },
  /** Derive prevalence from `(I)|(S)|(H)` capture; output `'Indica'|'Sativa'|'Hybrid'|null`. */
  prevalenceFromParen: {
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
    argsSchema: z.object({ from: z.string().min(1), to: z.string().min(1) }).strict(),
    impl: (args, ctx) => {
      const a = args as { from: string; to: string }
      const out = ctx.output as Record<string, unknown>
      out[a.to] = out[a.from]
    },
  },
  /** Set a literal value on the output (escape hatch for derived constants). */
  setLiteral: {
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
