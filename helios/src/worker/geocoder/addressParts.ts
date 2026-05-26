/**
 * Address normalization helpers for the shared `addresses` table
 * introduced by issue #25 (sweed-address-enrichment epic).
 *
 * `normaliseAddressParts` is the single source of truth for how a
 * raw address tuple (line1 / line2 / city / state / zip) collapses
 * into a one-line dedup key that the `addresses.normalized` unique
 * index enforces. Both the delivery-enrichment (#25 A4) and the
 * customer-of-record enrichment (#25 A5) producers MUST go through
 * this helper so that the same physical address is not stored under
 * multiple distinct rows because two callers spelled it differently.
 *
 * The normalization rules are intentionally conservative:
 *   - Lower-case everything.
 *   - Collapse all runs of internal whitespace to a single space.
 *   - Strip bare punctuation we don't trust to be semantic
 *     (commas, periods, semicolons, parens). Apostrophes, ampersands,
 *     hyphens, slashes and `#` (unit markers) are preserved.
 *   - Trim leading / trailing whitespace from every component.
 *   - Drop empty components from the joined normalized form so
 *     `{line1, city, state, zip}` and `{line1, "", city, state, zip}`
 *     hash to the same key.
 *
 * The "raw" output fields preserve casing exactly as supplied by
 * Sweed (only trimmed) so the geocoder + future map view can show
 * the address back to the operator in its original form. The
 * `normalized` field is what feeds the unique index.
 */

/** Input as supplied by Sweed (or any other producer). */
export interface RawAddressInput {
  line1?: string | null
  line2?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
}

/** Output: `raw*` are the (trimmed) original values; `normalized`
 *  is the dedup key. */
export interface NormalizedAddressParts {
  rawLine1: string | null
  rawLine2: string | null
  rawCity: string | null
  rawState: string | null
  rawZip: string | null
  /** Lower-cased, single-spaced, comma/period-stripped one-liner.
   *  Empty string when every component is blank — callers should
   *  treat that as "no address". */
  normalized: string
}

/** Punctuation we strip wholesale from the normalized form.
 *  Apostrophe, ampersand, hyphen, slash and `#` are intentionally
 *  kept because they often carry meaning (e.g. "O'Brien St",
 *  "5th & Main", "Apt #4B"). */
const PUNCTUATION_TO_STRIP = /[.,;:()"]+/g
const RUN_OF_WHITESPACE = /\s+/g

function trimOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizePiece(value: string | null): string {
  if (value === null) {
    return ''
  }
  return value
    .toLowerCase()
    .replace(PUNCTUATION_TO_STRIP, ' ')
    .replace(RUN_OF_WHITESPACE, ' ')
    .trim()
}

export function normaliseAddressParts(input: RawAddressInput): NormalizedAddressParts {
  const rawLine1 = trimOrNull(input.line1)
  const rawLine2 = trimOrNull(input.line2)
  const rawCity = trimOrNull(input.city)
  const rawState = trimOrNull(input.state)
  const rawZip = trimOrNull(input.zip)

  // Zip normalization for the dedup key: collapse to the 5-digit
  // prefix. A partial (< 5 digit) input is dropped from the
  // normalized form entirely — `11201` and `11201-1234` are the
  // same physical address, but `SW1A 1AA` (UK) has no useful 5-digit
  // prefix and including the first two digits there would only
  // create noise. The raw field always preserves the input
  // verbatim so a later geocoder pass can still see it.
  const zipDigits = rawZip === null ? '' : rawZip.replace(/\D/g, '').slice(0, 5)
  const normalizedZip = zipDigits.length === 5 ? zipDigits : ''

  const parts = [
    normalizePiece(rawLine1),
    normalizePiece(rawLine2),
    normalizePiece(rawCity),
    normalizePiece(rawState),
    normalizedZip,
  ].filter((piece) => piece.length > 0)

  const normalized = parts.join(' ').replace(RUN_OF_WHITESPACE, ' ').trim()

  return { rawLine1, rawLine2, rawCity, rawState, rawZip, normalized }
}
