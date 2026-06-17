// Pure helpers for the SEO auto-blog SOURCE-INGESTION brick (P4) — id
// minting, the dedup fingerprint, and input normalization. No I/O, so these
// are exhaustively unit-tested and reused by the queries layer + routes.
//
// parent EPIC_PLAN §7.1 (source/topic intake) · child
// FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

import { createHash, randomBytes } from 'node:crypto'

// ── id minting ────────────────────────────────────────────────────────

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

function mintStructuredId(prefix: string, now: Date): string {
  const y = pad(now.getUTCFullYear(), 4)
  const mo = pad(now.getUTCMonth() + 1, 2)
  const d = pad(now.getUTCDate(), 2)
  const h = pad(now.getUTCHours(), 2)
  const mi = pad(now.getUTCMinutes(), 2)
  const s = pad(now.getUTCSeconds(), 2)
  const suffix = randomBytes(3).toString('hex')
  return `${prefix}_${y}-${mo}-${d}_${h}${mi}${s}_${suffix}`
}

export const SOURCE_ITEM_ID_RE =
  /^seosrc_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/

/** Mint a fresh, sortable source-item id `seosrc_YYYY-MM-DD_HHMMSS_<6hex>`. */
export function newSourceItemId(now: Date = new Date()): string {
  return mintStructuredId('seosrc', now)
}

// ── taxonomy ──────────────────────────────────────────────────────────

// The approved-source kinds (parent §7.1). DB-mirrored by the
// seo_source_allowlist_kind_check constraint.
export const SOURCE_KINDS = [
  'local_culture',
  'industry_news',
  'fb_news',
  'gsc_opportunity',
  'social_opportunity',
  'other',
] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

// The intake lifecycle of a source item. DB-mirrored by the
// seo_source_items_status_check constraint.
export const SOURCE_ITEM_STATUSES = [
  'new',
  'reviewed',
  'drafted',
  'dismissed',
] as const
export type SourceItemStatus = (typeof SOURCE_ITEM_STATUSES)[number]

// Lowercase kebab slug, 3-64 chars. Mirrors the DB
// seo_source_allowlist_source_key_check constraint so the app + DB agree on
// what a valid source_key is.
export const SOURCE_KEY_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/

/** True iff `key` is a structurally-valid source_key. */
export function isValidSourceKey(key: string): boolean {
  return SOURCE_KEY_RE.test(key)
}

// ── url normalization ─────────────────────────────────────────────────

/**
 * Normalize a source URL for dedup. Returns null for an empty/whitespace
 * url. When the string parses as an absolute URL we canonicalize the parts
 * that don't change identity — lowercase the protocol + host, drop the
 * fragment, and strip a lone trailing slash on the path — so trivially
 * different spellings of the same link dedup together. Unparseable input
 * falls back to a trimmed string (still deterministic) rather than throwing.
 */
export function normalizeSourceUrl(url: string | null | undefined): string | null {
  const trimmed = (url ?? '').trim()
  if (trimmed.length === 0) {
    return null
  }
  try {
    const parsed = new URL(trimmed)
    parsed.protocol = parsed.protocol.toLowerCase()
    parsed.hostname = parsed.hostname.toLowerCase()
    parsed.hash = ''
    // Strip a single trailing slash on a non-root path so
    // `…/post/` and `…/post` dedup together.
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1)
    }
    return parsed.toString()
  } catch {
    return trimmed
  }
}

/** Collapse internal whitespace + lowercase, for title-keyed dedup. */
function normalizeTitleKey(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

// ── tag / flag normalization ──────────────────────────────────────────

/**
 * Normalize a free-form tag/flag list: trim, lowercase, drop empties, and
 * dedup while preserving first-seen order. Shared by topic_tags + risk_flags
 * so both store a clean, stable set.
 */
export function normalizeTagList(tags: readonly string[] | null | undefined): string[] {
  if (!tags) {
    return []
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase()
    if (tag.length === 0 || seen.has(tag)) {
      continue
    }
    seen.add(tag)
    out.push(tag)
  }
  return out
}

// ── dedup fingerprint ─────────────────────────────────────────────────

export interface SourceItemDedupInput {
  readonly sourceKey: string
  readonly url: string | null | undefined
  readonly title: string
}

/**
 * The canonical, versioned payload a `dedup_hash` is computed over. Identity
 * is `(source_key, link)`:
 *
 *   - When a URL is present, the normalized URL alone keys the item, so a
 *     later title correction for the same link does NOT create a duplicate.
 *   - When there is no URL (internal announcement / GSC opportunity), the
 *     normalized title keys the item instead, so distinct title-only items
 *     from one source stay distinct.
 *
 * Built with an explicit, fixed field order so the hash is stable regardless
 * of object key order — mirrors the P3/P4 content_sha256 approach.
 */
export function sourceItemCanonicalPayload(input: SourceItemDedupInput): string {
  const normalizedUrl = normalizeSourceUrl(input.url)
  const canonical = {
    schema: 'freshlybaked.seo.source-item.v1',
    source_key: input.sourceKey,
    url: normalizedUrl,
    // Title only participates in identity when there is no URL to key on.
    title_key: normalizedUrl === null ? normalizeTitleKey(input.title) : null,
  }
  return JSON.stringify(canonical)
}

/** Hex sha256 over the canonical source-item identity payload. */
export function sourceItemDedupHash(input: SourceItemDedupInput): string {
  return createHash('sha256')
    .update(sourceItemCanonicalPayload(input), 'utf8')
    .digest('hex')
}

// ── ingest-input validation ───────────────────────────────────────────

export interface SourceItemProblem {
  readonly field: 'sourceKey' | 'title' | 'url' | 'status'
  readonly message: string
}

export interface SourceItemInput {
  readonly sourceKey: string
  readonly title: string
  readonly url?: string | null
}

/**
 * Validate the operator/API-supplied fields of a source item before ingest.
 * Structural only (it does NOT check the allowlist — that is the DB/queries
 * layer's fail-closed job). Returns the list of problems; empty = ok.
 */
export function validateSourceItemInput(input: SourceItemInput): SourceItemProblem[] {
  const problems: SourceItemProblem[] = []
  if (!isValidSourceKey(input.sourceKey.trim())) {
    problems.push({
      field: 'sourceKey',
      message: `source_key ${JSON.stringify(input.sourceKey)} is not a valid lowercase-kebab slug (3-64 chars).`,
    })
  }
  if (input.title.trim().length === 0) {
    problems.push({ field: 'title', message: 'Title is required.' })
  }
  return problems
}
