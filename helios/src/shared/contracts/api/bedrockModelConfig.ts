import { z } from 'zod'

import { BEDROCK_MODEL_CONTEXT_KEYS } from '../../domain/bedrockModels.js'

// API contracts for the below-the-fold Bedrock model config page
// (child FreshlyBakedNYC/automation#54, task C4, parent virusdave/top-level#33).
//
// The page lets an operator set a rare per-context model override for the LLM
// use-points enumerated in ../../domain/bedrockModels.ts. Overrides persist in
// the `app_settings` JSONB row keyed BEDROCK_MODEL_OVERRIDES_KEY (server-side);
// the resolver merges override-then-code-default. The CODE DEFAULTS live in the
// domain module, not here — this file is the wire shape only.
//
// Satisfies: virusdave/top-level#33

const BedrockModelContextKeySchema = z.enum(BEDROCK_MODEL_CONTEXT_KEYS)

// A model id is an opaque gateway string; bound it so a hostile/typo paste
// can't bloat the stored blob. Empty is normalized to "no override" by the
// route, never stored.
const ModelIdSchema = z.string().trim().min(1).max(200)

// The persisted overrides blob (the `value` of the app_settings row).
// Versioned so a future shape change is detectable; a malformed/old blob is
// ignored by the resolver (overrides drop to code defaults) rather than
// bricking classification.
export const BEDROCK_MODEL_OVERRIDES_VERSION = 1 as const
export const BedrockModelOverridesSchema = z
  .object({
    version: z.literal(BEDROCK_MODEL_OVERRIDES_VERSION),
    // Sparse map: only contexts the operator overrode appear here.
    overrides: z.partialRecord(BedrockModelContextKeySchema, ModelIdSchema),
  })
  .strict()
export type BedrockModelOverrides = z.infer<typeof BedrockModelOverridesSchema>

// One row in the GET response: the resolved view of a single context.
export const BedrockModelContextStateSchema = z.object({
  key: BedrockModelContextKeySchema,
  label: z.string().min(1),
  description: z.string().min(1),
  defaultModel: ModelIdSchema,
  // The operator override, or null when none is set.
  overrideModel: ModelIdSchema.nullable(),
  // What actually runs: overrideModel ?? defaultModel.
  effectiveModel: ModelIdSchema,
})
export type BedrockModelContextState = z.infer<typeof BedrockModelContextStateSchema>

export const BedrockModelConfigGetResponseSchema = z.object({
  contexts: z.array(BedrockModelContextStateSchema),
  // Free-text id suggestions for the override input's datalist.
  suggestions: z.array(ModelIdSchema),
  updatedBy: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
})
export type BedrockModelConfigGetResponse = z.infer<typeof BedrockModelConfigGetResponseSchema>

// PUT replaces the whole overrides set. The client sends the sparse map of
// contexts it wants overridden; a context ABSENT from the map is cleared back
// to its code default. Empty-string values are rejected (the client omits a
// blank input rather than sending ""), so "clear" is expressed by omission.
export const BedrockModelConfigPutBodySchema = z
  .object({
    overrides: z.partialRecord(BedrockModelContextKeySchema, ModelIdSchema),
  })
  .strict()
export type BedrockModelConfigPutBody = z.infer<typeof BedrockModelConfigPutBodySchema>
