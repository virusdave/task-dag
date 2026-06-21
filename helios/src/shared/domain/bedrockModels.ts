// Bedrock model selection for the LLM use-points in Helios
// (child FreshlyBakedNYC/automation#54, task C4, parent virusdave/top-level#33).
//
// Operator decision 1: each Bedrock use-point defaults to the current
// "standard, most capable general reasoning model," chosen DYNAMICALLY at
// call time (resolved override-then-default) rather than pinned in a
// contract. A below-the-fold Bedrock config page lets an operator set a rare
// per-context override for curiosity/testing without a code change.
//
// This file is the single source of truth for the per-context CODE DEFAULTS
// and the set of override-able contexts. The operator overrides live in the
// `app_settings` row keyed by BEDROCK_MODEL_OVERRIDES_KEY (server-side); the
// resolver merges override-then-default. Defaults live here (not in the API
// contract file) to mirror DEFAULT_DESCRIPTION_LLM_MODEL in
// ./descriptionGeneration.ts.
//
// Satisfies: virusdave/top-level#33

// The "standard, most capable general reasoning model" the worker currently
// defaults to across its LLM use-points (hint extraction, descriptions). The
// classifier inherits it so all Helios LLM calls move together when this is
// bumped; the per-context override page is for rare exceptions.
export const DEFAULT_STANDARD_REASONING_MODEL = 'google.gemma-3-27b-it'

// The LLM use-points whose model an operator may override. v1 (C4) exposes
// ONLY the prospective pending-purchase classifier — the only use-point wired
// to consume the override this task. C3's hint extraction/intent calls still
// use their hardcoded default; they will be added here when they are wired to
// read the override (do NOT list an override row that does nothing).
export const BEDROCK_MODEL_CONTEXT_KEYS = ['pending_purchase_classifier'] as const
export type BedrockModelContextKey = (typeof BEDROCK_MODEL_CONTEXT_KEYS)[number]

export interface BedrockModelContextDefinition {
  readonly key: BedrockModelContextKey
  readonly label: string
  readonly description: string
  readonly defaultModel: string
}

// Per-context definitions: the operator-facing label/description and the code
// default. The default is what runs when no override is set.
export const BEDROCK_MODEL_CONTEXTS: readonly BedrockModelContextDefinition[] = [
  {
    key: 'pending_purchase_classifier',
    label: 'Pending-purchase classifier',
    description:
      'Decodes a distributor delivery into draft pending-purchase rows (brand/taxonomy + a proposed reuse-link candidate). Runs once per delivery; rare, so a top-tier model is fine.',
    defaultModel: DEFAULT_STANDARD_REASONING_MODEL,
  },
]

// Free-text model-id suggestions surfaced in the config page's datalist. The
// operator may type ANY model id the gateway accepts; this is only a
// convenience list of ids known to be in use, not an allow-list.
export const BEDROCK_MODEL_SUGGESTIONS: readonly string[] = [DEFAULT_STANDARD_REASONING_MODEL]

export function getBedrockModelContextDefinition(
  key: BedrockModelContextKey,
): BedrockModelContextDefinition {
  const definition = BEDROCK_MODEL_CONTEXTS.find((candidate) => candidate.key === key)
  if (!definition) {
    // BEDROCK_MODEL_CONTEXT_KEYS and BEDROCK_MODEL_CONTEXTS are defined
    // together in this file, so a missing entry is a programming error.
    throw new Error(`No Bedrock model context definition for key "${key}".`)
  }
  return definition
}

export function getBedrockModelContextDefault(key: BedrockModelContextKey): string {
  return getBedrockModelContextDefinition(key).defaultModel
}
