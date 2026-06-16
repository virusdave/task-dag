// The branding `literal-slug → opaque-ref` manifest: contract + the pure,
// deterministic builder that derives it from Helios's canonical brand
// registry (`landingpage_brand_site_presence`).
//
// Ownership decision (ii) (operator, 2026-06-16, top-level#19): Helios is
// the SINGLE PRODUCER of this mapping. mss ingests it for the literal→opaque
// `308` back-compat redirect, and the operator's Ads-Editor CSV migration
// consumes it as the `literal-URL → opaque-URL` rewrite source. It is
// internal control-plane data (no public URL changes), published behind an
// atomic, signed, versioned pointer (see `publish.ts`).
//
// Why the literal slug is reproduced here, not stored: Helios's registry
// holds (`brand_id` = sweedBrandId, `brand_name`) but NOT the URL slug. mss
// derives the slug from the brand name. To produce the `literal → opaque`
// mapping the consumers need, this builder reproduces the EXACT mss
// derivation (`slugifyBrandName` + the canonical-presence filters +
// slug-collision detection), keeping the manifest a SUBSET of the pages
// mss's `generateStaticParams` emits so no literal `308` ever points at a
// page mss never generated (parent EPIC_PLAN §6.5.1). Residual divergence
// from mss's overlay-DB fixups (`sweedBrandId` override, retired-by-slug —
// which are NOT in Helios's canonical registry) is the design's accepted
// gap, caught by mss's build-time parity assertion (red build, never a prod
// 404). The clean end state migrates those fixups into Helios.

import { z } from 'zod'

import { deriveFreshlyBakedUsBrandOpaqueRef, freshlyBakedUsOpaquePublicRefLength } from './opaqueRef.js'

// FB-US branding locations. Mirrors mss `isFreshlyBakedUsLocationKey`
// (`apps/freshlybakedus-site/lib/landingpages-db.ts`): rows for any other
// `site_key` are not branding pages and are skipped.
export const FB_US_LOCATION_KEYS = ['bronx', 'midtown'] as const
export type FbUsLocationKey = (typeof FB_US_LOCATION_KEYS)[number]

export function isFbUsLocationKey(value: string): value is FbUsLocationKey {
  return (FB_US_LOCATION_KEYS as readonly string[]).includes(value)
}

export const BRANDING_OPAQUE_MANIFEST_SCHEMA = 'freshlybaked.branding-opaque-manifest.v1'
export const BRANDING_OPAQUE_POINTER_SCHEMA = 'freshlybaked.branding-opaque.current.v1'

// `bom_YYYY-MM-DD_HHMMSS_<6 hex>` — Branding Opaque Manifest id; same
// sortable, second-disambiguated spirit as the lp-bundle `lpb_` id.
export const BRANDING_MANIFEST_ID_RE = /^bom_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/
export const SHA256_RE = /^[0-9a-f]{64}$/
export const SIGNATURE_RE = /^ed25519:[A-Za-z0-9+/=_-]+$/
export const OPAQUE_REF_RE = /^[A-Za-z0-9_-]+$/
export const LITERAL_SLUG_RE = /^[a-z0-9-]+$/

/** Distinguishes a prod-secret manifest from a local/CI fallback one. */
export type SecretSource = 'production' | 'nonproduction-fallback'

// The opaque-ref scheme metadata recorded in the manifest so a consumer
// (and a future scheme rotation) can see exactly how every ref was derived.
export const BrandingOpaqueRefSchemeSchema = z
  .object({
    algorithm: z.literal('hmac-sha256-base64url-truncated'),
    scheme_version: z.literal('v1'),
    scope: z.literal('fbus-branding'),
    value_version: z.literal('v1'),
    ref_length: z.literal(freshlyBakedUsOpaquePublicRefLength),
  })
  .strict()
export type BrandingOpaqueRefScheme = z.infer<typeof BrandingOpaqueRefSchemeSchema>

export const BRANDING_OPAQUE_REF_SCHEME: BrandingOpaqueRefScheme = {
  algorithm: 'hmac-sha256-base64url-truncated',
  scheme_version: 'v1',
  scope: 'fbus-branding',
  value_version: 'v1',
  ref_length: freshlyBakedUsOpaquePublicRefLength,
}

export const BrandingOpaqueManifestEntrySchema = z
  .object({
    site_key: z.enum(FB_US_LOCATION_KEYS),
    literal_slug: z.string().min(1).regex(LITERAL_SLUG_RE),
    sweed_brand_id: z.number().int().positive(),
    opaque_ref: z.string().length(freshlyBakedUsOpaquePublicRefLength).regex(OPAQUE_REF_RE),
  })
  .strict()
export type BrandingOpaqueManifestEntry = z.infer<typeof BrandingOpaqueManifestEntrySchema>

