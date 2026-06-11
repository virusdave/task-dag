// Typed (zod) mirror of the frozen landing-page engine contracts.
//
// The cross-repo source of truth is the JSON Schema set in
// `config/landing-pages/schemas/` (parent EPIC_PLAN §5/§6/§8). These
// zod schemas are the in-process, typed Helios mirror used by the
// compiler/publisher/validator. Keep them in lock-step with the JSON
// Schemas; `scripts/validate-lp-contracts` checks the JSON side, the
// vitest suite checks this side, and `contracts.test.ts` cross-checks
// the bundled example fixtures against these schemas.

import { z } from 'zod'

export const BUNDLE_ID_RE = /^lpb_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/
export const SHA256_RE = /^[0-9a-f]{64}$/
export const SIGNATURE_RE = /^ed25519:[A-Za-z0-9+/=_-]+$/
export const SLOT_ID_RE = /^X[1-9][0-9]*$/

export const BundleIdSchema = z.string().regex(BUNDLE_ID_RE)
export const Sha256Schema = z.string().regex(SHA256_RE)
export const SignatureSchema = z.string().regex(SIGNATURE_RE)
export const SlotIdSchema = z.string().regex(SLOT_ID_RE)

// ── current.json (the atomic pointer + signed kill-list) ──────────────

export const DisabledVariantSchema = z
  .object({
    site: z.string(),
    purpose: z.string(),
    slug: z.string(),
    num: z.number().int().min(1),
    replacement_num: z.number().int().min(1).optional(),
    reason: z.string().min(1),
    effective_at: z.string(),
  })
  .strict()

export const CurrentPointerSchema = z
  .object({
    schema: z.literal('freshlybaked.lp.current.v1'),
    environment: z.enum(['prod', 'preview', 'staging', 'nonprod']),
    bundle_id: BundleIdSchema,
    manifest_url: z.string().min(1),
    manifest_sha256: Sha256Schema,
    version: z.number().int().min(1),
    published_at: z.string(),
    previous_bundle_id: BundleIdSchema.optional(),
    signature: SignatureSchema,
    disabled_variants: z.array(DisabledVariantSchema).optional(),
  })
  .strict()

// ── manifest.json (signed index + checksums) ──────────────────────────

export const FileRefSchema = z
  .object({
    // Path relative to the bundle dir; never absolute / never contains '..'.
    url: z.string().min(1),
    sha256: Sha256Schema,
  })
  .strict()

export const ManifestSchema = z
  .object({
    schema: z.literal('freshlybaked.lp.bundle-manifest.v1'),
    bundle_id: BundleIdSchema,
    min_renderer_version: z.string().min(1),
    automation_git_sha: z.string().regex(/^[0-9a-f]{7,40}$/),
    generated_from: z
      .object({
        cluster_sweep_run_id: z.number().int().min(1).optional(),
        asset_approval_snapshot_id: z.number().int().min(1).optional(),
        policy_version_id: z.string().min(1),
      })
      .strict(),
    files: z
      .object({
        bundle: FileRefSchema,
        policy: FileRefSchema,
        assets: FileRefSchema,
      })
      .strict(),
    signature: SignatureSchema,
  })
  .strict()

// ── bundle.json (sites, families, frozen components) ──────────────────

export const SiteSchema = z
  .object({
    host: z.string().optional(),
    // Mirror of the mss MAX_VARIANT_BY_PURPOSE drift-guard: PURPOSE -> max NUM.
    purpose_max_variant: z.record(z.string(), z.number().int().min(1)),
  })
  .passthrough()

export const SlotRequirementSchema = z
  .object({
    required: z.boolean().optional(),
    frozen: z.boolean().optional(),
    data_source: z.string().optional(),
  })
  .passthrough()

export const FamilySchema = z
  .object({
    purpose: z.string(),
    slots: z.array(SlotIdSchema).min(1),
    slot_requirements: z.record(z.string(), SlotRequirementSchema).optional(),
  })
  .strict()

export const ComponentSchema = z
  .object({
    component_id: z.string().min(1),
    frozen: z.boolean(),
    approval_id: z.string().optional(),
  })
  .passthrough()

export const BundleSchema = z
  .object({
    schema: z.literal('freshlybaked.lp.bundle.v1'),
    bundle_id: BundleIdSchema,
    sites: z.record(z.string(), SiteSchema),
    families: z.record(z.string(), FamilySchema),
    components: z.record(z.string(), ComponentSchema),
  })
  .strict()
  .refine((b) => Object.keys(b.sites).length > 0, { message: 'bundle.sites must be non-empty' })
  .refine((b) => Object.keys(b.families).length > 0, { message: 'bundle.families must be non-empty' })

// ── policy.json (declarative selection policy) ────────────────────────

