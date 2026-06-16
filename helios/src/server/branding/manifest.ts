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
// derivation (`slugifyBrandName` + the canonical-presence filters),
// keeping the manifest a SUBSET of the pages mss's `generateStaticParams`
// emits so no literal `308` ever points at a page mss never generated
// (parent EPIC_PLAN §6.5.1).
//
// Slug collisions (two different `sweedBrandId`s whose names slugify to the
// SAME `(site, slug)`) are the duplicate-Sweed-brand-record hazard mss
// resolves via its overlay DB (retiring one id). Helios's canonical
// registry has no explicit retire flag, so rather than hard-fail the whole
// build (which would block every prod publish on one stale duplicate), the
// builder resolves each collision deterministically and reports it loudly
// (operator decision, automation#48):
//   - "disabled" duplicates — brands not for sale anywhere in the FB-US
//     footprint — are skipped in favour of the one live brand;
//   - if more than one (or zero) of the colliding brands is live the case
//     is "ambiguous": the build still emits ONE deterministic winner so a
//     stale duplicate never blocks prod, but flags it for the operator.
// The CLI prints every collision and escalates ("notify operator") when the
// collision count grows beyond the single known one or any group is
// ambiguous. The clean end state still migrates mss's overlay fixups into
// Helios so the canonical registry alone disambiguates.

import { z } from 'zod'

import { isRetiredRecordName } from '../../worker/jobs/screensCarouselHelpers.js'
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

/**
 * How a `(site, slug)` collision (≥2 distinct brand ids slugifying to the
 * same literal slug at one site) was resolved:
 *  - `skipped-disabled`: exactly ONE of the colliding brands is live
 *    (for sale somewhere in the FB-US footprint); the others are treated as
 *    disabled/stale duplicates and skipped. Benign — the live brand wins.
 *  - `ambiguous`: zero or ≥2 of the colliding brands are live, so there is
 *    no single obvious winner. The build still emits ONE deterministic
 *    winner (so a stale duplicate never blocks a prod publish) but flags it
 *    for operator attention.
 */
export type BrandingSlugCollisionResolution = 'skipped-disabled' | 'ambiguous'

/** One colliding brand, with the activity signals used to pick a winner. */
export interface BrandingSlugCollisionBrand {
  readonly sweedBrandId: number
  readonly brandName: string
  /** True if this brand is for sale anywhere in the FB-US footprint. */
  readonly brandWideActive: boolean
  readonly forSaleVariantCount: number
  readonly lastForSaleObservedAt: Date | null
  /** True for the single brand whose opaque ref the literal slug maps to. */
  readonly selected: boolean
}

/** A resolved `(site, slug)` slug collision, surfaced for loud reporting. */
export interface BrandingSlugCollision {
  readonly siteKey: FbUsLocationKey
  readonly literalSlug: string
  readonly resolution: BrandingSlugCollisionResolution
  readonly winnerBrandId: number
  /** All colliding brands, sorted by `sweedBrandId`. */
  readonly brands: readonly BrandingSlugCollisionBrand[]
}

export interface BrandingManifestBuildSummary {
  readonly presenceRowsConsidered: number
  readonly includedBrands: number
  readonly skippedNotFbUsSite: number
  readonly skippedEmptyName: number
  readonly skippedRetiredName: number
  readonly skippedEmptySlug: number
  readonly skippedNotForSale: number
  readonly mergedDuplicateSlugRows: number
  /** Number of `(site, slug)` slug-collision groups resolved. */
  readonly slugCollisionGroups: number
  /** Subset of `slugCollisionGroups` with no single obvious winner. */
  readonly ambiguousCollisionGroups: number
  /** Total colliding brands dropped (not selected) across all groups. */
  readonly droppedCollisionBrands: number
}

export interface BrandingManifestBuildResult {
  readonly entries: readonly BrandingOpaqueManifestEntry[]
  readonly scheme: BrandingOpaqueRefScheme
  readonly secretSource: SecretSource
  readonly summary: BrandingManifestBuildSummary
  /** Every resolved slug collision, for loud CLI reporting / operator pages. */
  readonly collisions: readonly BrandingSlugCollision[]
}

export interface BuildBrandingManifestOptions {
  readonly secret: string
  readonly secretSource: SecretSource
}

/**
 * A canonically-present brand at one (site, slug), after merging rows that
 * share the same `sweedBrandId`. `representativeRow` is the row used for
 * winner selection (most-recently / most-for-sale of the merged rows).
 */
