// Customer-Sentiment Capture (issue #13, A2 phase)
//
// Private-LLM sentiment + suitability gate for inbound customer-review
// submissions. Invoked synchronously from the
// POST /v1/reviews/submit handler when the submission has non-empty
// review text AND the per-site `review_llm_gate_enabled` flag is on.
//
// Re-uses Helios's existing private-LLM gateway (Bedrock-mantle,
// OpenAI-compatible /chat/completions). No new model / provider —
// same endpoint as worker description-rerun and staff-photo focal
// points.
//
// Verdict contract (parent design §"Sentiment + suitability LLM
// gate"):
//
//   strong-with-text — 5★-ish positive AND text is safe to publish
//                      on a public review-aggregator surface.
//   strong-no-text   — text exists but is NOT safe to publish (PII,
//                      legal claims, off-topic rant, profanity that
//                      can't be cleanly re-published, etc.). Customer
//                      is still in the "happy" bucket; we just don't
//                      offer the paste-text upsell.
//   lukewarm         — 3-4★-ish or mixed sentiment. Drawing form is
//                      still offered (we want their contact info for
//                      the make-it-right email) but no paste-text.
//   negative         — 1-2★-ish or clearly negative sentiment. No
//                      drawing form; route the customer to a
//                      "thanks, someone will reach out" state.
//   error            — gateway transport / timeout / shape error. The
//                      submit handler then applies the operator-
//                      settled degraded-pass heuristic + pages Dave.
//
// Important: the gate does NOT have access to other helios db /
// secrets / network surfaces. It only sees what's passed in.

import type { JsonValue } from '../../shared/contracts/index.js'
import { getServerEnv } from '../config/env.js'

export type ReviewLlmVerdict =
  | 'strong-with-text'
  | 'strong-no-text'
  | 'lukewarm'
  | 'negative'
  | 'error'

export interface ReviewLlmGateInput {
  starRating: number
  reviewText: string
}

export interface ReviewLlmGateOutput {
  verdict: ReviewLlmVerdict
  raw: JsonValue
  modelRef: string
  errorMessage: string | null
}

// Sized to the smallest production-suitable model on the mantle —
// classification is a quick decision and we don't want to spend
// 30s waiting on a high-end model while the customer's browser
// hangs on the submit POST.
// Use the same model that every other helios mantle caller uses
// (staff-photo focal-point detection in
// refreshStaffPhotoFocalPoints.ts, search-adaptation in
// litAlertsMarket.ts, packet generation in
// generatePendingPurchasePacketJob.ts). It's proven-working
// against bedrock-mantle.us-east-2.api.aws and is small/fast
// enough for a one-shot sentiment classification. The previous
// value `anthropic.claude-3-5-haiku-20241022-v1:0` was rejected
// by the gateway with "model not found"; we have no working
// Anthropic-model reference in this codebase to copy.
const REVIEW_GATE_MODEL = 'google.gemma-3-27b-it'

const SYSTEM_PROMPT = [
  'You are a strict review-classification assistant for a New York cannabis retailer.',
  'You will receive a (star_rating, review_text) pair from a customer.',
  'Classify it into exactly one of these four labels, returning strict JSON:',
  '  "strong-with-text" — clearly positive AND the text is safe and appropriate to re-publish verbatim on a public review aggregator (Google, Yelp). Free of PII (full names of staff, phone numbers, addresses), legal threats, off-topic content, or unredactable profanity.',
  '  "strong-no-text"  — clearly positive BUT the text contains something we should not re-publish verbatim (PII, off-topic, legal threats, profanity, libelous claims, advertising for a competitor, etc.).',
  '  "lukewarm"        — mixed or middling sentiment, OR neutral. The customer is neither clearly happy nor clearly unhappy.',
  '  "negative"        — clearly unhappy / complaining / hostile.',
  'When in doubt between strong-with-text and strong-no-text, prefer strong-no-text — we would rather skip a paste-text upsell than re-publish risky content.',
  'When in doubt between lukewarm and negative, prefer lukewarm.',
  'Star rating is informative but NOT decisive — a 5★ rating with a complaint counts as lukewarm/negative; a 3★ rating with glowing text counts as strong-*.',
  'Output ONLY a JSON object with this exact shape: {"label": <one of the four strings>, "rationale": "<one short sentence>"}. No prose, no markdown fences.',
].join(' ')

