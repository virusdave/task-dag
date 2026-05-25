/**
 * Centralized validators for Google Ads CSV output.
 *
 * EVERY code path that emits Google Ads CSV rows MUST run its
 * headlines/descriptions/sitelinks through these sanitizers, and
 * EVERY code path that emits RSAs must consult the per-ad-group cap.
 *
 * Background — the operator has burned thousands of dollars on
 * "obvious mistakes" CSVs that should never have been written. These
 * are the standing rules (operator dictated, 2026-05-25):
 *
 *   • Headlines  ≤ 30 chars (Google hard limit).
 *   • Descriptions ≤ 90 chars (Google hard limit), and NEVER contain
 *     a URL (Google disapproves).
 *   • No "bizarre" punctuation. Specifically: trailing "?.", "!.",
 *     "!?", "??", "!!" or any other back-to-back terminal
 *     punctuation. A single "." or "?" or "!" at end is fine; the
 *     ellipsis "..." is fine; ".." is NOT (Google disapproves).
 *   • A responsive search ad must have ≥3 valid headlines and
 *     ≥2 valid descriptions AFTER sanitization, or it gets dropped
 *     entirely — Google rejects ads with fewer than that.
 *   • An ad group may carry AT MOST 3 responsive search ads total
 *     (existing in snapshot + newly emitted). Anything past that is
 *     Google's hard limit and Editor will reject the import.
 *   • Sitelinks MUST have a non-empty Final URL.
 *   • Sitelink Final URLs MUST point at the public landing-page site
 *     (freshlybaked.us). They must NEVER point at the internal
 *     freshlybaked.nyc surface — sending paid traffic to .nyc is
 *     "landing pages 101" anti-pattern that the operator has had to
 *     undo manually multiple times.
 *
 * Public API:
 *   sanitizeHeadlines(input)   → string[]    (≤30 chars, no URL, OK punct)
 *   sanitizeDescriptions(input)→ string[]    (≤90 chars, no URL, OK punct)
 *   validateSitelinkRow(row)   → { ok, reasons }
 *   RsaCapTracker              → cross-batch ≤3 RSAs/ad-group accountant
 */

export const MAX_HEADLINE_LEN = 30
export const MAX_DESCRIPTION_LEN = 90
export const RSA_MIN_HEADLINES = 3
export const RSA_MIN_DESCRIPTIONS = 2
export const RSA_MAX_PER_AD_GROUP = 3

// Hosts that sitelinks must NEVER point at. The "nyc" host is the
// internal/admin face; paid ad traffic must go to the marketing site.
const BANNED_SITELINK_HOSTS = new Set([
  'freshlybaked.nyc',
  'www.freshlybaked.nyc',
  'staging.freshlybaked.nyc',
])

// Matches anything that looks like a URL or a bare domain in
// free-form ad copy. Used to reject URLs in descriptions / headlines.
const URLISH_REGEX =
  /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|nyc|us|io|co|app)(?:\/\S*)?\b/i

// Bad punctuation patterns Google disapproves on:
//   ?.  !.  ?!  !?  ??  !!  ..  (but allow ... ellipsis exactly)
//   Any other 2+ back-to-back terminal-punctuation chars.
const BAD_PUNCT_PATTERNS: RegExp[] = [
  /[?!][.?!]/,                 // ?., ?!, !!, !., !?, ??
  /(?<!\.)\.{2}(?!\.)/,        // exactly ".." (but allow "...")
  /\.{4,}/,                    // .... or longer
  /[?!]{2,}/,                  // ??, !!, !??, etc.
]

function hasBadPunctuation(s: string): boolean {
  for (const re of BAD_PUNCT_PATTERNS) {
    if (re.test(s)) return true
  }
  return false
}

function containsUrl(s: string): boolean {
  return URLISH_REGEX.test(s)
}

/**
 * Attempt to repair common bad-punctuation patterns BEFORE rejecting.
 * Replaces "?.", "!.", "!?", "??", "!!" with the cleaner terminator;
 * collapses ".." → "." (preserves "..." ellipsis).
 *
 * If the result still has banned punctuation, the caller should drop.
 */
