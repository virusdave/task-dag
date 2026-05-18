/**
 * Use-case contract for the METRC pending-purchase product-name parser.
 *
 * Mirrors the existing `ParsedProductNameSchema` and
 * `collectSemanticParserIssues` in
 * helios/src/worker/jobs/generatePendingPurchasePacketJob.ts so that
 * parsekit-produced outputs are byte-for-byte interchangeable with the
 * legacy hardcoded parsers (this is the contract that the shadow-mode
 * diff harness in EPIC Phase 7 will assert against).
 */

import { z } from 'zod'

import type { UseCaseContract, ValidationIssue } from '../types.js'

export const ParsedProductNameSchema = z.object({
  brand: z.string().trim().min(1),
  category: z.string().trim().min(1),
  groupName: z.string().trim().min(1),
  packCount: z.coerce.number().int().positive(),
  prevalence: z.string().trim().min(1).nullable(),
  searchTerm: z.string().trim().min(1),
  size: z.string().trim().min(1),
  strainName: z.string().trim(),
  subcategory: z.string().trim(),
  variantName: z.string().trim().min(1),
  variantTab: z.string().trim().min(1),
})

export type ParsedProductName = z.infer<typeof ParsedProductNameSchema>

const GENERIC_LEAF_TOKENS = ['vape', 'vapes', 'pre-roll', 'preroll', 'gummy', 'beverage']

/**
 * Port of `collectSemanticParserIssues` in
 * generatePendingPurchasePacketJob.ts. Field-level "missing" issues
 * are largely caught by the Zod schema already, so this only adds the
 * checks Zod cannot express (generic-leaf-token rejection).
 */
function semanticValidate(value: ParsedProductName): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const loweredVariantName = value.variantName.trim().toLowerCase()
  if (
    GENERIC_LEAF_TOKENS.some(
      (token) => loweredVariantName === token || loweredVariantName === `${token}s`,
    )
  ) {
    issues.push({
      code: 'generic_variant_name',
      message: `generic variantName "${value.variantName}"`,
      path: 'variantName',
    })
  }

  const loweredGroup = value.groupName.trim().toLowerCase()
  if (GENERIC_LEAF_TOKENS.includes(loweredGroup)) {
    issues.push({
      code: 'generic_group_name',
      message: `generic groupName "${value.groupName}"`,
      path: 'groupName',
    })
  }

  return issues
}

export const pendingPurchasesContract: UseCaseContract<ParsedProductName> = {
  useCase: 'pending-purchases',
  outputSchema: ParsedProductNameSchema,
  semanticValidate,
}

/** Field set used by the static safety verifier (projection allowlist). */
export const pendingPurchasesOutputFields = new Set<string>(
  Object.keys(ParsedProductNameSchema.shape),
)