function buildUserPrompt(input: ReviewLlmGateInput): string {
  // We send the raw text verbatim — the gate model sees PII and is
  // responsible for the suitability call.
  return `star_rating: ${input.starRating}\nreview_text: ${JSON.stringify(input.reviewText)}`
}

function looksLikeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractAssistantContent(payload: unknown): string {
  if (!looksLikeRecord(payload)) {
    throw new Error('LLM response was not an object')
  }
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('LLM response contained no choices')
  }
  const first = choices[0]
  if (!looksLikeRecord(first) || !looksLikeRecord(first.message)) {
    throw new Error('LLM response choice was missing message payload')
  }
  const content = first.message.content
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        looksLikeRecord(part) && typeof part.text === 'string' ? part.text : '',
      )
      .join('')
  }
  throw new Error('LLM response choice content was neither string nor array')
}

const PARSE_VERDICTS: ReadonlyArray<ReviewLlmVerdict> = [
  'strong-with-text',
  'strong-no-text',
  'lukewarm',
  'negative',
]

function parseVerdict(jsonText: string): ReviewLlmVerdict {
  const parsed: unknown = JSON.parse(jsonText)
  if (!looksLikeRecord(parsed)) {
    throw new Error('LLM verdict JSON was not an object')
  }
  const label = parsed.label
  if (typeof label !== 'string') {
    throw new Error('LLM verdict JSON had no string "label" field')
  }
  const match = PARSE_VERDICTS.find((candidate) => candidate === label)
  if (!match) {
    throw new Error(`LLM verdict JSON had unknown label: ${label}`)
  }
  return match
}

/**
 * Classify one review submission. Never throws — gateway / parse
 * failures map to verdict='error' with the underlying error message
 * captured for the submit handler to log + page on.
 */
export async function classifyReviewSentiment(
  input: ReviewLlmGateInput,
): Promise<ReviewLlmGateOutput> {
  const env = getServerEnv()
  if (!env.bedrockMantleBearerToken) {
    return {
      verdict: 'error',
      raw: { error: 'BEDROCK_MANTLE_BEARER_TOKEN not configured' },
      modelRef: REVIEW_GATE_MODEL,
      errorMessage: 'BEDROCK_MANTLE_BEARER_TOKEN not configured',
    }
  }

  let response: Response
  try {
    response = await fetch(`${env.bedrockMantleBaseUrl}/chat/completions`, {
      body: JSON.stringify({
        max_tokens: 120,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(input) },
        ],
        model: REVIEW_GATE_MODEL,
        response_format: { type: 'json_object' },
        temperature: 0,
        top_p: 0.1,
      }),
      headers: {
        Authorization: `Bearer ${env.bedrockMantleBearerToken}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(env.llmRequestTimeoutMs),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      verdict: 'error',
      raw: { transportError: message },
      modelRef: REVIEW_GATE_MODEL,
      errorMessage: message,
    }
  }

  const responseText = await response.text()
  if (!response.ok) {
    return {
      verdict: 'error',
      raw: { httpStatus: response.status, body: responseText.slice(0, 2000) },
      modelRef: REVIEW_GATE_MODEL,
      errorMessage: `LLM gateway returned HTTP ${response.status}: ${responseText.slice(0, 200)}`,
    }
  }

  let rawJson: unknown
  try {
    rawJson = JSON.parse(responseText)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      verdict: 'error',
      raw: { parseError: message, body: responseText.slice(0, 2000) },
      modelRef: REVIEW_GATE_MODEL,
      errorMessage: `LLM gateway response was not JSON: ${message}`,
    }
  }

  try {
    const assistantText = extractAssistantContent(rawJson)
    const verdict = parseVerdict(assistantText)
    return {
      verdict,
      raw: rawJson as JsonValue,
      modelRef: REVIEW_GATE_MODEL,
      errorMessage: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      verdict: 'error',
      raw: rawJson as JsonValue,
      modelRef: REVIEW_GATE_MODEL,
      errorMessage: message,
    }
  }
}

/**
 * Operator-settled degraded-pass heuristic from issue #13:
 *
 *   degraded_pass = (len(text) >= 50) AND (word_count(text) >= 10)
 *
 * Only meaningful when llm_verdict='error'; on success the verdict
 * itself is authoritative.
 */
export function computeDegradedPass(reviewText: string): boolean {
  if (reviewText.length < 50) {
    return false
  }
  const words = reviewText.trim().split(/\s+/).filter((token) => token.length > 0)
  return words.length >= 10
}
