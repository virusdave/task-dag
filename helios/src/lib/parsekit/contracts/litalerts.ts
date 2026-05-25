/**
 * Use-case contract for the LitAlerts parser (issue #19 L1).
 *
 * Mirrors the FuzzyVariantDescriptor sketch in
 * docs/helios/litalerts-parsing/EPIC_PLAN.md § L1. The L4/L5 preview
 * + commit-and-push flow validates LLM-proposed parser-config JSONC
 * against `litalertsContract.outputSchema`, and shadow-mode (L2)
 * uses `semanticValidate` to gate which parses are eligible for the
 * pricing read-path swap.
 *
 * This contract is intentionally narrower than the rich
 * ParsedListing shape persisted in `fuzzy_skus` today — the
 * contract is the parsekit-recognised output type; per-source
 * de-normalised mirror columns (size_g_norm, etc.) live in the DB
 * schema, not here.
 */

import { z } from 'zod'

import type { UseCaseContract, ValidationIssue } from '../types.js'

export const FuzzyVariantSizeUnitSchema = z.enum(['g', 'mg', 'mL', 'ea'])
export type FuzzyVariantSizeUnit = z.infer<typeof FuzzyVariantSizeUnitSchema>

export const FuzzyVariantCategorySchema = z.enum([
  'flower',
  'preroll',
  'vape',
  'edible',
  'concentrate',
  'tincture',
  'topical',
  'accessory',
  'beverage',
  'other',
])
export type FuzzyVariantCategory = z.infer<typeof FuzzyVariantCategorySchema>

export const FuzzyVariantPrevalenceSchema = z.enum([
  'live',
  'cured',
  'rosin',
  'distillate',
])
export type FuzzyVariantPrevalence = z.infer<typeof FuzzyVariantPrevalenceSchema>

export const FuzzyVariantDescriptorSchema = z.object({
  brand: z.string().trim().min(1),
  productLine: z.string().trim().min(1).nullable(),
  variantName: z.string().trim().min(1).nullable(),
  category: FuzzyVariantCategorySchema,
  packCount: z.coerce.number().int().positive().default(1),
  unitSize: z.object({
    value: z.coerce.number().positive(),
    unit: FuzzyVariantSizeUnitSchema,
  }),
  totalSize: z.object({
    value: z.coerce.number().positive(),
    unit: FuzzyVariantSizeUnitSchema,
  }),
  prevalence: FuzzyVariantPrevalenceSchema.nullable(),
  searchTerm: z.string().trim().min(1).nullable(),
})

export type FuzzyVariantDescriptor = z.infer<typeof FuzzyVariantDescriptorSchema>

/**
 * Semantic checks Zod can't express. Mostly guards against the
 * parser silently returning structurally-valid-but-useless rows
 * (e.g. brand="generic", category="other" with no variant name).
 */
function semanticValidate(value: FuzzyVariantDescriptor): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const brandLower = value.brand.toLowerCase()
  if (brandLower === 'generic' || brandLower === 'unbranded' || brandLower === 'unknown') {
    issues.push({
      code: 'generic_brand',
      message: `generic brand "${value.brand}"`,
      path: 'brand',
    })
  }
  if (value.category === 'other' && value.variantName === null) {
    issues.push({
      code: 'category_other_without_variant',
      message: 'category "other" requires a non-null variantName',
      path: 'category',
    })
  }
  // totalSize must be >= unitSize (multipack math sanity)
  if (value.unitSize.unit === value.totalSize.unit && value.totalSize.value < value.unitSize.value) {
    issues.push({
      code: 'total_size_below_unit_size',
      message: `totalSize ${value.totalSize.value}${value.totalSize.unit} < unitSize ${value.unitSize.value}${value.unitSize.unit}`,
      path: 'totalSize',
    })
  }
  return issues
}

export const litalertsContract: UseCaseContract<FuzzyVariantDescriptor> = {
  useCase: 'litalerts',
  outputSchema: FuzzyVariantDescriptorSchema,
  semanticValidate,
}

/** Field set used by the static safety verifier (projection allowlist). */
export const litalertsOutputFields = new Set<string>(
  Object.keys(FuzzyVariantDescriptorSchema.shape),
)