export const ExploreCandidateSchema = z
  .object({ variant_id: z.string().min(1), weight: z.number().int().min(0) })
  .strict()

export const SlotPolicySchema = z.union([
  z
    .object({
      exploit: z.string().min(1),
      explore: z.array(ExploreCandidateSchema).optional(),
    })
    .strict(),
  z.object({ fixed: z.string().min(1) }).strict(),
  z.object({ data_source: z.string().min(1), config_id: z.string().min(1) }).strict(),
])

export const PolicyRuleSchema = z
  .object({
    policy_rule_id: z.string().min(1),
    match: z
      .object({
        site: z.string().optional(),
        family: z.string().optional(),
        cluster_slug: z.string().optional(),
      })
      .passthrough()
      .refine((m) => Object.keys(m).length > 0, { message: 'match must be non-empty' }),
    assignment_key: z.array(z.string()).min(1),
    experiment_id: z.string().min(1),
    experiment_salt: z.string().min(1),
    exploration_rate_bps: z.number().int().min(0).max(10000),
    slots: z.record(z.string(), SlotPolicySchema),
  })
  .strict()

export const PolicySchema = z
  .object({
    schema: z.literal('freshlybaked.lp.policy.v1'),
    policy_version_id: z.string().min(1),
    selection_algorithm_version: z.string().min(1),
    rules: z.array(PolicyRuleSchema).min(1),
  })
  .strict()

// ── assets.json (per-slot variant pool + approval status) ─────────────

export const AssetRefSchema = z
  .object({
    sha256: Sha256Schema,
    role: z.string().optional(),
    media_type: z.string().optional(),
  })
  .strict()

export const VariantSchema = z
  .object({
    variant_id: z.string().min(1),
    slot: SlotIdSchema,
    family: z.string().optional(),
    source: z.enum(['existing', 'generated']),
    approval_status: z.enum(['approved', 'pending', 'rejected']),
    approval_id: z.string().optional(),
    asset_refs: z.array(AssetRefSchema).optional(),
  })
  .strict()

export const AssetsSchema = z
  .object({
    schema: z.literal('freshlybaked.lp.assets.v1'),
    bundle_id: BundleIdSchema,
    variants: z.array(VariantSchema).min(1),
  })
  .strict()

// ── lp-events batch (POST /v1/lp-events/batch body) ───────────────────

export const LpEventSchema = z
  .object({
    event_id: z.string().min(1),
    event_type: z.enum(['lp_impression', 'lp_redirect', 'lp_assignment', 'lp_conversion']),
    event_ts: z.string(),
    replica_id: z.string().min(1),
    bundle_id: z.string().min(1),
    policy_id: z.string().min(1),
    policy_rule_id: z.string().optional(),
    experiment_id: z.string().optional(),
    assignment_id: z.string().optional(),
    assignment_key_type: z
      .enum(['gclid', 'gbraid', 'wbraid', 'cookie', 'session', 'default'])
      .optional(),
    branch_id: z.string().optional(),
    selected_variants: z.record(z.string(), z.string()).optional(),
    counterfactual_variants: z.record(z.string(), z.string()).optional(),
    candidate_weights: z
      .record(z.string(), z.array(z.object({ variant_id: z.string(), weight: z.number().int().min(0) }).strict()))
      .optional(),
    served_probability_bps: z.number().int().min(0).max(10000).optional(),
    bucket_bps: z.number().int().min(0).max(9999).optional(),
    gclid_hash: z.string().optional(),
    site: z.string().min(1),
    family: z.string().optional(),
    cluster_slug: z.string().optional(),
    traffic_flags: z.array(z.string()).optional(),
  })
  .strict()

export const LpEventsBatchSchema = z
  .object({
    schema: z.literal('freshlybaked.lp.events-batch.v1'),
    replica_id: z.string().min(1),
    sent_at: z.string(),
    events: z.array(LpEventSchema).min(1),
  })
  .strict()

// ── inferred types ────────────────────────────────────────────────────

export type DisabledVariant = z.infer<typeof DisabledVariantSchema>
export type CurrentPointer = z.infer<typeof CurrentPointerSchema>
export type Manifest = z.infer<typeof ManifestSchema>
export type Bundle = z.infer<typeof BundleSchema>
export type Policy = z.infer<typeof PolicySchema>
export type PolicyRule = z.infer<typeof PolicyRuleSchema>
export type SlotPolicy = z.infer<typeof SlotPolicySchema>
export type Assets = z.infer<typeof AssetsSchema>
export type Variant = z.infer<typeof VariantSchema>
export type LpEvent = z.infer<typeof LpEventSchema>
export type LpEventsBatch = z.infer<typeof LpEventsBatchSchema>