function repairPunctuation(s: string): string {
  let out = s
  // Preserve ellipsis: temporarily mark it
  out = out.replace(/\.{3}/g, '\u0001')
  // Collapse 4+ dots to ellipsis
  out = out.replace(/\.{4,}/g, '\u0001')
  // Collapse runs of 2+ dots to a single dot
  out = out.replace(/\.{2,}/g, '.')
  // Collapse 2+ "?" or "!" to a single one (?? → ?, !! → !)
  out = out.replace(/\?{2,}/g, '?')
  out = out.replace(/!{2,}/g, '!')
  // Mixed terminal punctuation: prefer the first character (so "?." → "?", "!." → "!", "!?" → "!")
  out = out.replace(/([?!])[.?!]+/g, '$1')
  // Restore ellipsis
  out = out.replace(/\u0001/g, '...')
  // Trim trailing whitespace before terminal punct
  out = out.replace(/\s+([.?!])/g, '$1').trimEnd()
  return out
}

export interface SanitizeReport {
  kept: string[]
  dropped: { value: string; reason: string }[]
}

/**
 * Canonical key for "is this headline/description the same one we
 * already kept?" — purposely more aggressive than `toLowerCase()` so
 * we never trip Google's "All headlines must be different" rejection
 * via near-duplicates that only differ in trailing punctuation,
 * whitespace, smart quotes, or zero-width characters.
 *
 * Google's exact comparator isn't public, so we intentionally bias
 * toward false-positive dedup: better to drop a near-duplicate than
 * to ship a CSV that bounces because two headlines were "too
 * similar" by Google's policy check.
 *
 * Normalizations applied:
 *   - NFKC unicode normalize (collapses smart quotes, etc.)
 *   - strip zero-width chars
 *   - lowercase (locale 'en-US')
 *   - trim + collapse internal whitespace
 *   - drop ALL punctuation and symbols
 *   - drop ALL whitespace (so "best weed nyc" and "bestweednyc"
 *     collide too — operator-intent identical)
 */
export function googleAdTextDedupeKey(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLocaleLowerCase('en-US')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, '')
}

/**
 * Clean a list of candidate headlines, dropping ones that can't be
 * salvaged. Output preserves input order. Caller should treat
 * `dropped` entries as warnings and check `kept.length` against
 * RSA_MIN_HEADLINES before emitting an RSA row.
 */
export function sanitizeHeadlinesReport(input: unknown[]): SanitizeReport {
  const kept: string[] = []
  const dropped: { value: string; reason: string }[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string') {
      dropped.push({ value: String(raw), reason: 'not a string' })
      continue
    }
    let s = raw.trim()
    if (s.length === 0) {
      // silently skip empties — they're just unfilled slots, not a real "drop"
      continue
    }
    if (containsUrl(s)) {
      dropped.push({ value: s, reason: 'headline contains a URL/domain' })
      continue
    }
    s = repairPunctuation(s)
    if (hasBadPunctuation(s)) {
      dropped.push({ value: raw, reason: 'unfixable bad punctuation' })
      continue
    }
    if (s.length > MAX_HEADLINE_LEN) {
      dropped.push({
        value: s,
        reason: `headline >${MAX_HEADLINE_LEN} chars (${s.length})`,
      })
      continue
    }
    const key = googleAdTextDedupeKey(s)
    if (key.length === 0) continue
    if (seen.has(key)) {
      dropped.push({
        value: s,
        reason:
          'duplicate headline after Google-style normalization — Google rejects RSAs with identical headlines',
      })
      continue
    }
    seen.add(key)
    kept.push(s)
  }
  return { kept, dropped }
}

export function sanitizeHeadlines(input: unknown[]): string[] {
  return sanitizeHeadlinesReport(input).kept
}

export function sanitizeDescriptionsReport(input: unknown[]): SanitizeReport {
  const kept: string[] = []
  const dropped: { value: string; reason: string }[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string') {
      dropped.push({ value: String(raw), reason: 'not a string' })
      continue
    }
    let s = raw.trim()
    if (s.length === 0) continue
    if (containsUrl(s)) {
      dropped.push({ value: s, reason: 'description contains a URL/domain' })
      continue
    }
    s = repairPunctuation(s)
    if (hasBadPunctuation(s)) {
      dropped.push({ value: raw, reason: 'unfixable bad punctuation' })
      continue
    }
    if (s.length > MAX_DESCRIPTION_LEN) {
      dropped.push({
        value: s,
        reason: `description >${MAX_DESCRIPTION_LEN} chars (${s.length})`,
      })
      continue
    }
    const key = googleAdTextDedupeKey(s)
    if (key.length === 0) continue
    if (seen.has(key)) {
      dropped.push({
        value: s,
        reason:
          'duplicate description after Google-style normalization',
      })
      continue
    }
    seen.add(key)
    kept.push(s)
  }
  return { kept, dropped }
}

