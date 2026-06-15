// Pure helpers for the FAQ control plane (P3) — content fingerprinting,
// id minting, and the sanitized-host compliance heuristic. No I/O, so
// these are exhaustively unit-tested and reused by the route, the queries
// layer, and the DB→bundle loader.
//
// parent EPIC_PLAN §6.1/§7 · child FreshlyBakedNYC/automation#44 (P3) ·
// Satisfies: virusdave/top-level#15

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

export const FAQ_SET_ID_RE = /^faqset_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/
export const SEO_APPROVAL_ID_RE = /^seoapr_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/

/** Mint a fresh, sortable FAQ-set id `faqset_YYYY-MM-DD_HHMMSS_<6hex>`. */
export function newFaqSetId(now: Date = new Date()): string {
  return mintStructuredId('faqset', now)
}

/** Mint a fresh, sortable approval id `seoapr_YYYY-MM-DD_HHMMSS_<6hex>`. */
export function newSeoApprovalId(now: Date = new Date()): string {
  return mintStructuredId('seoapr', now)
}

// ── content fingerprint ───────────────────────────────────────────────

/** A single FAQ item (mirrors contracts.ts FaqItemSchema). */
export interface FaqItemInput {
  readonly question: string
  readonly answer_raw: string
  readonly answer_sanitized: string
}

export interface FaqSetContentInput {
  readonly faq_set_id: string
  readonly scope: string
  readonly items: readonly FaqItemInput[]
}

/**
 * The canonical, versioned payload that a `content_sha256` is computed
 * over. It deliberately includes the full PUBLIC identity of the content
 * (`faq_set_id` + `scope`) and BOTH variants of every item, and excludes
 * everything non-public (status, source, generation metadata, timestamps,
 * user ids, the approval_id itself). Built with an explicit, fixed field
 * order so the hash is stable regardless of how the row's JSONB happened
 * to order its keys.
 */
export function faqSetCanonicalPayload(input: FaqSetContentInput): string {
  const canonical = {
    schema: 'freshlybaked.seo.faq-approval.v1',
    content_kind: 'faq_set',
    faq_set_id: input.faq_set_id,
    scope: input.scope,
    items: input.items.map((item) => ({
      question: item.question,
      answer_raw: item.answer_raw,
      answer_sanitized: item.answer_sanitized,
    })),
  }
  return JSON.stringify(canonical)
}

/** Hex sha256 over the canonical FAQ-set payload. */
export function faqSetContentSha256(input: FaqSetContentInput): string {
  return createHash('sha256').update(faqSetCanonicalPayload(input), 'utf8').digest('hex')
}

// ── sanitized-host compliance heuristic ───────────────────────────────
//
// FB.us is the SANITIZED host: raw cannabis copy must never leak onto it.
// The frozen FaqItemSchema carries one SHARED `question` (no raw/sanitized
// variant) plus a variant pair of answers, so BOTH the shared question and
// the sanitized answer must be free of raw-only cannabis terms.
//
// This is a deliberately conservative, transparent denylist of unambiguous
// cannabis terms — NOT a full compliance engine. A human approver still
// reads every word; this only blocks the highest-risk accidental leaks
// (e.g. the generator or an editor pasting raw copy into the sanitized
// column). False-positive risk is kept low by excluding ambiguous everyday
// words ("high", "joint", "flower", "strain") and matching whole tokens
// only.

export const RAW_ONLY_TERMS: readonly string[] = [
  'cannabis',
  'marijuana',
  'thc',
  'cbd',
  'weed',
  'dispensary',
  'indica',
  'sativa',
  'preroll',
  'pre-roll',
  'vape',
  'vaping',
  'edible',
  'edibles',
  'gummy',
  'gummies',
  'kush',
  'blunt',
  'dab',
  'dabs',
  'cannabinoid',
  'cannabinoids',
  'tetrahydrocannabinol',
]

/**
 * Match each whole-token term in `terms` against already-lowercased
 * `lower`, returning the distinct terms found. A term matches only when
 * bounded by non-alphanumerics (so "thc" does not match "ethical" and
 * "dab" does not match "database"); hyphenated terms like "pre-roll" are
 * matched verbatim. Shared by the host-agnostic raw-only check and the
 * stricter FBUS check below so both use identical token semantics.
 */
function matchWholeTokenTerms(lower: string, terms: readonly string[]): string[] {
  const hits = new Set<string>()
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i')
    if (re.test(lower)) {
      hits.add(term)
    }
  }
  return [...hits]
}

/**
 * Return the distinct raw-only terms found in `text` (case-insensitive,
 * whole-token match). Empty array = clean.
 */
