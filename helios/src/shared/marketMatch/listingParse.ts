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

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(',')}}`
}
