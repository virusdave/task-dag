// Word-level "sanitization diff" for the FAQ review page (#46 P5).
//
// Shows a reviewer exactly what changed between an item's raw (FB.nyc)
// answer and its sanitized (FB.us) answer: which words were removed from
// the raw copy and which were added in the sanitized copy. This is the
// core FBUS review question ("did sanitizing correctly remove the raw
// cannabis / sibling-brand copy?"), so it is a raw -> sanitized diff, NOT
// a revision/history diff.
//
// Pure and dependency-free: a standard word-token longest-common-
// subsequence (LCS) over whitespace-split tokens, emitting equal / removed
// / added segments in reading order.
//
// task dce1a56 (P5) · child FreshlyBakedNYC/automation#46

export type DiffSegmentKind = 'equal' | 'removed' | 'added'

export interface DiffSegment {
  readonly kind: DiffSegmentKind
  /** The contiguous run of text (tokens rejoined with single spaces). */
  readonly text: string
}

// Split on whitespace, keeping non-empty tokens. Punctuation stays attached
// to its word, which is fine for a reviewer-facing visual diff (we are not
// re-tokenizing for NLP, just showing what moved).
function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0)
}

/**
 * Compute a word-level diff from `raw` to `sanitized`. Returns segments in
 * reading order; adjacent same-kind tokens are coalesced into one segment
 * so the UI renders runs, not one span per word.
 *
 * `equal`   — text present in both (unchanged by sanitizing).
 * `removed` — text in `raw` but not `sanitized` (stripped out).
 * `added`   — text in `sanitized` but not `raw` (substituted in).
 */
// Cap on the O(n*m) LCS table. FAQ answers are short (governance warns past
// ~1200 chars), so any realistic pair is well under this; the cap only
// guards against a pathological import freezing the reviewer's browser, in
// which case we fall back to a coarse "all removed, then all added" diff.
const MAX_LCS_CELLS = 250_000

export function sanitizationDiff(raw: string, sanitized: string): DiffSegment[] {
  const a = tokenize(raw)
  const b = tokenize(sanitized)

  // LCS length table over tokens. dp[i][j] = LCS length of a[i:] and b[j:].
  const n = a.length
  const m = b.length

  if (n * m > MAX_LCS_CELLS) {
    const coarse: DiffSegment[] = []
    if (n > 0) {
      coarse.push({ kind: 'removed', text: a.join(' ') })
    }
    if (m > 0) {
      coarse.push({ kind: 'added', text: b.join(' ') })
    }
    return coarse
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  // Walk the table, emitting tokens in reading order. Prefer `removed`
  // before `added` at a divergence so deletions read before substitutions.
  const tokens: Array<{ kind: DiffSegmentKind; token: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      tokens.push({ kind: 'equal', token: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      tokens.push({ kind: 'removed', token: a[i]! })
      i++
    } else {
      tokens.push({ kind: 'added', token: b[j]! })
      j++
    }
  }
  while (i < n) {
    tokens.push({ kind: 'removed', token: a[i]! })
    i++
  }
  while (j < m) {
    tokens.push({ kind: 'added', token: b[j]! })
    j++
  }

  // Coalesce adjacent same-kind tokens into runs.
  const segments: DiffSegment[] = []
  for (const { kind, token } of tokens) {
    const last = segments[segments.length - 1]
    if (last && last.kind === kind) {
      segments[segments.length - 1] = { kind, text: `${last.text} ${token}` }
    } else {
      segments.push({ kind, text: token })
    }
  }
  return segments
}

/** True iff sanitizing changed anything (any removed or added segment). */
export function hasSanitizationChange(segments: readonly DiffSegment[]): boolean {
  return segments.some((s) => s.kind !== 'equal')
}