export const BrandingOpaqueManifestSchema = z
  .object({
    schema: z.literal(BRANDING_OPAQUE_MANIFEST_SCHEMA),
    manifest_id: z.string().regex(BRANDING_MANIFEST_ID_RE),
    scheme: BrandingOpaqueRefSchemeSchema,
    secret_source: z.enum(['production', 'nonproduction-fallback']),
    automation_git_sha: z.string().regex(/^[0-9a-f]{7,40}$/),
    entries: z.array(BrandingOpaqueManifestEntrySchema),
    signature: z.string().regex(SIGNATURE_RE),
  })
  .strict()
export type BrandingOpaqueManifest = z.infer<typeof BrandingOpaqueManifestSchema>

export const BrandingOpaquePointerSchema = z
  .object({
    schema: z.literal(BRANDING_OPAQUE_POINTER_SCHEMA),
    environment: z.enum(['prod', 'preview', 'staging', 'nonprod']),
    manifest_id: z.string().regex(BRANDING_MANIFEST_ID_RE),
    manifest_url: z.string().min(1),
    manifest_sha256: z.string().regex(SHA256_RE),
    version: z.number().int().min(1),
    secret_source: z.enum(['production', 'nonproduction-fallback']),
    entry_count: z.number().int().min(0),
    published_at: z.string(),
    previous_manifest_id: z.string().regex(BRANDING_MANIFEST_ID_RE).optional(),
    signature: z.string().regex(SIGNATURE_RE),
  })
  .strict()
export type BrandingOpaquePointer = z.infer<typeof BrandingOpaquePointerSchema>

/**
 * Canonical (site, brand) presence row, parsed from
 * `landingpage_brand_site_presence`. `sweedBrandId` is the immutable Helios
 * brand id (the `brand_id` column). Mirrors the shape mss reads in
 * `fetchHeliosBrandPresence`.
 */
export interface BrandPresenceRow {
  readonly siteKey: string
  readonly sweedBrandId: number
  readonly brandName: string
  readonly forSaleVariantCount: number
  readonly lastForSaleObservedAt: Date | null
}

/**
 * Slugify a brand name into its URL `SLUG` segment. Byte-for-byte mirror of
 * mss `slugifyStorefrontPathSegment`
 * (`apps/freshlybakedus-site/lib/freshlybakedus-live-menu.ts`). Any drift
 * here breaks the `literal → opaque` mapping for affected brands.
 */
export function slugifyBrandName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export class BrandingManifestBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrandingManifestBuildError'
  }
}

export interface BrandingManifestBuildSummary {
  readonly presenceRowsConsidered: number
  readonly includedBrands: number
  readonly skippedNotFbUsSite: number
  readonly skippedEmptyName: number
  readonly skippedEmptySlug: number
  readonly skippedNotForSale: number
  readonly mergedDuplicateSlugRows: number
}

export interface BrandingManifestBuildResult {
  readonly entries: readonly BrandingOpaqueManifestEntry[]
  readonly scheme: BrandingOpaqueRefScheme
  readonly secretSource: SecretSource
  readonly summary: BrandingManifestBuildSummary
}

export interface BuildBrandingManifestOptions {
  readonly secret: string
  readonly secretSource: SecretSource
}

/**
 * Build the deterministic branding `literal → opaque` manifest entries from
 * Helios's canonical presence rows. Pure: no I/O, no env, no clock.
 *
 * Inclusion (mirrors mss `buildCanonicalHeliosBrands`, so the manifest stays
 * a subset of the pages mss emits): skip non-FB-US sites, empty trimmed
 * names, empty slugs, and brands never observed for sale
 * (`forSaleVariantCount > 0 || lastForSaleObservedAt !== null`). Rows that
 * collapse to one (site, slug) with the SAME brand id are merged; a clash
 * (same slug, different brand id) is a hard build error — exactly mss's
 * collision throw.
 *
 * Guards that FAIL the build (data corruption): invalid sweedBrandId; a
 * (site, slug) slug collision to a different brand id; a global opaque-ref
 * collision to a different brand id; any literal slug equal to any opaque
 * ref in the same location (parent EPIC_PLAN §6.5 / §6.5.1).
 */
