import { z } from 'zod'

// API contracts for the SEO image-asset control plane (P4 remainder).
//
// The Helios control plane lets an operator register / review / APPROVE SEO
// image assets (hero / og / derivative) INDEPENDENTLY of any blog post
// (parent EPIC_PLAN §0.3): a post may publish image-less, and an image is
// approved on its own merits, then later referenced by a post (the
// hero_image_sha256 / og_image_sha256 fields the bundle contract already
// reserves). Approval is the IRONCLAD human gate (canon §1): nothing reaches
// a published bundle's assets.json without an approver signing off on the
// EXACT image identity + metadata fingerprint.
//
// The direct analog of api/seoPost.ts (P4); the content address of the
// image bytes (asset_sha256) is supplied by the operator / generation
// pipeline — Helios owns the metadata + approval, the renderer hosts bytes.
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

export const SeoImageAssetStatusSchema = z.enum(['draft', 'needs_review', 'approved', 'rejected'])
export type SeoImageAssetStatus = z.infer<typeof SeoImageAssetStatusSchema>

export const SeoImageAssetSourceSchema = z.enum(['manual', 'generated'])
export type SeoImageAssetSource = z.infer<typeof SeoImageAssetSourceSchema>

export const SeoImageRoleSchema = z.enum(['hero', 'og', 'derivative'])
export type SeoImageRole = z.infer<typeof SeoImageRoleSchema>

// A control-plane image-asset row as returned to the client.
export const SeoImageAssetRecordSchema = z.object({
  assetId: z.string().min(1),
  // Content address (sha256) of the underlying image bytes.
  assetSha256: z.string(),
  role: SeoImageRoleSchema,
  mediaType: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  altText: z.string(),
  status: SeoImageAssetStatusSchema,
  source: SeoImageAssetSourceSchema,
  // Current content fingerprint — the client echoes this back on approve
  // (expectedContentSha256) so an approval can never cover metadata that
  // changed after the page loaded.
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  approvalId: z.string().nullable(),
  reviewer: z.string().nullable(),
  approvedByUserId: z.number().int().positive().nullable(),
  approvedAt: z.string().nullable(),
  approvalNote: z.string().nullable(),
  generationMeta: z.unknown().nullable(),
  createdByUserId: z.number().int().positive().nullable(),
  updatedByUserId: z.number().int().positive().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SeoImageAssetRecord = z.infer<typeof SeoImageAssetRecordSchema>

export const SeoImageAssetListResponseSchema = z.object({
  assets: z.array(SeoImageAssetRecordSchema),
})
export type SeoImageAssetListResponse = z.infer<typeof SeoImageAssetListResponseSchema>

export const SeoImageAssetDetailResponseSchema = z.object({
  asset: SeoImageAssetRecordSchema,
})
export type SeoImageAssetDetailResponse = z.infer<typeof SeoImageAssetDetailResponseSchema>

// The editable metadata fields shared by create + update. A brand-new draft
// may be mostly empty (operator fills it in); the approve path enforces
// completeness + compliance.
const Sha256FieldSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^([0-9a-f]{64})?$/, 'must be a 64-char lowercase hex sha256 (or empty for a draft)')
const RoleFieldSchema = SeoImageRoleSchema
const MediaTypeFieldSchema = z.string().trim().max(128)
const AltTextFieldSchema = z.string().trim().max(1000)
// `null` clears the dimension; a positive int sets it.
const DimensionFieldSchema = z.number().int().positive().max(100000).nullable()

export const SeoImageAssetCreateBodySchema = z
  .object({
    assetSha256: Sha256FieldSchema.default(''),
    role: RoleFieldSchema.default('hero'),
    mediaType: MediaTypeFieldSchema.default(''),
    width: DimensionFieldSchema.default(null),
    height: DimensionFieldSchema.default(null),
    altText: AltTextFieldSchema.default(''),
  })
  .strict()
export type SeoImageAssetCreateBody = z.infer<typeof SeoImageAssetCreateBodySchema>

// Edits replace the metadata wholesale. Any successful edit resets the asset
// to `draft` and clears its approval (server-enforced) so an approval can
// never silently cover edited metadata.
export const SeoImageAssetUpdateBodySchema = z
  .object({
    assetSha256: Sha256FieldSchema,
    role: RoleFieldSchema,
    mediaType: MediaTypeFieldSchema,
    width: DimensionFieldSchema,
    height: DimensionFieldSchema,
    altText: AltTextFieldSchema,
  })
  .strict()
export type SeoImageAssetUpdateBody = z.infer<typeof SeoImageAssetUpdateBodySchema>

export const SeoImageAssetApproveBodySchema = z
  .object({
    // The fingerprint the reviewer actually saw. A mismatch with the
    // current row => 409 (stale review).
    expectedContentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
export type SeoImageAssetApproveBody = z.infer<typeof SeoImageAssetApproveBodySchema>

export const SeoImageAssetRejectBodySchema = z
  .object({
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
export type SeoImageAssetRejectBody = z.infer<typeof SeoImageAssetRejectBodySchema>

export const SeoImageAssetRouteParamsSchema = z.object({
  assetId: z.string().min(1),
})
export type SeoImageAssetRouteParams = z.infer<typeof SeoImageAssetRouteParamsSchema>
