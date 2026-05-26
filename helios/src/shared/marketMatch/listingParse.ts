/**
 * Lifted/adapted LitAlerts listing-name parser used to extract
 * structured FuzzySku-shaped data out of a competitor matched
 * listing.
 *
 * This is a deliberately small, deterministic placeholder pending
 * the runtime-adjustable parser-config system (issue #19). It lives
 * in `shared/` so the same code is callable from the Phase-3
 * backfill worker AND from the Phase-4 lazy-parse-on-demand path in
 * the reviewer UI.
 */

export interface ParsedListing {
  brandNorm: string | null
  categoryNorm: string | null
  subcategoryNorm: string | null
  sizeGNorm: number | null
  sizeMgNorm: number | null
  packCountNorm: number | null
  strainNorm: string | null
}

interface SizeProfile {
  sizeGNorm: number | null
  sizeMgNorm: number | null
  packCountNorm: number | null
}

/**
 * Parse a LitAlerts matched-listing object (verbatim from
 * litalerts_competitor_observations.evidence_json.matchedListings[])
 * into a normalised FuzzySku-shape suitable for persisting in
 * fuzzy_skus.
 *
 * `searchTerm` is the observation's outer search term; we use it as
 * a strain hint when the listing name is uninformative (the search
 * term is typically `search term "<strain>"`).
 */
export function parseListingToFuzzy(
  listing: {
    listingName?: string | null
    category?: string | null
    subcategory?: string | null
    brand?: string | null
    dispensaryName?: string | null
  },
  searchTerm: string | null | undefined,
): ParsedListing {
  const text = listing.listingName ?? ''
  const sizeProfile = parseSizeProfile(text)
  return {
    brandNorm: listing.brand ? normalizeInlineText(listing.brand) : null,
    categoryNorm: listing.category ? normalizeInlineText(listing.category) : null,
    subcategoryNorm: listing.subcategory ? normalizeInlineText(listing.subcategory) : null,
    sizeGNorm: sizeProfile.sizeGNorm,
    sizeMgNorm: sizeProfile.sizeMgNorm,
    packCountNorm: sizeProfile.packCountNorm,
    strainNorm: extractStrainHint(text, searchTerm ?? null),
  }
}

export function parseSizeProfile(text: string): SizeProfile {
  const normalizedText = normalizeInlineText(text)
  const explicitMultipack = normalizedText.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(mg|g)\b/i)
  if (explicitMultipack && explicitMultipack[1] && explicitMultipack[2] && explicitMultipack[3]) {
    const packCount = Number.parseInt(explicitMultipack[1], 10)
    const unitValue = Number.parseFloat(explicitMultipack[2])
    const measure = explicitMultipack[3].toLowerCase() as 'g' | 'mg'
    const total = packCount * unitValue
    return {
      packCountNorm: packCount,
      sizeGNorm: measure === 'g' ? round4(total) : null,
      sizeMgNorm: measure === 'mg' ? round2(total) : null,
    }
  }

  const packCount = parsePackCount(normalizedText)
  const sizeValues = extractSizeValues(normalizedText)
  if (sizeValues.length === 0) {
    return { packCountNorm: packCount, sizeGNorm: null, sizeMgNorm: null }
  }
  const gramCount = sizeValues.filter((value) => value.measure === 'g').length
  const dominant = gramCount >= sizeValues.length - gramCount ? 'g' : 'mg'
  const matching = sizeValues.filter((value) => value.measure === dominant).map((value) => value.value)
  const sorted = matching.slice().sort((left, right) => left - right)
  const totalValue = sorted[sorted.length - 1]!
  return {
    packCountNorm: packCount,
    sizeGNorm: dominant === 'g' ? round4(totalValue) : null,
    sizeMgNorm: dominant === 'mg' ? round2(totalValue) : null,
  }
}

function extractSizeValues(text: string): Array<{ measure: 'g' | 'mg'; value: number }> {
  const matches = Array.from(text.matchAll(/(\d+(?:\.\d+)?)\s*(mg|g|oz|ounce|ounces)\b/gi))
  const out: Array<{ measure: 'g' | 'mg'; value: number }> = []
  for (const m of matches) {
    const v = Number.parseFloat(m[1]!)
    if (!Number.isFinite(v)) continue
    const u = m[2]!.toLowerCase()
    if (u === 'g' || u === 'mg') out.push({ measure: u, value: v })
    else out.push({ measure: 'g', value: v * 28.3495 })
  }
  return out
}

function parsePackCount(text: string): number {
  const m = text.match(/(\d+)\s*(?:pk|pack|packs)\b/i)
  if (m && m[1]) return Number.parseInt(m[1], 10)
  return 1
}

function normalizeInlineText(value: string | number | null | undefined): string {
  return String(value ?? '').split(/\s+/).filter((part) => part.length > 0).join(' ').trim()
}