export function buildBrandingOpaqueManifest(
  rows: readonly BrandPresenceRow[],
  options: BuildBrandingManifestOptions,
): BrandingManifestBuildResult {
  let skippedNotFbUsSite = 0
  let skippedEmptyName = 0
  let skippedEmptySlug = 0
  let skippedNotForSale = 0
  let mergedDuplicateSlugRows = 0

  // (site, slug) → resolved entry; same-slug/same-id rows merge, same-slug/
  // different-id rows throw (the canonical mss collision).
  const bySiteSlug = new Map<string, BrandingOpaqueManifestEntry>()

  for (const row of rows) {
    if (!isFbUsLocationKey(row.siteKey)) {
      skippedNotFbUsSite += 1
      continue
    }
    if (!Number.isInteger(row.sweedBrandId) || row.sweedBrandId <= 0) {
      throw new BrandingManifestBuildError(
        `invalid sweedBrandId ${String(row.sweedBrandId)} for "${row.brandName}" at ${row.siteKey}`,
      )
    }

    const trimmedName = row.brandName.trim()
    if (trimmedName.length === 0) {
      skippedEmptyName += 1
      continue
    }
    const slug = slugifyBrandName(trimmedName)
    if (slug.length === 0) {
      skippedEmptySlug += 1
      continue
    }
    const isCanonicallyPresent = row.forSaleVariantCount > 0 || row.lastForSaleObservedAt !== null
    if (!isCanonicallyPresent) {
      skippedNotForSale += 1
      continue
    }

    const key = `${row.siteKey}\u0000${slug}`
    const existing = bySiteSlug.get(key)
    if (existing !== undefined) {
      if (existing.sweed_brand_id !== row.sweedBrandId) {
        throw new BrandingManifestBuildError(
          `Helios slug collision at ${row.siteKey}: slug "${slug}" maps to brand IDs ` +
            `${String(existing.sweed_brand_id)} and ${String(row.sweedBrandId)}`,
        )
      }
      mergedDuplicateSlugRows += 1
      continue
    }

    bySiteSlug.set(key, {
      site_key: row.siteKey,
      literal_slug: slug,
      sweed_brand_id: row.sweedBrandId,
      opaque_ref: deriveFreshlyBakedUsBrandOpaqueRef(options.secret, row.sweedBrandId),
    })
  }

  const entries = sortBrandingManifestEntries([...bySiteSlug.values()])

  // Fail-closed consistency guards (opaque collisions, literal==opaque).
  // Shared with the read-time validator so a manifest can never be both
  // produced and accepted in an inconsistent state.
  const consistencyErrors = checkBrandingManifestConsistency(entries)
  if (consistencyErrors.length > 0) {
    throw new BrandingManifestBuildError(consistencyErrors.join('; '))
  }

  return {
    entries,
    scheme: BRANDING_OPAQUE_REF_SCHEME,
    secretSource: options.secretSource,
    summary: {
      presenceRowsConsidered: rows.length,
      includedBrands: entries.length,
      skippedNotFbUsSite,
      skippedEmptyName,
      skippedEmptySlug,
      skippedNotForSale,
      mergedDuplicateSlugRows,
    },
  }
}

/** Deterministic order: (site_key, literal_slug, sweed_brand_id). */
export function sortBrandingManifestEntries(
  entries: readonly BrandingOpaqueManifestEntry[],
): BrandingOpaqueManifestEntry[] {
  return [...entries].sort((a, b) => {
    if (a.site_key !== b.site_key) return a.site_key < b.site_key ? -1 : 1
    if (a.literal_slug !== b.literal_slug) return a.literal_slug < b.literal_slug ? -1 : 1
    return a.sweed_brand_id - b.sweed_brand_id
  })
}

/**
 * Pure consistency guards over final manifest entries. Empty = consistent.
 * Shared by the builder (which throws) and the read-time validator (which
 * collects). Catches:
 *  - duplicate (site_key, literal_slug) → different brand id (slug collision),
 *    or any exact duplicate entry;
 *  - duplicate opaque_ref → different brand id (would route two brands to one
 *    URL — mirrors mss `getFreshlyBakedUsBrandLandingDetailsByOpaqueRef`);
 *  - a literal slug equal to an opaque ref in the same location (parent §6.5).
 * (Per-field shape — empty slug, ref length/charset, positive id — is enforced
 * by `BrandingOpaqueManifestEntrySchema`.)
 */
export function checkBrandingManifestConsistency(
  entries: readonly BrandingOpaqueManifestEntry[],
): string[] {
  const errors: string[] = []

  const brandIdBySiteSlug = new Map<string, number>()
  for (const entry of entries) {
    const key = `${entry.site_key}\u0000${entry.literal_slug}`
    const seen = brandIdBySiteSlug.get(key)
    if (seen !== undefined) {
      errors.push(
        seen === entry.sweed_brand_id
          ? `duplicate manifest entry at ${entry.site_key}: slug "${entry.literal_slug}"`
          : `slug collision at ${entry.site_key}: slug "${entry.literal_slug}" maps to brand IDs ` +
              `${String(seen)} and ${String(entry.sweed_brand_id)}`,
      )
      continue
    }
    brandIdBySiteSlug.set(key, entry.sweed_brand_id)
  }

  const brandIdByOpaque = new Map<string, number>()
  for (const entry of entries) {
    const seen = brandIdByOpaque.get(entry.opaque_ref)
    if (seen !== undefined && seen !== entry.sweed_brand_id) {
      errors.push(
        `opaque-ref collision: "${entry.opaque_ref}" maps to brand IDs ${String(seen)} and ${String(entry.sweed_brand_id)}`,
      )
    }
    brandIdByOpaque.set(entry.opaque_ref, entry.sweed_brand_id)
  }

  for (const locationKey of FB_US_LOCATION_KEYS) {
    const slugs = new Set<string>()
    const opaques = new Set<string>()
    for (const entry of entries) {
      if (entry.site_key !== locationKey) continue
      slugs.add(entry.literal_slug)
      opaques.add(entry.opaque_ref)
    }
    for (const slug of slugs) {
      if (opaques.has(slug)) {
        errors.push(`literal slug equals an opaque ref at ${locationKey}: "${slug}"`)
      }
    }
  }

  return errors
}
