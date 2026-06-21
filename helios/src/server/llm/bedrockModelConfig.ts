// Server-side resolver for the per-context Bedrock model overrides
// (child FreshlyBakedNYC/automation#54, task C4, parent virusdave/top-level#33).
//
// Reads the operator's overrides from the `app_settings` JSONB row, merges
// them over the code defaults from ../../shared/domain/bedrockModels.ts, and
// answers "what model id should this LLM use-point run?". Shared by the config
// route (GET/PUT) and the worker classifier (which resolves its model at call
// time — operator decision 1, "chosen dynamically").
//
// Tolerance policy (intentional, not bug-masking): a MISSING row or a
// MALFORMED/old blob means "no overrides" → fall back to code defaults, with a
// console.warn, so corrupt config can never brick classification. That is the
// correct behavior for an optional override store. A VALID override that names
// a model the gateway rejects is NOT caught here — the LLM call fails loud,
// because the operator deliberately chose that model.
//
// Satisfies: virusdave/top-level#33

import {
  BedrockModelOverridesSchema,
  type BedrockModelContextState,
} from '../../shared/contracts/index.js'
import {
  BEDROCK_MODEL_CONTEXTS,
  getBedrockModelContextDefault,
  type BedrockModelContextKey,
} from '../../shared/domain/bedrockModels.js'
import { getAppSetting } from '../db/queries/appSettingsQueries.js'
import type { Queryable } from '../db/pool.js'

// The single app_settings key holding the whole overrides blob.
export const BEDROCK_MODEL_OVERRIDES_KEY = 'bedrock_model_overrides'

export interface BedrockModelOverridesRecord {
  readonly overrides: Partial<Record<BedrockModelContextKey, string>>
  readonly updatedBy: string | null
  readonly updatedAt: string | null
}

/**
 * Load the raw overrides record. A missing row yields empty overrides; a
 * malformed/old blob is ignored (warned, treated as empty) so a bad config
 * can never break the use-points that depend on it.
 */
export async function loadBedrockModelOverrides(
  db: Queryable,
): Promise<BedrockModelOverridesRecord> {
  const row = await getAppSetting(db, BEDROCK_MODEL_OVERRIDES_KEY)
  if (!row) {
    return { overrides: {}, updatedBy: null, updatedAt: null }
  }
  const parsed = BedrockModelOverridesSchema.safeParse(row.value)
  if (!parsed.success) {
    console.warn(
      `[bedrockModelConfig] ignoring malformed ${BEDROCK_MODEL_OVERRIDES_KEY} blob; falling back to code defaults: ${parsed.error.message}`,
    )
    return { overrides: {}, updatedBy: row.updatedBy, updatedAt: row.updatedAt }
  }
  return {
    overrides: parsed.data.overrides,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  }
}

/**
 * Resolve the effective model id for one LLM use-point: the operator override
 * if set, else the code default. This is THE call the worker classifier makes.
 */
export async function resolveBedrockModel(
  db: Queryable,
  context: BedrockModelContextKey,
): Promise<string> {
  const { overrides } = await loadBedrockModelOverrides(db)
  return overrides[context] ?? getBedrockModelContextDefault(context)
}

/**
 * Build the per-context resolved view for the config page's GET response.
 */
export function buildBedrockModelContextStates(
  overrides: Partial<Record<BedrockModelContextKey, string>>,
): BedrockModelContextState[] {
  return BEDROCK_MODEL_CONTEXTS.map((definition) => {
    const overrideModel = overrides[definition.key] ?? null
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      defaultModel: definition.defaultModel,
      overrideModel,
      effectiveModel: overrideModel ?? definition.defaultModel,
    }
  })
}