function extractStrainHint(_listingText: string, searchTerm: string | null): string | null {
  if (!searchTerm) return null
  // Search terms have the shape: `search term "Pink Rozay"`
  const quoted = searchTerm.match(/"([^"]+)"/)
  if (quoted && quoted[1]) return normalizeInlineText(quoted[1])
  return null
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Deterministic SHA-256-style hash placeholder. We just need a
 * canonical-string hash for the (raw_input → fuzzy_sku) uniqueness
 * key; using the SubtleCrypto-equivalent in Node would require
 * shimming. This base64-style hash is collision-resistant enough
 * for the dedup purpose (a single observation typically has < 50
 * matched listings).
 */
export function hashRawInput(raw: unknown): string {
  const canonical = canonicalize(raw)
  // Simple FNV-1a 64-bit folded to hex. Stable + cheap, no Node
  // import; the uniqueness key includes parser_id+version too.
  let h1 = 0x811c9dc5
  let h2 = 0xdeadbeef
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x85ebca6b)
  }
  const toHex = (n: number) => (n >>> 0).toString(16).padStart(8, '0')
  return `${toHex(h1)}${toHex(h2)}`
}

/**
 * Map LitAlerts / Sweed / catalog category strings to a small
 * canonical set so a "Flower" catalog group never matches "Flowers"
 * or "Pre-Rolls" or "Accessories" LitAlerts rows just because of
 * spelling drift.
 *
 * Returns null when the input is null/empty (caller decides whether
 * a null category means "don't filter" or "hard reject"). Returns
 * the raw lowercased value when the input doesn't match a known
 * family — that way unknown categories still compare equal to
 * themselves and we don't silently widen the match surface.
 */
export function canonicalCategoryNorm(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const v = String(value).trim().toLowerCase().replace(/\s+/g, ' ')
  if (v.length === 0) return null
  // Drop punctuation so "pre-rolls" and "pre rolls" collapse.
  const stripped = v.replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (FLOWER_ALIASES.has(stripped)) return 'flower'
  if (PREROLL_ALIASES.has(stripped)) return 'preroll'
  if (CONCENTRATE_ALIASES.has(stripped)) return 'concentrate'
  if (VAPE_ALIASES.has(stripped)) return 'vape'
  if (EDIBLE_ALIASES.has(stripped)) return 'edible'
  if (TINCTURE_ALIASES.has(stripped)) return 'tincture'
  if (TOPICAL_ALIASES.has(stripped)) return 'topical'
  if (ACCESSORY_ALIASES.has(stripped)) return 'accessory'
  if (CLONE_ALIASES.has(stripped)) return 'clone'
  if (SEED_ALIASES.has(stripped)) return 'seed'
  // Unknown family — return a normalized form so two equivalent
  // unknowns still compare equal, but they still won't equal "flower".
  return stripped
}

const FLOWER_ALIASES = new Set(['flower', 'flowers', 'bud', 'buds'])
const PREROLL_ALIASES = new Set([
  'pre roll', 'pre rolls', 'preroll', 'prerolls',
  'pre rolled', 'prerolled', 'pre rolled joint', 'prerolled joint',
  'joints', 'joint',
])
const CONCENTRATE_ALIASES = new Set([
  'concentrate', 'concentrates', 'extract', 'extracts',
  'live resin', 'rosin', 'shatter', 'wax', 'badder', 'budder', 'sauce',
  'distillate', 'diamonds', 'hash',
])
const VAPE_ALIASES = new Set([
  'vape', 'vapes', 'vaporizer', 'vaporizers', 'cartridge', 'cartridges',
  'cart', 'carts', 'disposable', 'disposables', 'pod', 'pods', 'vape pen', 'vape pens',
])
const EDIBLE_ALIASES = new Set([
  'edible', 'edibles', 'gummy', 'gummies', 'chocolate', 'chocolates',
  'mint', 'mints', 'lozenge', 'lozenges', 'candy', 'candies',
  'baked good', 'baked goods', 'baked', 'beverage', 'beverages', 'drink', 'drinks',
])
const TINCTURE_ALIASES = new Set(['tincture', 'tinctures', 'sublingual', 'sublinguals'])
const TOPICAL_ALIASES = new Set(['topical', 'topicals', 'cream', 'creams', 'salve', 'salves', 'balm', 'balms'])
const ACCESSORY_ALIASES = new Set([
  'accessory', 'accessories', 'rolling paper', 'rolling papers', 'paper', 'papers',
  'lighter', 'lighters', 'grinder', 'grinders', 'pipe', 'pipes', 'bong', 'bongs',
  'apparel', 'merch', 'merchandise',
])
const CLONE_ALIASES = new Set(['clone', 'clones', 'cutting', 'cuttings'])
const SEED_ALIASES = new Set(['seed', 'seeds'])

