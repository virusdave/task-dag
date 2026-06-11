/**
 * LLM-backed "is this parse reasonable?" sanity check.
 *
 * Deliberately a *very* simple interface: hand it a name, one or more
 * candidate structured parses we already computed deterministically,
 * and a freeform context blurb. It asks a cheap/medium Bedrock model
 * (via the Mantle gateway) to pick the most reasonable candidate — or
 * propose a novel one — with a confidence value and short rationale.
 *
 * The intelligence lives in the prompt, not in an elaborate I/O schema.
 * Callers stay in control: this is an *advisory escalation*, never a
 * hard dependency. With no Mantle token, on any transport / HTTP /
 * JSON / schema failure, or on a timeout, it returns `null` and the
 * caller keeps whatever deterministic answer it already had.
 *
 * It is intentionally single-shot (no retries): a pricing run must not
 * stall on a non-critical sanity check.
 */
import { z } from 'zod'

import { getWorkerEnv } from '../config/env.js'

// Cheap/medium instruction-tuned model already proven against the Mantle
// gateway elsewhere in the worker (pricing search adaptation).
const PARSE_REASONABLENESS_MODEL = 'google.gemma-3-27b-it'
// A sanity check should never block a run for long; cap the timeout well
// below the general LLM ceiling.
const PARSE_REASONABLENESS_TIMEOUT_CEILING_MS = 15000
const PARSE_REASONABLENESS_MAX_TOKENS = 500

export interface ParseReasonablenessCandidate {
  /** Stable label the model selects by (e.g. "unit" / "total"). */
  label: string
  packCount: number
  unitValue: number | null
  totalValue: number | null
  measure: 'g' | 'mg' | null
}

export interface ParseReasonablenessResult {
  /** Chosen candidate label, or null when the model declines / proposes novel. */
  chosenLabel: string | null
  /** 0..1 self-reported confidence. */
  confidence: number
  /** Short human-readable rationale. */
  note: string
  /** Optional novel parse the model proposed instead of a candidate. */
  candidate: ParseReasonablenessCandidate | null
}

const SYSTEM_PROMPT = [
  'You are a cautious cannabis-retail catalog size QA reviewer for Freshly Baked NYC.',
  'You are given a product/listing name, a small set of candidate structured parses, and freeform surrounding context.',
  'Decide which candidate most reasonably describes the real product in the cannabis retail market.',
  'Strongly prefer common, in-distribution retail pack/unit sizes over massive out-of-distribution outliers UNLESS the context explicitly supports the outlier.',
  'A 5-pack of pre-rolls totalling 2.5g (0.5g each) is ordinary; a 5-pack of 2.5g sticks (12.5g total) would be exceedingly rare and needs explicit support.',
  'Weigh the supplied signals: operator/manual context, distributor/invoice context, brand conventions, catalog cohort evidence, and nearby retailer examples.',
  'Do not be creative when a provided candidate fits — choose it by its exact label.',
  'Only return a novel candidate (with chosenLabel=null) when NEITHER provided candidate can represent the text.',
  'Set chosenLabel=null with low confidence when you are genuinely unsure.',
  'Confidence guidance: 0.90+ only when text/context strongly supports the choice; 0.75-0.89 when one candidate is clearly more plausible but unproven; below 0.75 when uncertain.',
  'Keep the note short and concrete.',
  'Return ONLY valid JSON of the exact shape:',
  '{"assessment":{"chosenLabel":string|null,"confidence":number,"note":string,"candidate":{"label":string,"packCount":number,"unitValue":number|null,"totalValue":number|null,"measure":"g"|"mg"|null}|null}}',
].join(' ')

const EnvelopeSchema = z.object({
  assessment: z.object({
    chosenLabel: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    note: z.string().trim().max(600).default(''),
    candidate: z
      .object({
        label: z.string(),
        packCount: z.number(),
        unitValue: z.number().nullable(),
        totalValue: z.number().nullable(),
        measure: z.enum(['g', 'mg']).nullable(),
      })
      .nullable()
      .optional(),
  }),
})