interface BrandAtSlug {
  readonly sweedBrandId: number
  readonly brandName: string
  representativeRow: BrandPresenceRow
}

/**
 * Deterministic "most-live" ordering used to pick a collision winner:
 * higher current for-sale count, then more recent last-for-sale, then the
 * lowest `sweedBrandId` as a stable final tiebreak. Returns < 0 if `a`
 * should sort before `b`.
 */
function compareBrandLiveness(a: BrandPresenceRow, b: BrandPresenceRow): number {
  if (a.forSaleVariantCount !== b.forSaleVariantCount) {
    return b.forSaleVariantCount - a.forSaleVariantCount
  }
  const at = a.lastForSaleObservedAt?.getTime() ?? Number.NEGATIVE_INFINITY
  const bt = b.lastForSaleObservedAt?.getTime() ?? Number.NEGATIVE_INFINITY
  if (at !== bt) return bt - at
  return a.sweedBrandId - b.sweedBrandId
}

/**
 * Build the deterministic branding `literal → opaque` manifest entries from
 * Helios's canonical presence rows. Pure: no I/O, no env, no clock.
 *
 * Inclusion (mirrors mss `buildCanonicalHeliosBrands`, so the manifest stays
 * a subset of the pages mss emits): skip non-FB-US sites, empty trimmed
 * names, operator soft-retired (`DEAD -`/`RETIRED`/… per helios/AGENTS.md)
 * brands, empty slugs, and brands never observed for sale
 * (`forSaleVariantCount > 0 || lastForSaleObservedAt !== null`). Rows that
 * collapse to one (site, slug) with the SAME brand id are merged.
 *
 * Slug collisions (same (site, slug), different brand id) are NOT a hard
 * error (operator decision, automation#48): one stale duplicate Sweed brand
 * record must not block every prod publish. Instead each collision is
 * resolved deterministically — disabled (not-for-sale-anywhere) duplicates
 * are skipped in favour of the one live brand, and genuinely ambiguous
 * groups still emit one deterministic winner — and reported via
 * `result.collisions` for loud CLI logging + operator notification.
 *
 * Guards that STILL FAIL the build (data corruption the build cannot
 * silently paper over): invalid sweedBrandId; a global opaque-ref collision
 * to a different brand id; any literal slug equal to any opaque ref in the
 * same location (parent EPIC_PLAN §6.5 / §6.5.1).
 */
