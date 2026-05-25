/**
 * LitAlerts v1 dialect pack for parsing competitor matched listings
 * into FuzzyVariantDescriptor (see contracts/litalerts.ts).
 *
 * Scope per docs/helios/litalerts-parsing/EPIC_PLAN.md § L1: enough
 * tokens + transforms to express the heuristics currently embedded in
 * `helios/src/shared/marketMatch/listingParse.ts` as runtime-tweakable
 * tenant-authored parser configs, while keeping the dialect API small
 * (~no DSL-y regex-replace transforms).
 *
 * Token impls are raw arcsecond parsers — see the equivalent note in
 * `dialects/metrc-v1.ts`: the "no regex primitive in tenant configs"
 * rule applies to tenant-authored configs, not to dialect-internal
 * token impls. Tenant rules build their parser AST out of these
 * named tokens, never out of raw regex.
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
import type { FuzzyVariantDescriptor } from '../contracts/litalerts.js'

// ---------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------

const tokens: Record<string, TokenDef> = {
  /** Optional whitespace. */
  optWs: { parser: aOptWs as never },
  /** Required whitespace. */
  ws: { parser: aRegex(/^\s+/) as never },
  /** `\s*-\s*` */
  dash: { parser: aRegex(/^\s*-\s*/) as never },
  /** `\s*\|\s*` (a few NY competitors use `|` between fields). */
  pipe: { parser: aRegex(/^\s*\|\s*/) as never },
  /** Bare integer. */
  int: { parser: aRegex(/^\d+/) as never },
  /** Integer or decimal: `1`, `1.0`, `.5`. */
  decimal: { parser: aRegex(/^\.?\d+(?:\.\d+)?/) as never },
  /** Grams suffix: `g`. */
  gramsSuffix: { parser: aRegex(/^g\b/i) as never },
  /** Milligrams suffix: `mg`. */
  milligramsSuffix: { parser: aRegex(/^mg\b/i) as never },
  /** Ounce suffix: `oz` / `ounce(s)`. */
  ounceSuffix: { parser: aRegex(/^(?:oz|ounces?)\b/i) as never },
  /** Pack suffix: `pk` / `pack` / `packs`. */
  packSuffix: { parser: aRegex(/^(?:pk|packs?)\b/i) as never },
  /** Joined size token like `3.5g` / `100mg` / `1g`. Captures the
   *  whole substring; the projection layer feeds it through
   *  `parseSize` to split value+unit. */
  sizeToken: { parser: aRegex(/^\.?\d+(?:\.\d+)?\s*(?:mg|g|oz|ounces?)\b/i) as never },
  /** Explicit-multipack token like `3x100mg` / `10 x 1g`. */
  multipackToken: { parser: aRegex(/^\d+\s*x\s*\d+(?:\.\d+)?\s*(?:mg|g)\b/i) as never },
  /** Pack-of-N token like `10pk` / `10 pack`. */
  packToken: { parser: aRegex(/^\d+\s*(?:pk|packs?)\b/i) as never },
  /** Prevalence indicator in parens: `(I)`, `(S)`, `(H)`. */
  prevalenceParen: { parser: aRegex(/^\([ISH]\)/i) as never },
  /** Bracketed strain: `[Pink Rozay]`. */
  bracketedText: { parser: aRegex(/^\[[^\]]+\]/) as never },
  /** Double-quoted strain: `"Pink Rozay"`. */
  quotedText: { parser: aRegex(/^"[^"]+"/) as never },
  /** Word: contiguous run of non-whitespace, non-dash, non-pipe. */
  word: { parser: aRegex(/^[^\s\-|]+/) as never },
  /** Run-of-text up to next `-` or `|` (non-empty). */
  runUntilSep: { parser: aRegex(/^[^\-|]+/) as never },
}

// ---------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------

const macros: Record<string, MacroDef> = {}

// ---------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------

function bagOf(ctx: TransformContext<unknown>): { value: unknown } {
  return ctx.output as unknown as { value: unknown }
}

const CATEGORY_MAP: Record<string, FuzzyVariantDescriptor['category']> = {
  flower: 'flower',
  bud: 'flower',
  herb: 'flower',
  preroll: 'preroll',
  prerolls: 'preroll',
  'pre-roll': 'preroll',
  'pre-rolls': 'preroll',
  joint: 'preroll',
  joints: 'preroll',
  vape: 'vape',
  vapes: 'vape',
  cart: 'vape',
  carts: 'vape',
  cartridge: 'vape',
  vaporizer: 'vape',
  edible: 'edible',
  edibles: 'edible',
  gummy: 'edible',
  gummies: 'edible',
  chocolate: 'edible',
  chocolates: 'edible',
  concentrate: 'concentrate',
  concentrates: 'concentrate',
  hash: 'concentrate',
  rosin: 'concentrate',
  resin: 'concentrate',
  diamond: 'concentrate',
  diamonds: 'concentrate',
  badder: 'concentrate',
  budder: 'concentrate',
  shatter: 'concentrate',
  wax: 'concentrate',
  tincture: 'tincture',
  tinctures: 'tincture',
  topical: 'topical',
  topicals: 'topical',
  beverage: 'beverage',
  beverages: 'beverage',
  drink: 'beverage',
  drinks: 'beverage',
  accessory: 'accessory',
  accessories: 'accessory',
}

const PREVALENCE_MAP: Record<string, FuzzyVariantDescriptor['prevalence']> = {
  live: 'live',
  cured: 'cured',
  rosin: 'rosin',
  distillate: 'distillate',
  distill: 'distillate',
  dist: 'distillate',
}