export async function assessParseReasonableness(input: {
  name: string
  candidates: ParseReasonablenessCandidate[]
  context?: string
}): Promise<ParseReasonablenessResult | null> {
  const env = getWorkerEnv()
  if (!env.bedrockMantleBearerToken) {
    return null
  }
  if (input.candidates.length === 0) {
    return null
  }

  const timeoutMs = Math.min(env.llmRequestTimeoutMs, PARSE_REASONABLENESS_TIMEOUT_CEILING_MS)

  let response: Response
  try {
    response = await fetch(`${env.bedrockMantleBaseUrl}/chat/completions`, {
      body: JSON.stringify({
        max_tokens: PARSE_REASONABLENESS_MAX_TOKENS,
        messages: [
          { content: SYSTEM_PROMPT, role: 'system' },
          { content: buildUserPrompt(input), role: 'user' },
        ],
        model: PARSE_REASONABLENESS_MODEL,
        response_format: { type: 'json_object' },
        temperature: 0,
        top_p: 0.1,
      }),
      headers: {
        Authorization: `Bearer ${env.bedrockMantleBearerToken}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    console.warn(`[parseReasonableness] transport failed; skipping LLM check: ${describeError(error)}`)
    return null
  }

  if (!response.ok) {
    console.warn(`[parseReasonableness] HTTP ${response.status} ${response.statusText}; skipping LLM check.`)
    return null
  }

  let result: ParseReasonablenessResult
  try {
    const payload = (await response.json()) as unknown
    const content = extractChatCompletionContent(payload)
    const parsed = EnvelopeSchema.parse(JSON.parse(content))
    result = {
      candidate: parsed.assessment.candidate ?? null,
      chosenLabel: parsed.assessment.chosenLabel,
      confidence: parsed.assessment.confidence,
      note: parsed.assessment.note,
    }
  } catch (error) {
    console.warn(`[parseReasonableness] unparseable model response; skipping LLM check: ${describeError(error)}`)
    return null
  }

  // Guard against the model selecting a label we never offered: ignore the
  // pick (so the caller falls back to deterministic) but keep the note.
  if (result.chosenLabel !== null && !input.candidates.some((candidate) => candidate.label === result.chosenLabel)) {
    return {
      candidate: result.candidate,
      chosenLabel: null,
      confidence: Math.min(result.confidence, 0.5),
      note: `Model chose unknown label "${result.chosenLabel}"; ignored. ${result.note}`.trim(),
    }
  }

  return result
}

function buildUserPrompt(input: {
  name: string
  candidates: ParseReasonablenessCandidate[]
  context?: string
}): string {
  const lines: string[] = []
  lines.push('Product/listing name:')
  lines.push(input.name)
  lines.push('')
  lines.push('Candidate parses, choose one by its label:')
  for (const candidate of input.candidates) {
    lines.push(`- ${candidate.label}: ${describeCandidate(candidate)}`)
  }
  if (input.context && input.context.trim().length > 0) {
    lines.push('')
    lines.push('Context:')
    lines.push(input.context.trim())
  }
  return lines.join('\n')
}

function describeCandidate(candidate: ParseReasonablenessCandidate): string {
  const measure = candidate.measure ?? ''
  const unit = candidate.unitValue === null ? '?' : `${candidate.unitValue}${measure}`
  const total = candidate.totalValue === null ? '?' : `${candidate.totalValue}${measure}`
  return `${candidate.packCount} unit(s), ${unit} each, ${total} total`
}

function extractChatCompletionContent(payload: unknown): string {
  const choices = (payload as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> })?.choices
  const content = choices?.[0]?.message?.content
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    const joined = content
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .join('')
      .trim()
    if (joined) {
      return joined
    }
  }
  throw new Error('parse reasonableness response had no assistant content')
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
