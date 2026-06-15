// Pre-review governance checks for the SEO FAQ control plane (#46 P5).
//
// Where the FBUS leak detector (`faqContent.ts`) and the ads-policy lint
// (`adsPolicy.ts`) are the two COMPLIANCE gates (raw cannabis / .nyc leak
// onto the sanitized host; Google-Ads-forbidden claim kinds), THIS module
// is the QUALITY/governance layer that runs BEFORE a human reviews a draft
// FAQ set. It catches the structural and editorial problems that an LLM
// draft (P5 family generation) or a bad import most commonly introduces:
//
//   • item-count cap            — a runaway generation produced too many Q&As
//   • question / answer length  — an answer is bloated past the page budget
//   • forbidden-term scan       — DRAFT artifacts leaked through: unfilled
//                                 template markers (`{{ }}`, `[insert …]`),
//                                 LLM refusal/meta phrasing ("as an AI …"),
//                                 or placeholder copy ("lorem ipsum", "TODO")
//   • duplicate-question        — two items ask the same thing
//   • near-duplicate-answer     — two answers are ~the same text (Jaccard
//                                 over token shingles), i.e. redundant Q&As
//
// It is deliberately distinct from the compliance gates and does NOT
// re-scan for cannabis/ads terms — those have their own gates with their
// own fail-closed semantics. Governance is advisory-but-blocking review
// signal: it surfaces problems for the approver / the review page so a
// human never has to eyeball a 200-item set for a duplicated answer.
//
// Pure (no I/O), so it is exhaustively unit-tested and reused by the route,
// the governance review page (P5), and the approval gate.
//
// parent EPIC_PLAN §5/§7 · child FreshlyBakedNYC/automation#46 ·
// Satisfies: virusdave/top-level#17 · Phase: P5

import type { FaqItemInput } from './faqContent.js'

// ── policy ────────────────────────────────────────────────────────────

export interface FaqGovernancePolicy {
  /** Max FAQ items in a set; over this is a runaway-generation signal. */
  readonly maxItems: number
  /** Max characters in the shared question. */
  readonly maxQuestionChars: number
  /** Max characters in either answer variant. */
  readonly maxAnswerChars: number
  /**
   * Forbidden DRAFT-artifact phrases (case-insensitive, whole-token /
   * phrase match; internal spaces also match hyphens). NOT compliance
   * terms — those live in `faqContent.ts` / `adsPolicy.ts`.
   */
  readonly forbiddenTerms: readonly string[]
  /**
   * Forbidden literal substrings (case-insensitive, matched anywhere —
   * NOT token-bounded), for template markers that are not whole words,
   * e.g. `{{`, `[insert`.
   */
  readonly forbiddenMarkers: readonly string[]
  /**
   * Jaccard-similarity threshold in (0, 1] at or above which two answers
   * count as near-duplicates.
   */
  readonly nearDuplicateThreshold: number
  /** Token shingle (k-gram) size for the near-duplicate comparison. */
  readonly shingleSize: number
}

/**
 * Default governance policy. Thresholds are conservative (high-signal,
 * low false-positive) so the check blocks obvious problems without
 * second-guessing legitimate editorial choices; tune per call site.
 */
export const DEFAULT_FAQ_GOVERNANCE_POLICY: FaqGovernancePolicy = {
  maxItems: 50,
  maxQuestionChars: 200,
  maxAnswerChars: 1200,
  forbiddenTerms: [
    'lorem ipsum',
    'todo',
    'tbd',
    'fixme',
    'placeholder',
    'as an ai',
    'as a language model',
    'as an ai language model',
    'i cannot provide',
    'i can not provide',
    "i'm sorry, but",
    'i am sorry, but',
    'i am unable to',
  ],
  forbiddenMarkers: ['{{', '}}', '[insert', '<insert', '[placeholder', '[todo'],
  // Bigram shingles + a 0.7 Jaccard floor: sensitive enough to catch a
  // paraphrase-or-copy-with-tiny-edit in the short answers a FAQ carries,
  // strict enough that two genuinely distinct answers stay well below it.
  nearDuplicateThreshold: 0.7,
  shingleSize: 2,
}

// ── text-similarity primitives (pure, reusable, tested) ───────────────

