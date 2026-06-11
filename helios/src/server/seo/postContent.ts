// Pure helpers for the auto-blog control plane (P4) — post content
// fingerprinting, id minting, the sanitized-host compliance heuristic, and
// the Article/BlogPosting JSON-LD builder. No I/O, so these are
// exhaustively unit-tested and reused by the route, the queries layer, and
// the DB→bundle loader.
//
// This is the direct analog of faqContent.ts (P3): the IRONCLAD
// human-approval gate (canon §1) binds an approval to the EXACT content
// fingerprint, any edit recomputes it and resets the row to draft, and the
// sanitized host (FB.us) can never be left without compliant content.
//
// parent EPIC_PLAN §6.2/§6.3/§7 · child FreshlyBakedNYC/automation#44 (P4) ·
// Satisfies: virusdave/top-level#15

import { createHash, randomBytes } from 'node:crypto'

import { RAW_ONLY_TERMS } from './faqContent.js'
import { isValidSlug } from './routeRegistry.js'

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

export const POST_ID_RE = /^post_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/

/** Mint a fresh, sortable post id `post_YYYY-MM-DD_HHMMSS_<6hex>`. */
export function newPostId(now: Date = new Date()): string {
  return mintStructuredId('post', now)
}

// ── content fingerprint ───────────────────────────────────────────────

/**
 * The operator-authored, publicly-visible content of a blog post. The
 * `title` / `meta_description` / `excerpt` / `tags` are SHARED across hosts
 * (one value rendered on both), so only the body carries a raw (FB.nyc) +
 * sanitized (FB.us) variant pair. `author` is a visible byline.
 */
export interface PostContentInput {
  readonly post_id: string
  readonly scope: string
  readonly slug: string
  readonly title: string
  readonly meta_description: string
  readonly excerpt: string
  readonly author: string
  readonly tags: readonly string[]
  readonly body_raw: string
  readonly body_sanitized: string
  readonly hero_image_sha256?: string | null
  readonly og_image_sha256?: string | null
  readonly noindex?: boolean
}

/**
 * Canonical, versioned payload a `content_sha256` is computed over. It
 * includes the full PUBLIC identity (`post_id` + `scope` + `slug`) and
 * every operator-authored, publicly-visible field, and EXCLUDES everything
 * non-public or assigned at approval/publish time: status, source,
 * generation metadata, timestamps (`published_at`/`updated_at`), the
 * reviewer (that IS the approver), the derived `canonical_url`, user ids,
 * and the `approval_id` itself. Built with an explicit fixed field order
 * so the hash is stable regardless of JSONB key ordering.
 */
export function postCanonicalPayload(input: PostContentInput): string {
  const canonical = {
    schema: 'freshlybaked.seo.post-approval.v1',
    content_kind: 'post',
    post_id: input.post_id,
    scope: input.scope,
    slug: input.slug,
    title: input.title,
    meta_description: input.meta_description,
    excerpt: input.excerpt,
    author: input.author,
    tags: [...input.tags],
    body_raw: input.body_raw,
    body_sanitized: input.body_sanitized,
    hero_image_sha256: input.hero_image_sha256 ?? null,
    og_image_sha256: input.og_image_sha256 ?? null,
    noindex: input.noindex === true,
  }
  return JSON.stringify(canonical)
}

/** Hex sha256 over the canonical post payload. */
export function postContentSha256(input: PostContentInput): string {
  return createHash('sha256').update(postCanonicalPayload(input), 'utf8').digest('hex')
}

// ── sanitized-host compliance heuristic ───────────────────────────────
//
// Reuses the conservative raw-only cannabis-term denylist from
// faqContent.ts (`RAW_ONLY_TERMS`). The slug renders in the URL on BOTH
// hosts, the shared title/meta/excerpt/tags render on both hosts, and the
// sanitized body renders on FB.us — so ALL of those must be free of
// raw-only terms. Only `body_raw` may carry raw cannabis copy.

function findRawOnlyLeaksLower(lower: string): string[] {
  const hits = new Set<string>()
  for (const term of RAW_ONLY_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i')
    if (re.test(lower)) {
      hits.add(term)
    }
  }
  return [...hits]
}

/** Distinct raw-only terms in `text` (case-insensitive, whole-token). */
export function findPostRawOnlyLeaks(text: string): string[] {
  return findRawOnlyLeaksLower(text.toLowerCase())
}

export type PostField =
  | 'slug'
  | 'title'
  | 'meta_description'
  | 'excerpt'
  | 'author'
  | 'tags'
  | 'body_raw'
  | 'body_sanitized'