export function buildBrandingOpaqueManifest(
  rows: readonly BrandPresenceRow[],
  options: BuildBrandingManifestOptions,
): BrandingManifestBuildResult {
  let skippedNotFbUsSite = 0
  let skippedEmptyName = 0
  let skippedRetiredName = 0
  let skippedEmptySlug = 0
  let skippedNotForSale = 0
  let mergedDuplicateSlugRows = 0

  // Brand-wide "is this brand live": for sale anywhere in the FB-US
  // footprint (any site). A brand that is for sale at midtown but not at
  // bronx is still a live brand, not a stale duplicate, so collisions are
  // disambiguated by brand-wide — not per-site — activity. Eligibility here
  // must match the per-row skip filters below (valid id, non-empty,
  // not operator-retired) so a stale `DEAD -`/blank row can never mark a
  // brand "live" and win a collision over the real one.
  const liveBrandIds = new Set<number>()
  for (const row of rows) {
    if (!isFbUsLocationKey(row.siteKey)) continue
    if (!Number.isInteger(row.sweedBrandId) || row.sweedBrandId <= 0) continue
    const name = row.brandName.trim()
    if (name.length === 0 || isRetiredRecordName(name)) continue
    if (row.forSaleVariantCount > 0) liveBrandIds.add(row.sweedBrandId)
  }

  // (site, slug) → { sweedBrandId → BrandAtSlug }. Same-id rows merge; a
  // group with >1 entry is a slug collision resolved below.
  const groups = new Map<string, { siteKey: FbUsLocationKey; slug: string; byBrand: Map<number, BrandAtSlug> }>()

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
    // Operator soft-retire convention (helios/AGENTS.md): a brand renamed to
    // start with `DEAD -`/`RETIRED`/… is out of service — skip it from the
    // read entirely (subset-safe: mss may still emit it, so omitting it only
    // means no literal→opaque 308, never a 404).
    if (isRetiredRecordName(trimmedName)) {
      skippedRetiredName += 1
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
    let group = groups.get(key)
    if (group === undefined) {
      group = { siteKey: row.siteKey, slug, byBrand: new Map() }
      groups.set(key, group)
    }
    const existing = group.byBrand.get(row.sweedBrandId)
    if (existing !== undefined) {
      // Same (site, slug, brand id): merge, keeping the most-live row as the
      // representative for any later collision tiebreak.
      mergedDuplicateSlugRows += 1
      if (compareBrandLiveness(row, existing.representativeRow) < 0) {
        existing.representativeRow = row
      }
      continue
    }
    group.byBrand.set(row.sweedBrandId, {
      sweedBrandId: row.sweedBrandId,
      brandName: trimmedName,
      representativeRow: row,
    })
  }

  const entries: BrandingOpaqueManifestEntry[] = []
  const collisions: BrandingSlugCollision[] = []
  let ambiguousCollisionGroups = 0
  let droppedCollisionBrands = 0

  for (const group of groups.values()) {
    const brands = [...group.byBrand.values()]

    if (brands.length === 1) {
      const only = brands[0]
      entries.push(makeManifestEntry(group.siteKey, group.slug, only.sweedBrandId, options.secret))
      continue
    }

    // Slug collision: resolve to one deterministic winner.
    const liveBrands = brands.filter((b) => liveBrandIds.has(b.sweedBrandId))
    const candidatePool = liveBrands.length > 0 ? liveBrands : brands
    const winner = [...candidatePool].sort((a, b) =>
      compareBrandLiveness(a.representativeRow, b.representativeRow),
    )[0]
    const resolution: BrandingSlugCollisionResolution = liveBrands.length === 1 ? 'skipped-disabled' : 'ambiguous'
    if (resolution === 'ambiguous') ambiguousCollisionGroups += 1
    droppedCollisionBrands += brands.length - 1

    entries.push(makeManifestEntry(group.siteKey, group.slug, winner.sweedBrandId, options.secret))
    collisions.push({
      siteKey: group.siteKey,
      literalSlug: group.slug,
      resolution,
      winnerBrandId: winner.sweedBrandId,
      brands: [...brands]
        .sort((a, b) => a.sweedBrandId - b.sweedBrandId)
        .map((b) => ({
          sweedBrandId: b.sweedBrandId,
          brandName: b.brandName,
          brandWideActive: liveBrandIds.has(b.sweedBrandId),
          forSaleVariantCount: b.representativeRow.forSaleVariantCount,
          lastForSaleObservedAt: b.representativeRow.lastForSaleObservedAt,
          selected: b.sweedBrandId === winner.sweedBrandId,
        })),
    })
  }

  // Deterministic collision report order (independent of DB row / group
  // insertion order) so logs and operator pages are stable across runs.
  collisions.sort((a, b) => {
    if (a.siteKey !== b.siteKey) return a.siteKey < b.siteKey ? -1 : 1
    return a.literalSlug < b.literalSlug ? -1 : a.literalSlug > b.literalSlug ? 1 : 0
  })

  const sortedEntries = sortBrandingManifestEntries(entries)

  // Fail-closed consistency guards (opaque collisions, literal==opaque).
  // Shared with the read-time validator so a manifest can never be both
  // produced and accepted in an inconsistent state. (After collision
  // resolution every (site, slug) is unique, so the duplicate-slug branch of
  // the checker is a belt-and-suspenders re-assert.)
  const consistencyErrors = checkBrandingManifestConsistency(sortedEntries)
  if (consistencyErrors.length > 0) {
    throw new BrandingManifestBuildError(consistencyErrors.join('; '))
  }

  return {
    entries: sortedEntries,
    scheme: BRANDING_OPAQUE_REF_SCHEME,
    secretSource: options.secretSource,
    summary: {
      presenceRowsConsidered: rows.length,
      includedBrands: sortedEntries.length,
      skippedNotFbUsSite,
      skippedEmptyName,
      skippedRetiredName,
      skippedEmptySlug,
      skippedNotForSale,
      mergedDuplicateSlugRows,
      slugCollisionGroups: collisions.length,
      ambiguousCollisionGroups,
      droppedCollisionBrands,
    },
    collisions,
  }
}

/** Build one manifest entry, deriving the opaque ref from the brand id. */
function makeManifestEntry(
  siteKey: FbUsLocationKey,
  literalSlug: string,
  sweedBrandId: number,
  secret: string,
): BrandingOpaqueManifestEntry {
  return {
    site_key: siteKey,
    literal_slug: literalSlug,
    sweed_brand_id: sweedBrandId,
    opaque_ref: deriveFreshlyBakedUsBrandOpaqueRef(secret, sweedBrandId),
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