export function findRawOnlyLeaks(text: string): string[] {
  return matchWholeTokenTerms(text.toLowerCase(), RAW_ONLY_TERMS)
}

// ── FBUS (.us) STRICTER sanitized-host denylist ───────────────────────
//
// `freshlybaked.us` (FBUS) is the SEO-sanitized public host. The binding
// constraint (parent EPIC_PLAN §5–§6, this child epic #46) is HARDER than
// the host-agnostic `RAW_ONLY_TERMS` above: FBUS content must carry
//   1. ZERO cannabis META-terms — including the everyday-ambiguous words
//      (`flower(s)`, `strain(s)`, …) the host-agnostic list deliberately
//      tolerates, and
//   2. ZERO leak of the sibling `.nyc` brand — no `*.nyc` URL / host and
//      no "Freshly Baked NYC" brand phrase, anywhere.
//
// `FBUS_EXTRA_DENY_TERMS` are the meta-terms added ON TOP of
// `RAW_ONLY_TERMS` for the `.us` host. Kept deliberately conservative and
// transparent (a human approver still reads every word; this only blocks
// the highest-risk accidental leaks): it adds the §5-named ambiguous
// terms plus close cannabis-meta synonyms, and intentionally still
// excludes generic everyday words that would false-positive heavily in a
// retail FAQ ("high", "joint", "pot", "green", "grass", "bar"). Tune here
// if the operator wants an even stricter rule.
//
// Satisfies: virusdave/top-level#17 · Phase: P1

export const FBUS_EXTRA_DENY_TERMS: readonly string[] = [
  'flower',
  'flowers',
  'strain',
  'strains',
  'bud',
  'buds',
  'nug',
  'nugs',
  'hemp',
  'thca',
  'cbn',
  'cbg',
  'terpene',
  'terpenes',
  'tincture',
  'tinctures',
  'cartridge',
  'cartridges',
  'flwr',
  // Common `pre-roll` lexical variants beyond the singular forms already
  // in RAW_ONLY_TERMS (high-signal, near-zero retail-FAQ false positives).
  'prerolls',
  'pre-rolls',
  'pre roll',
  'pre rolls',
]

/** The full, stricter `.us` meta-term denylist (raw-only ∪ FBUS-extra). */
export const FBUS_DENY_TERMS: readonly string[] = [...RAW_ONLY_TERMS, ...FBUS_EXTRA_DENY_TERMS]

// Distinct categories of FBUS leak, so callers/approvers can tell a
// cannabis-meta leak apart from a sibling-brand leak.
export interface FbusLeaks {
  /** Cannabis raw-only / meta-terms (whole-token, case-insensitive). */
  readonly terms: string[]
  /** Distinct `.nyc` hosts referenced (e.g. `freshlybaked.nyc`). */
  readonly nycHosts: string[]
  /** True iff the "Freshly Baked NYC" brand phrase appears. */
  readonly nycBrandPhrase: boolean
}

// A `<label>.nyc` host/URL token (bounded so "concierge.nycdata" or a bare
// "nyc" word do not match — only a real `*.nyc` host does). Captures the
// host so the approver sees exactly what leaked.
const NYC_HOST_RE = /(?<![a-z0-9.])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+nyc)(?![a-z0-9])/gi
// The sibling brand phrase, tolerant of arbitrary inter-word whitespace.
const NYC_BRAND_PHRASE_RE = /freshly\s+baked\s+nyc/i

/**
 * Detect every category of forbidden FBUS leak in `text`. A result is
 * "clean for `.us`" iff `terms` is empty, `nycHosts` is empty, and
 * `nycBrandPhrase` is false (see {@link hasFbusLeak}).
 */
export function findFbusLeaks(text: string): FbusLeaks {
  const lower = text.toLowerCase()
  const terms = matchWholeTokenTerms(lower, FBUS_DENY_TERMS)

  const nycHosts = new Set<string>()
  for (const match of text.matchAll(NYC_HOST_RE)) {
    nycHosts.add(match[1]!.toLowerCase())
  }

  return {
    terms,
    nycHosts: [...nycHosts],
    nycBrandPhrase: NYC_BRAND_PHRASE_RE.test(text),
  }
}

/** True iff `text` contains any FBUS-forbidden term, `.nyc` host, or brand phrase. */
export function hasFbusLeak(text: string): boolean {
  const leaks = findFbusLeaks(text)
  return leaks.terms.length > 0 || leaks.nycHosts.length > 0 || leaks.nycBrandPhrase
}