export function sanitizeDescriptions(input: unknown[]): string[] {
  return sanitizeDescriptionsReport(input).kept
}

export interface SitelinkRowLike {
  /** "Sitelink text" column. */
  text?: string
  /** "Final URL" column. */
  finalUrl?: string
}

/**
 * Validate one sitelink row. Returns { ok, reasons[] }; if reasons
 * is non-empty the row MUST be dropped (don't emit a half-valid
 * sitelink — Google will reject the whole extension).
 */
export function validateSitelinkRow(row: SitelinkRowLike): {
  ok: boolean
  reasons: string[]
} {
  const reasons: string[] = []
  const text = (row.text ?? '').trim()
  const url = (row.finalUrl ?? '').trim()
  if (!text) reasons.push('sitelink missing visible text')
  if (!url) reasons.push('sitelink missing Final URL')
  if (url) {
    try {
      const parsed = new URL(url)
      const host = parsed.host.toLowerCase()
      if (BANNED_SITELINK_HOSTS.has(host)) {
        reasons.push(
          `sitelink Final URL points at internal host "${host}" — sitelinks must go to the public landing-page site (freshlybaked.us)`,
        )
      }
    } catch {
      reasons.push(`sitelink Final URL is not a valid URL: ${url}`)
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * Per-ad-group RSA cap tracker. Seed with how many RSAs each
 * (campaign, ad_group) ALREADY has live in the account (from the
 * snapshot), then call `tryReserve()` before emitting each new RSA
 * row. Returns false (and records a message) if the cap is hit.
 */
export class RsaCapTracker {
  private counts = new Map<string, number>()

  /**
   * Seed from snapshot ads so we count existing live RSAs.
   *
   * IMPORTANT: Google's "≤3 RSAs per ad group" limit is on ENABLED
   * RSAs only. Paused / removed RSAs do not consume capacity, so
   * counting them would falsely block legitimate new emissions.
   */
  seedFromSnapshot(
    ads: Iterable<{
      campaign_name?: string
      ad_group_name?: string
      ad_type?: string
      ad_status?: string
    }>,
  ): void {
    for (const ad of ads) {
      if ((ad.ad_type ?? '').trim().toLowerCase() !== 'responsive_search_ad') continue
      if ((ad.ad_status ?? '').trim().toLowerCase() !== 'enabled') continue
      const key = this.keyOf(ad.campaign_name, ad.ad_group_name)
      if (!key) continue
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
    }
  }

  /**
   * Returns true if a new RSA in this (campaign, ad_group) is still
   * under the cap; the counter is then incremented. Returns false
   * with a reason if the cap is already reached.
   */
  tryReserve(
    campaign: string,
    adGroup: string,
  ): { ok: true } | { ok: false; reason: string } {
    const key = this.keyOf(campaign, adGroup)
    if (!key) return { ok: false, reason: 'missing campaign or ad group' }
    const current = this.counts.get(key) ?? 0
    if (current >= RSA_MAX_PER_AD_GROUP) {
      return {
        ok: false,
        reason: `ad group "${adGroup}" already has ${current} enabled RSAs (max ${RSA_MAX_PER_AD_GROUP}); skipping new RSA`,
      }
    }
    this.counts.set(key, current + 1)
    return { ok: true }
  }

  /**
   * Free one slot back to the cap. Use this when the bundle ALSO
   * emits a pause row for an enabled RSA in the same group (the
   * canonical case: a `replace` action retires the source ad and
   * creates a new one — net change in enabled count is 0).
   *
   * Floors at 0 so a buggy double-release can't make capacity
   * temporarily appear larger than 3.
   */
  release(campaign: string, adGroup: string): void {
    const key = this.keyOf(campaign, adGroup)
    if (!key) return
    const current = this.counts.get(key) ?? 0
    if (current <= 0) return
    this.counts.set(key, current - 1)
  }

  private keyOf(campaign?: string, adGroup?: string): string | null {
    const c = (campaign ?? '').trim()
    const g = (adGroup ?? '').trim()
    if (!c || !g) return null
    return `${c}\u001f${g}`
  }
}