/**
 * Tokens we never want to count as a "shared significant token"
 * between a catalog variant and a LitAlerts listing, because they
 * appear in almost every listing in the relevant category and would
 * cause "any Flower 3.5g" to match "any other Flower 3.5g". Brand
 * words are also stripped from BOTH sides up-front by the caller.
 */
const NAME_TOKEN_STOPWORDS = new Set([
  // grammatical / packaging fillers
  'the', 'and', 'or', 'with', 'a', 'an', 'of', 'for', 'by', 'in', 'on', 'at', 'to',
  'pack', 'packs', 'pk', 'count', 'ct', 'each',
  // size/measurement vocabulary
  'g', 'gram', 'grams', 'mg', 'milligram', 'milligrams', 'oz', 'ounce', 'ounces',
  'lb', 'lbs', 'pound', 'pounds', 'ml', 'milliliter', 'milliliters',
  // form / sku ceremony
  'pre', 'roll', 'rolls', 'rolled', 'joint', 'joints', 'flower', 'flowers',
  'cart', 'carts', 'cartridge', 'cartridges', 'vape', 'vapes', 'disposable',
  'gummy', 'gummies', 'edible', 'edibles', 'chocolate', 'chocolates',
  'concentrate', 'concentrates', 'extract', 'extracts',
  'tincture', 'tinctures', 'topical', 'topicals',
  // phenotype descriptors
  'indica', 'sativa', 'hybrid', 'cbd', 'thc', 'thca', 'cbn', 'cbg',
  // numbers + obvious noise
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  '10', '100', '200', '500', '1000',
  'mini', 'micro', 'large', 'small', 'xl', 'xs',
  'new', 'fresh', 'premium', 'select', 'reserve', 'collection',
])

/**
 * Extract the "significant" tokens from a piece of catalog or
 * listing text — the words a reviewer would actually look at to
 * tell whether two product names mean the same thing. Stripping
 * brand + category + size words is the caller's responsibility
 * (pass them via `brandText` / `categoryText` so we can subtract
 * them from the token set).
 *
 * Used by the Catalog → Market Data review path to enforce the
 * rule: "candidates must share at least one significant name
 * token with the catalog variant they're being matched against".
 * This is what stops "Dank by Definition 3.5g Flower XXX" from
 * matching "Dank by Definition 3.5g Flower YYY" when the strain
 * names share no characters.
 */
export function extractSignificantNameTokens(
  text: string | null | undefined,
  options: { brandText?: string | null; categoryText?: string | null } = {},
): Set<string> {
  if (!text) return new Set()
  const lowered = String(text).toLowerCase()
  const tokens = lowered
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !NAME_TOKEN_STOPWORDS.has(t))
  const brandTokens = new Set(
    (options.brandText ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length >= 3),
  )
  const categoryTokens = new Set(
    (options.categoryText ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length >= 3),
  )
  return new Set(tokens.filter((t) => !brandTokens.has(t) && !categoryTokens.has(t)))
}

/**
 * Are two size descriptors in the same "size family"? Used as a
 * hard gate so a 1g pre-roll never gets matched against a 3.5g
 * flower jar even when brand + category align. Tolerance is
 * additive (`epsilon`) OR multiplicative (`pct`), whichever is
 * larger — captures both the "3.5g jar" exact case and the
 * "100mg edible" exact case with one rule.
 */
export function sameSizeFamily(
  a: { sizeGNorm: number | null; sizeMgNorm: number | null },
  b: { sizeGNorm: number | null; sizeMgNorm: number | null },
  opts: { epsilonG?: number; epsilonMg?: number; pct?: number } = {},
): boolean {
  const epsG = opts.epsilonG ?? 0.05
  const epsMg = opts.epsilonMg ?? 5
  const pct = opts.pct ?? 0.08
  if (typeof a.sizeGNorm === 'number' && typeof b.sizeGNorm === 'number') {
    const tol = Math.max(epsG, Math.max(a.sizeGNorm, b.sizeGNorm) * pct)
    return Math.abs(a.sizeGNorm - b.sizeGNorm) <= tol
  }
  if (typeof a.sizeMgNorm === 'number' && typeof b.sizeMgNorm === 'number') {
    const tol = Math.max(epsMg, Math.max(a.sizeMgNorm, b.sizeMgNorm) * pct)
    return Math.abs(a.sizeMgNorm - b.sizeMgNorm) <= tol
  }
  // Different measurement units (g vs mg) is never the same family.
  if (
    typeof a.sizeGNorm === 'number'
    && typeof b.sizeMgNorm === 'number'
  ) return false
  if (
    typeof a.sizeMgNorm === 'number'
    && typeof b.sizeGNorm === 'number'
  ) return false
  // Both sides missing size: do not block (the caller can decide via
  // a separate "require both sides to have a size" rule).
  return true
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(',')}}`
}