/**
 * Human-readable leak markers for `text` under the FBUS rule, suitable for
 * surfacing in an approval-rejection message or a CI assertion. Empty
 * array = clean for `.us`.
 */
export function describeFbusLeaks(text: string): string[] {
  const leaks = findFbusLeaks(text)
  const markers: string[] = [...leaks.terms]
  for (const host of leaks.nycHosts) {
    markers.push(`.nyc-url:${host}`)
  }
  if (leaks.nycBrandPhrase) {
    markers.push('nyc-brand-phrase')
  }
  return markers
}

export interface FaqComplianceProblem {
  readonly itemIndex: number
  readonly field: 'question' | 'answer_sanitized' | 'answer_raw'
  readonly message: string
}

// NOTE: `findFbusLeaks` / `hasFbusLeak` / `describeFbusLeaks` above are the
// FBUS-strict (`.us`) primitives. `checkFaqSetApprovable` below remains the
// existing host-agnostic / raw-only approval check — it does NOT yet apply
// the stricter FBUS rule. Route-level enforcement of the FBUS denylist is
// deferred until the FBUS source-key model lands (child #46 P1, CI gate 2),
// which is what tells the approver which sets are FBUS-scoped.

/**
 * Validate a FAQ set for APPROVAL. Checks structural completeness (every
 * item has a non-empty question + both answer variants) and the
 * sanitized-host compliance heuristic (no raw-only terms in the shared
 * question or the sanitized answer; and a raw answer that is byte-identical
 * to its sanitized variant while containing raw terms means no sanitizing
 * actually happened). Returns the list of problems; empty = approvable.
 */
export function checkFaqSetApprovable(items: readonly FaqItemInput[]): FaqComplianceProblem[] {
  const problems: FaqComplianceProblem[] = []
  if (items.length === 0) {
    problems.push({ itemIndex: -1, field: 'question', message: 'FAQ set has no items.' })
    return problems
  }
  items.forEach((item, itemIndex) => {
    const question = item.question?.trim() ?? ''
    const answerRaw = item.answer_raw?.trim() ?? ''
    const answerSanitized = item.answer_sanitized?.trim() ?? ''

    if (question.length === 0) {
      problems.push({ itemIndex, field: 'question', message: 'Question is empty.' })
    }
    if (answerRaw.length === 0) {
      problems.push({ itemIndex, field: 'answer_raw', message: 'Raw answer is empty.' })
    }
    if (answerSanitized.length === 0) {
      problems.push({
        itemIndex,
        field: 'answer_sanitized',
        message: 'Sanitized answer is empty.',
      })
    }

    // The shared question renders on BOTH hosts → must be sanitized-safe.
    const questionLeaks = findRawOnlyLeaks(question)
    if (questionLeaks.length > 0) {
      problems.push({
        itemIndex,
        field: 'question',
        message: `Question contains raw-only term(s) that would leak onto the sanitized host: ${questionLeaks.join(', ')}.`,
      })
    }

    const sanitizedLeaks = findRawOnlyLeaks(answerSanitized)
    if (sanitizedLeaks.length > 0) {
      problems.push({
        itemIndex,
        field: 'answer_sanitized',
        message: `Sanitized answer contains raw-only term(s): ${sanitizedLeaks.join(', ')}.`,
      })
    }

    // If the raw answer carries raw-only terms but the sanitized answer is
    // a byte-for-byte copy of it, no sanitizing happened — reject.
    if (
      answerSanitized.length > 0 &&
      answerRaw === answerSanitized &&
      findRawOnlyLeaks(answerRaw).length > 0
    ) {
      problems.push({
        itemIndex,
        field: 'answer_sanitized',
        message:
          'Sanitized answer is identical to a raw answer that contains raw-only terms (no sanitizing applied).',
      })
    }
  })
  return problems
}

// ── FAQPage JSON-LD preview (shared, no-cloaking) ─────────────────────
//
// The renderer (mss, separate child epic) emits a FAQPage JSON-LD block
// whose answers EXACTLY match the visible answers for the host's mode.
// This builder is the single source of truth so the Helios preview can
// never drift from what the renderer would emit (the test asserts the
// JSON-LD answer === the visible answer for the chosen mode).

export type SeoMode = 'raw' | 'sanitized'

export function visibleFaqAnswer(item: FaqItemInput, mode: SeoMode): string {
  return mode === 'raw' ? item.answer_raw : item.answer_sanitized
}

export function buildFaqPageJsonLd(
  items: readonly FaqItemInput[],
  mode: SeoMode,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: visibleFaqAnswer(item, mode),
      },
    })),
  }
}
