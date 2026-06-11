// Compile loose config inputs into the validated, bundle_id-stamped
// content artifacts (bundle.json / policy.json / assets.json). This is
// the pure, in-memory half of "Helios publisher" (parent EPIC_PLAN §5,
// P1); publish.ts adds signing, checksums, and the atomic pointer.

import {
  AssetsSchema,
  BundleSchema,
  PolicySchema,
  type Assets,
  type Bundle,
  type ComponentSchema,
  type DisabledVariant,
  type FamilySchema,
  type Policy,
  type SiteSchema,
  type VariantSchema,
} from './contracts.js'
import { newBundleId } from './ids.js'
import { checkBundleConsistency } from './registryCheck.js'
import type { z } from 'zod'

export interface CompileInput {
  readonly sites: Record<string, z.infer<typeof SiteSchema>>
  readonly families: Record<string, z.infer<typeof FamilySchema>>
  readonly components: Record<string, z.infer<typeof ComponentSchema>>
  readonly variants: ReadonlyArray<z.infer<typeof VariantSchema>>
  readonly policy: Pick<Policy, 'policy_version_id' | 'selection_algorithm_version' | 'rules'>
  readonly disabledVariants?: readonly DisabledVariant[]
  readonly bundleId?: string
  readonly now?: Date
}

export interface CompiledBundle {
  readonly bundleId: string
  readonly bundle: Bundle
  readonly policy: Policy
  readonly assets: Assets
}

export class CompileError extends Error {
  constructor(public readonly problems: string[]) {
    super(`landing-page bundle compile failed:\n  - ${problems.join('\n  - ')}`)
    this.name = 'CompileError'
  }
}

export function compileBundle(input: CompileInput): CompiledBundle {
  const bundleId = input.bundleId ?? newBundleId(input.now)

  const bundleParsed = BundleSchema.safeParse({
    schema: 'freshlybaked.lp.bundle.v1',
    bundle_id: bundleId,
    sites: input.sites,
    families: input.families,
    components: input.components,
  })
  const assetsParsed = AssetsSchema.safeParse({
    schema: 'freshlybaked.lp.assets.v1',
    bundle_id: bundleId,
    variants: input.variants,
  })
  const policyParsed = PolicySchema.safeParse({
    schema: 'freshlybaked.lp.policy.v1',
    policy_version_id: input.policy.policy_version_id,
    selection_algorithm_version: input.policy.selection_algorithm_version,
    rules: input.policy.rules,
  })

  const problems: string[] = []
  if (!bundleParsed.success) problems.push(...zodProblems('bundle', bundleParsed.error))
  if (!assetsParsed.success) problems.push(...zodProblems('assets', assetsParsed.error))
  if (!policyParsed.success) problems.push(...zodProblems('policy', policyParsed.error))
  if (problems.length > 0) throw new CompileError(problems)

  const bundle = bundleParsed.data!
  const assets = assetsParsed.data!
  const policy = policyParsed.data!

  const consistency = checkBundleConsistency(bundle, policy, assets, input.disabledVariants)
  if (consistency.length > 0) throw new CompileError(consistency)

  return { bundleId, bundle, policy, assets }
}

function zodProblems(label: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${label}.${i.path.join('.') || '<root>'}: ${i.message}`)
}