/**
 * Normalize `text` for comparison: lowercase, drop everything that is not
 * an alphanumeric or whitespace, and collapse runs of whitespace to a
 * single space. So "What's the price?" and "what's the PRICE" both
 * normalize to "whats the price".
 */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    // Drop apostrophes first so contractions stay a single token
    // ("what's" -> "whats", not "what s").
    .replace(/['\u2018\u2019]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whitespace-split tokens of the normalized form of `text`. */
export function tokenize(text: string): string[] {
  const normalized = normalizeForCompare(text)
  return normalized.length === 0 ? [] : normalized.split(' ')
}

/**
 * The set of contiguous `size`-token shingles (k-grams) of `tokens`.
 * Falls back to the set of individual tokens when there are fewer tokens
 * than `size`, so short answers still compare meaningfully. Empty input
 * yields an empty set. `size` is clamped to at least 1.
 */
export function shingles(tokens: readonly string[], size: number): Set<string> {
  const k = Math.max(1, Math.floor(size))
  const out = new Set<string>()
  if (tokens.length === 0) {
    return out
  }
  if (tokens.length < k) {
    for (const tok of tokens) {
      out.add(tok)
    }
    return out
  }
  for (let i = 0; i + k <= tokens.length; i++) {
    out.add(tokens.slice(i, i + k).join(' '))
  }
  return out
}

/**
 * Jaccard similarity |A∩B| / |A∪B| of two sets, in [0, 1]. Two empty sets
 * are defined as similarity 0 (no shared content to be "duplicate" over).
 */
export function jaccardSimilarity<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) {
    return 0
  }
  let intersection = 0
  // Iterate the smaller set for fewer lookups.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const x of small) {
    if (large.has(x)) {
      intersection++
    }
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Near-duplicate similarity of two answer texts: Jaccard over their
 * `shingleSize`-token shingles, in [0, 1].
 */
export function answerSimilarity(a: string, b: string, shingleSize: number): number {
  return jaccardSimilarity(
    shingles(tokenize(a), shingleSize),
    shingles(tokenize(b), shingleSize),
  )
}

// ── forbidden-term matching ───────────────────────────────────────────

/**
 * Build a case-insensitive regex for a forbidden phrase: each run of
 * whitespace becomes `[\s-]+` (a space also matches a hyphen) and the
 * whole phrase is bounded by non-alphanumerics so a single word matches a
 * whole token only ("tbd" does not match "tbds"). Mirrors the matcher in
 * `adsPolicy.ts`.
 */
function phraseToRegex(phrase: string): RegExp {
  const tokens = normalizeForCompare(phrase)
    .split(' ')
    .filter((t) => t.length > 0)
    .map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const body = tokens.length === 0 ? '(?!)' : tokens.join('[\\s-]+')
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i')
}

// ── problems ──────────────────────────────────────────────────────────

export type FaqGovernanceCategory =
  | 'item_count'
  | 'question_length'
  | 'answer_length'
  | 'forbidden_term'
  | 'duplicate_question'
  | 'near_duplicate_answer'

export type FaqGovernanceField = 'question' | 'answer_raw' | 'answer_sanitized'

export interface FaqGovernanceProblem {
  readonly category: FaqGovernanceCategory
  /** The offending item index, or -1 for a set-level problem (item_count). */
  readonly itemIndex: number
  /** For duplicate/near-duplicate, the EARLIER item the offender matches. */
  readonly relatedItemIndex?: number
  /** Which field the problem is about, when field-scoped. */
  readonly field?: FaqGovernanceField
  /** Human-readable explanation for the reviewer / a CI assertion. */
  readonly message: string
}

const ANSWER_FIELDS: readonly Extract<FaqGovernanceField, 'answer_raw' | 'answer_sanitized'>[] =
  ['answer_raw', 'answer_sanitized']
const ALL_FIELDS: readonly FaqGovernanceField[] = ['question', 'answer_raw', 'answer_sanitized']

/**
 * Run all pre-review governance checks over `items`. Returns a flat,
 * deterministic list of problems (set-level first, then per item in order,
 * then cross-item duplicate/near-duplicate checks); empty = clean.
 *
 * Checks performed:
 *  - item-count cap            (`item_count`, itemIndex -1)
 *  - question / answer length  (`question_length` / `answer_length`)
 *  - forbidden draft terms     (`forbidden_term`, per field)
 *  - duplicate question        (`duplicate_question`, normalized-equal)
 *  - near-duplicate answer     (`near_duplicate_answer`, Jaccard ≥ threshold)
 */
export function checkFaqSetGovernance(
  items: readonly FaqItemInput[],
  policy: FaqGovernancePolicy = DEFAULT_FAQ_GOVERNANCE_POLICY,
): FaqGovernanceProblem[] {
  const problems: FaqGovernanceProblem[] = []

  // ── set-level: item-count cap ──
  if (items.length > policy.maxItems) {
    problems.push({
      category: 'item_count',
      itemIndex: -1,
      message: `FAQ set has ${items.length} items, over the cap of ${policy.maxItems}.`,
    })
  }

  // Compile the forbidden-term matchers once per call.
  const compiledTerms = policy.forbiddenTerms.map((phrase) => ({
    phrase,
    re: phraseToRegex(phrase),
  }))
  const lowerMarkers = policy.forbiddenMarkers.map((m) => m.toLowerCase())

  // ── per-item: length + forbidden-term scans ──
  items.forEach((item, itemIndex) => {
    const question = item.question ?? ''
    if (question.length > policy.maxQuestionChars) {
      problems.push({
        category: 'question_length',
        itemIndex,
        field: 'question',
        message: `Question is ${question.length} chars, over the cap of ${policy.maxQuestionChars}.`,
      })
    }
    for (const field of ANSWER_FIELDS) {
      const answer = item[field] ?? ''
      if (answer.length > policy.maxAnswerChars) {
        problems.push({
          category: 'answer_length',
          itemIndex,
          field,
          message: `${field} is ${answer.length} chars, over the cap of ${policy.maxAnswerChars}.`,
        })
      }
    }

    for (const field of ALL_FIELDS) {
      const text = item[field] ?? ''
      if (text.length === 0) {
        continue
      }
      // Markers are literal substrings (e.g. `{{`, `[insert`) that DON'T
      // survive normalization, so they match against the raw lowercased text.
      const lower = text.toLowerCase()
      for (const marker of lowerMarkers) {
        if (marker.length > 0 && lower.includes(marker)) {
          problems.push({
            category: 'forbidden_term',
            itemIndex,
            field,
            message: `${field} contains forbidden draft marker ${JSON.stringify(marker)}.`,
          })
        }
      }
      // Phrase terms are compiled from their NORMALIZED form (apostrophes
      // dropped, punctuation → space), so they must be tested against the
      // normalized text too — otherwise "i'm sorry, but" never matches the
      // raw "I'm sorry, but ...".
      const normalized = normalizeForCompare(text)
      for (const { phrase, re } of compiledTerms) {
        if (re.test(normalized)) {
          problems.push({
            category: 'forbidden_term',
            itemIndex,
            field,
            message: `${field} contains forbidden draft term ${JSON.stringify(phrase)}.`,
          })
        }
      }
    }
  })

  // ── cross-item: duplicate question (normalized-equal) ──
  const firstByNormalizedQuestion = new Map<string, number>()
  items.forEach((item, itemIndex) => {
    const normalized = normalizeForCompare(item.question ?? '')
    if (normalized.length === 0) {
      return
    }
    const firstIndex = firstByNormalizedQuestion.get(normalized)
    if (firstIndex === undefined) {
      firstByNormalizedQuestion.set(normalized, itemIndex)
    } else {
      problems.push({
        category: 'duplicate_question',
        itemIndex,
        relatedItemIndex: firstIndex,
        field: 'question',
        message: `Question duplicates item ${firstIndex}.`,
      })
    }
  })

  // ── cross-item: near-duplicate answer (Jaccard over shingles) ──
  // Precompute each item's shingle set per answer field once, then compare
  // pairwise within the same field. The pass is O(n²); since `item_count`
  // already blocks an over-cap set, bound the comparison to `maxItems + 1`
  // items so a runaway import of thousands can't make this quadratic blow up.
  const simCount = Math.min(items.length, policy.maxItems + 1)
  for (const field of ANSWER_FIELDS) {
    const shingleSets = items
      .slice(0, simCount)
      .map((item) => shingles(tokenize(item[field] ?? ''), policy.shingleSize))
    for (let j = 1; j < simCount; j++) {
      const setJ = shingleSets[j]!
      if (setJ.size === 0) {
        continue
      }
      let bestIndex = -1
      let bestSim = 0
      for (let i = 0; i < j; i++) {
        const sim = jaccardSimilarity(shingleSets[i]!, setJ)
        if (sim > bestSim) {
          bestSim = sim
          bestIndex = i
        }
      }
      if (bestIndex >= 0 && bestSim >= policy.nearDuplicateThreshold) {
        problems.push({
          category: 'near_duplicate_answer',
          itemIndex: j,
          relatedItemIndex: bestIndex,
          field,
          message: `${field} is ${(bestSim * 100).toFixed(0)}% similar to item ${bestIndex} (near-duplicate).`,
        })
      }
    }
  }

  return problems
}

/** True iff `items` has any governance problem under `policy`. */
export function hasFaqGovernanceProblem(
  items: readonly FaqItemInput[],
  policy: FaqGovernancePolicy = DEFAULT_FAQ_GOVERNANCE_POLICY,
): boolean {
  return checkFaqSetGovernance(items, policy).length > 0
}

/**
 * Human-readable markers (`<category>@item<n>[~item<m>]: <message>`) for a
 * FAQ set under `policy`, suitable for an approval-rejection message or a
 * CI assertion. Empty array = clean.
 */
export function describeFaqGovernanceProblems(
  items: readonly FaqItemInput[],
  policy: FaqGovernancePolicy = DEFAULT_FAQ_GOVERNANCE_POLICY,
): string[] {
  return checkFaqSetGovernance(items, policy).map((p) => {
    const where =
      p.itemIndex < 0
        ? 'set'
        : `item${p.itemIndex}${p.relatedItemIndex !== undefined ? `~item${p.relatedItemIndex}` : ''}`
    return `${p.category}@${where}: ${p.message}`
  })
}