export interface PostComplianceProblem {
  readonly field: PostField
  readonly message: string
}

/**
 * Validate a post for APPROVAL. Checks structural completeness (required
 * fields non-empty, slug well-formed) and the sanitized-host compliance
 * heuristic (no raw-only terms in the slug, shared title/meta/excerpt/tags,
 * or the sanitized body; and a sanitized body byte-identical to a raw body
 * that carries raw terms means no sanitizing happened). Returns the list of
 * problems; empty = approvable.
 */
export function checkPostApprovable(input: PostContentInput): PostComplianceProblem[] {
  const problems: PostComplianceProblem[] = []
  const slug = input.slug?.trim() ?? ''
  const title = input.title?.trim() ?? ''
  const metaDescription = input.meta_description?.trim() ?? ''
  const excerpt = input.excerpt?.trim() ?? ''
  const author = input.author?.trim() ?? ''
  const bodyRaw = input.body_raw?.trim() ?? ''
  const bodySanitized = input.body_sanitized?.trim() ?? ''

  if (slug.length === 0) {
    problems.push({ field: 'slug', message: 'Slug is empty.' })
  } else if (!isValidSlug(slug)) {
    problems.push({ field: 'slug', message: `Slug '${slug}' must be lowercase kebab-case.` })
  }
  if (title.length === 0) problems.push({ field: 'title', message: 'Title is empty.' })
  if (metaDescription.length === 0) {
    problems.push({ field: 'meta_description', message: 'Meta description is empty.' })
  }
  if (excerpt.length === 0) problems.push({ field: 'excerpt', message: 'Excerpt is empty.' })
  if (author.length === 0) problems.push({ field: 'author', message: 'Author is empty.' })
  if (bodyRaw.length === 0) problems.push({ field: 'body_raw', message: 'Raw body is empty.' })
  if (bodySanitized.length === 0) {
    problems.push({ field: 'body_sanitized', message: 'Sanitized body is empty.' })
  }

  // Shared, on-both-hosts fields must be sanitized-safe.
  const sharedChecks: Array<{ field: PostField; text: string }> = [
    { field: 'slug', text: slug.replace(/-/g, ' ') },
    { field: 'title', text: title },
    { field: 'meta_description', text: metaDescription },
    { field: 'excerpt', text: excerpt },
    { field: 'tags', text: input.tags.join(' ') },
    { field: 'body_sanitized', text: bodySanitized },
  ]
  for (const { field, text } of sharedChecks) {
    const leaks = findPostRawOnlyLeaks(text)
    if (leaks.length > 0) {
      problems.push({
        field,
        message: `Contains raw-only term(s) that would leak onto the sanitized host: ${leaks.join(', ')}.`,
      })
    }
  }

  // A sanitized body identical to a raw body carrying raw terms means no
  // sanitizing actually happened.
  if (
    bodySanitized.length > 0 &&
    bodyRaw === bodySanitized &&
    findPostRawOnlyLeaks(bodyRaw).length > 0
  ) {
    problems.push({
      field: 'body_sanitized',
      message:
        'Sanitized body is identical to a raw body that contains raw-only terms (no sanitizing applied).',
    })
  }

  return problems
}

// ── Article/BlogPosting JSON-LD (shared, no-cloaking) ─────────────────
//
// The renderer (mss, separate child epic) emits a BlogPosting JSON-LD
// block whose `articleBody` EXACTLY matches the visible body for the
// host's mode. This builder is the single source of truth so the Helios
// preview can never drift from what the renderer would emit.

export type SeoMode = 'raw' | 'sanitized'

/** The body actually shown for a host mode. */
export function visiblePostBody(input: PostContentInput, mode: SeoMode): string {
  return mode === 'raw' ? input.body_raw : input.body_sanitized
}

export interface PostJsonLdMeta {
  readonly canonical_url: string
  readonly published_at: string
  readonly updated_at?: string
}

export function buildBlogPostJsonLd(
  input: PostContentInput,
  meta: PostJsonLdMeta,
  mode: SeoMode,
): Record<string, unknown> {
  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: input.title,
    description: input.meta_description,
    articleBody: visiblePostBody(input, mode),
    datePublished: meta.published_at,
    mainEntityOfPage: { '@type': 'WebPage', '@id': meta.canonical_url },
    author: { '@type': 'Organization', name: input.author },
    keywords: [...input.tags],
  }
  if (meta.updated_at) {
    jsonLd.dateModified = meta.updated_at
  }
  return jsonLd
}