const transforms: Record<string, TransformDef<FuzzyVariantDescriptor>> = {
  /** Trim + collapse internal whitespace. */
  cleanText: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const s = String(bag.value ?? '')
      bag.value = s.split(/\s+/).filter((p) => p.length > 0).join(' ').trim()
    },
  },

  /** Lowercase the current value. */
  lowercase: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      bag.value = String(bag.value ?? '').toLowerCase()
    },
  },

  /** Parse a string number into a JS number. */
  parseDecimal: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const n = Number.parseFloat(String(bag.value ?? ''))
      bag.value = Number.isFinite(n) ? n : 0
    },
  },

  /** Parse a string of digits into an int. */
  parseIntStrict: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const s = String(bag.value ?? '').trim()
      if (!/^\d+$/.test(s)) {
        throw new Error(`parseIntStrict: value '${s}' is not a pure integer string`)
      }
      bag.value = Number.parseInt(s, 10)
    },
  },

  /**
   * Parse a joined size token like `3.5g` / `100mg` / `1oz` into
   * `{ value, unit }` matching the FuzzyVariantSize* schema. Ounces
   * are normalised to grams (1 oz = 28.3495 g).
   */
  parseSize: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const raw = String(bag.value ?? '').trim()
      const m = /^(\.?\d+(?:\.\d+)?)\s*(mg|g|oz|ounces?)$/i.exec(raw)
      if (!m) {
        throw new Error(`parseSize: cannot parse '${raw}'`)
      }
      const n = Number.parseFloat(m[1]!)
      const u = m[2]!.toLowerCase()
      if (u === 'mg') bag.value = { value: round2(n), unit: 'mg' }
      else if (u === 'g') bag.value = { value: round4(n), unit: 'g' }
      else bag.value = { value: round4(n * 28.3495), unit: 'g' }
    },
  },

  /**
   * Parse an explicit-multipack token like `3x100mg` into
   * `{ packCount, unit: {value, unit}, total: {value, unit} }`. The
   * projection layer then copies the relevant subfields into
   * `packCount`, `unitSize`, and `totalSize`.
   */
  parseMultipack: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const raw = String(bag.value ?? '').trim()
      const m = /^(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(mg|g)$/i.exec(raw)
      if (!m) {
        throw new Error(`parseMultipack: cannot parse '${raw}'`)
      }
      const pack = Number.parseInt(m[1]!, 10)
      const unit = Number.parseFloat(m[2]!)
      const u = m[3]!.toLowerCase() as 'mg' | 'g'
      const round = u === 'mg' ? round2 : round4
      bag.value = {
        packCount: pack,
        unitSize: { value: round(unit), unit: u },
        totalSize: { value: round(unit * pack), unit: u },
      }
    },
  },

  /** Parse `10pk` / `10pack` → integer. */
  parsePackToken: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const m = /^(\d+)/.exec(String(bag.value ?? '').trim())
      bag.value = m ? Number.parseInt(m[1]!, 10) : 1
    },
  },

  /**
   * Map a raw category/subcategory string token (any case) into the
   * normalised FuzzyVariantCategory enum. Falls back to `'other'`
   * when no entry matches — the contract's `semanticValidate` will
   * flag `category === 'other' && variantName === null` rows.
   */
  mapCategory: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const key = String(bag.value ?? '').trim().toLowerCase()
      bag.value = CATEGORY_MAP[key] ?? 'other'
    },
  },

  /** Map a raw prevalence token to the enum, or null. */
  mapPrevalence: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const key = String(bag.value ?? '').trim().toLowerCase()
      bag.value = PREVALENCE_MAP[key] ?? null
    },
  },

  /**
   * Generic per-field table lookup (mirrors `metrc-v1.mapValue` so
   * tenants can author brand-alias tables).
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
      // sparse-table passthrough
    },
  },

  /** Strip enclosing brackets or quotes off `[Pink Rozay]` / `"Pink Rozay"`. */
  stripDelimiters: {
    version: 1,
    impl: (_args, ctx) => {
      const bag = bagOf(ctx)
      const s = String(bag.value ?? '').trim()
      if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('"') && s.endsWith('"'))) {
        bag.value = s.slice(1, -1).trim()
      } else {
        bag.value = s
      }
    },
  },

  /**
   * Rule-level: copy `unitSize` into `totalSize` (single-unit packs).
   * Use after `parseSize` projects into `unitSize` when the listing has
   * no multipack token.
   */
  defaultTotalSizeFromUnit: {
    version: 1,
    impl: (_args, ctx) => {
      const out = ctx.output as Record<string, unknown>
      const u = out['unitSize'] as { value: number; unit: string } | undefined
      if (u && (out['totalSize'] === undefined || out['totalSize'] === null)) {
        out['totalSize'] = { value: u.value, unit: u.unit }
      }
    },
  },

  /**
   * Rule-level: if `unitSize` is unset but `totalSize` + `packCount`
   * are, compute `unitSize = totalSize / packCount` keeping the same
   * unit.
   */
  unitSizeFromTotalAndPack: {
    version: 1,
    impl: (_args, ctx) => {
      const out = ctx.output as Record<string, unknown>
      const t = out['totalSize'] as { value: number; unit: string } | undefined
      const pack = Number(out['packCount'] ?? 1)
      if (t && pack > 0 && (out['unitSize'] === undefined || out['unitSize'] === null)) {
        const u = t.unit === 'mg' ? round2 : round4
        out['unitSize'] = { value: u(t.value / pack), unit: t.unit }
      }
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

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

// ---------------------------------------------------------------------

export const litalertsV1Dialect: DialectPack<FuzzyVariantDescriptor> = {
  id: 'litalerts-v1',
  version: 1,
  tokens,
  macros,
  transforms,
}
