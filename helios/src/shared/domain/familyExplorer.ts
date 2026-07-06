// ---------------------------------------------------------------------------
// Categorical Family Explorer grouping (issue #55, task T1).
//
// Pure, deterministic grouping of the whole variant catalog into the
// operator's "categorical family" groups, so the operator can audit EXACTLY
// which variants/SKUs land in each family. This is the isolated validation
// surface for the T2 size-group normalizer (`unitSizeGroup.ts`): it is wired
// in HERE ONLY and deliberately does NOT touch `catalogCohort.ts`'s cohort
// keys or `sameSizeFamily`'s market matching, whose exact-size semantics drive
// existing pricing / market-match runs.
//
// A family is the cartesian grouping of:
//   category × subcategory × size-GROUP × pack-count   (nonbrand mode)
//   brand × category × subcategory × size-GROUP × pack-count   (brand mode)
//
// The size dimension is the T2 "morally equivalent" size GROUP (prerolls fold
// novelty sizes into standard buckets; every other category keeps its natural
// size), NOT the exact parsed size — that is the whole point the operator wants
// to validate here.
//
// KEY NOTES (see the Oracle design review on issue #55):
//   * We key on the RAW category/subcategory strings (mirroring
//     `catalogCohort.ts`'s null-is-a-distinct-bucket convention) so the page is
//     WYSIWYG-auditable. `normalizeUnitSizeGroup` folds sizes on the CANONICAL
//     category, so if Sweed ever grows a second spelling of e.g. "Pre-Rolls",
//     the families would split while size-folding would not — a deliberate,
//     visible artifact, not a silent bug.
//   * The stable family key is `JSON.stringify` of the dimension tuple, NOT a
//     `'|'`-join: structurally immune to a dimension value that contains the
//     separator or literally equals a display sentinel like "(no brand)".
//   * `null` on any dimension is its OWN distinct family (a no-subcategory
//     variant only ever groups with other no-subcategory peers). Display uses
//     explicit sentinels ("(no sub)", "(no pack)", …) so the operator never
//     misreads a blank cell as a mis-group.
//   * Members are NOT de-duplicated by productId: this is an audit surface, so
//     a (hypothetical) duplicate must be VISIBLE as two rows, not merged away.
// ---------------------------------------------------------------------------

import { parseUnitSize } from './catalogCohort.js'
import { normalizeUnitSizeGroup } from './unitSizeGroup.js'

export type FamilyExplorerMode = 'nonbrand' | 'brand'

/** One catalog variant as delivered by the server (raw, pre-grouping). */
export interface FamilyExplorerVariant {
  readonly catalogGroupId: number
  readonly productId: number
  readonly name: string | null
  readonly sku: string | null
  readonly brandName: string | null
  readonly categoryName: string | null
  readonly subcategoryName: string | null
  /** Units per package (`packOfSize`); 1 for singles, >1 for multipacks. */
  readonly packCount: number | null
  /** Raw Sweed `sizeName` label, e.g. "1g", "3.5g", "10mg", "0.6g". */
  readonly sizeLabel: string | null
}

/** A variant plus the size-group the T2 normalizer resolved it to. */
export interface FamilyMember extends FamilyExplorerVariant {
  /** Stable size-group dimension key, e.g. "g:0.5", "mg:10", "label:each". */
  readonly sizeGroupKey: string
  /** Human size-group label, e.g. "0.5 g", "10 mg", "(no size)". */
  readonly sizeGroupLabel: string
  /** Standard preroll grams the size folded to, else null. */
  readonly standardGrams: number | null
  /** The parsed per-unit size in grams the normalizer reasoned about. */
  readonly perUnitGrams: number | null
  /** True when a preroll size was COERCED into a bucket (show a "≈"). */
  readonly folded: boolean
  /**
   * True when the size did not parse to a numeric grams/mg value (fell to a
   * `label:` / `(no size)` key). These are exactly the grouping bugs the
   * operator is hunting, so the UI surfaces them first.
   */
  readonly sizeUnparsed: boolean
}

/** One resolved family group with its full, auditable membership. */
export interface FamilyGroup {
  /** Stable, structurally-safe key (JSON of the dimension tuple). */
  readonly familyKey: string
  readonly mode: FamilyExplorerMode
  /** Brand for this family (null in nonbrand mode, or genuinely no brand). */
  readonly brandName: string | null
  readonly categoryName: string | null
  readonly subcategoryName: string | null
  readonly sizeGroupKey: string
  readonly sizeGroupLabel: string
  readonly packCount: number | null
  readonly members: readonly FamilyMember[]
  readonly memberCount: number
  /** True when the size dimension did not parse (surfaced first in the UI). */
  readonly sizeUnparsed: boolean
}

/**
 * Product-grouping brand key: trim + lowercase + collapse internal whitespace.
 * Local (not the market-match `normalizeInlineText`, which does NOT lowercase)
 * so brand families are case-insensitive without widening a market-match
 * module's API for a product-grouping concern.
 */
export function familyBrandKey(brandName: string | null): string | null {
  if (brandName == null) return null
  const normalized = brandName.trim().toLowerCase().split(/\s+/).filter((p) => p.length > 0).join(' ')
  return normalized.length === 0 ? null : normalized
}

/** Resolve a raw variant's size-group via the T2 normalizer. */
function resolveMember(variant: FamilyExplorerVariant): FamilyMember {
  const { grams, mg } = parseUnitSize(variant.sizeLabel)
  const group = normalizeUnitSizeGroup({
    categoryName: variant.categoryName,
    sizeLabel: variant.sizeLabel,
    unitSizeGrams: grams,
    unitSizeMg: mg,
  })
  return {
    ...variant,
    sizeGroupKey: group.sizeGroupKey,
    sizeGroupLabel: group.sizeGroupLabel,
    standardGrams: group.standardGrams,
    perUnitGrams: group.perJointGrams,
    folded: group.folded,
    sizeUnparsed: grams == null && mg == null,
  }
}

/**
 * Group the whole variant catalog into categorical families for the chosen
 * mode. Pure and deterministic: identical input (in any order) yields an
 * identically-ordered result.
 */
export function groupFamilies(
  variants: readonly FamilyExplorerVariant[],
  mode: FamilyExplorerMode,
): FamilyGroup[] {
  const byKey = new Map<string, FamilyGroup & { members: FamilyMember[] }>()

  for (const variant of variants) {
    const member = resolveMember(variant)
    const brandKey = mode === 'brand' ? familyBrandKey(variant.brandName) : null
    // Structurally-safe key: JSON of the dimension tuple (see file header).
    const familyKey = JSON.stringify([
      mode,
      brandKey,
      variant.categoryName,
      variant.subcategoryName,
      member.sizeGroupKey,
      variant.packCount,
    ])

    let group = byKey.get(familyKey)
    if (!group) {
      group = {
        familyKey,
        mode,
        brandName: mode === 'brand' ? variant.brandName : null,
        categoryName: variant.categoryName,
        subcategoryName: variant.subcategoryName,
        sizeGroupKey: member.sizeGroupKey,
        sizeGroupLabel: member.sizeGroupLabel,
        packCount: variant.packCount,
        members: [],
        memberCount: 0,
        sizeUnparsed: member.sizeUnparsed,
      }
      byKey.set(familyKey, group)
    }
    group.members.push(member)
  }

  const groups: FamilyGroup[] = []
  for (const group of byKey.values()) {
    group.members.sort(compareMembers)
    groups.push({ ...group, memberCount: group.members.length })
  }
  groups.sort(compareGroups)
  return groups
}

// ---------------------------------------------------------------------------
// Brand-subdivided hierarchy (issue #58, task T1).
//
// The operator repriced by BRAND-categorical-family, so the audit page nests
// the flat grouping one level deeper: a NON-brand categorical family (category ×
// subcategory × size-group × pack) that fans out into per-brand sub-families.
// This deliberately reuses `groupFamilies(…, 'nonbrand')` so the non-brand
// family dimensions, size-group folding, `sizeUnparsed` flag, member ordering,
// and top-level ordering stay byte-for-byte identical to the existing flat
// nonbrand view — the hierarchy is a pure regrouping of the SAME members, never
// a second, drifting grouping implementation.
// ---------------------------------------------------------------------------

/** One per-brand sub-family within a non-brand categorical family. */
export interface BrandSubFamily {
  /** Normalized brand key (`familyBrandKey`); null = genuinely no brand. */
  readonly brandKey: string | null
  /** Representative raw brand name for display (null = no brand). */
  readonly brandName: string | null
  readonly members: readonly FamilyMember[]
  readonly memberCount: number
}

/** A non-brand categorical family subdivided into per-brand sub-families. */
export interface BrandSubdividedFamily {
  /** Stable key of the underlying non-brand family (JSON dimension tuple). */
  readonly familyKey: string
  readonly categoryName: string | null
  readonly subcategoryName: string | null
  readonly sizeGroupKey: string
  readonly sizeGroupLabel: string
  readonly packCount: number | null
  /** True when the size dimension did not parse (surfaced first in the UI). */
  readonly sizeUnparsed: boolean
  readonly subFamilies: readonly BrandSubFamily[]
  /** Number of distinct brand sub-families (case-insensitive). */
  readonly brandCount: number
  /** Total variants across all sub-families. */
  readonly memberCount: number
}

/**
 * Group the whole variant catalog into non-brand categorical families, each
 * subdivided into per-brand sub-families. Pure and deterministic: identical
 * input (in any order) yields an identically-ordered result.
 */
export function groupBrandSubdividedFamilies(
  variants: readonly FamilyExplorerVariant[],
): BrandSubdividedFamily[] {
  // Reuse the nonbrand grouping verbatim so the outer family dimensions,
  // size-group folding, unparseable-size flag, and ordering never drift.
  const nonBrandGroups = groupFamilies(variants, 'nonbrand')
  return nonBrandGroups.map((group) => {
    const byBrand = new Map<string, FamilyMember[]>()
    for (const member of group.members) {
      const brandKey = familyBrandKey(member.brandName)
      // `\u0000` prefix keeps the null-brand bucket distinct from a real brand
      // literally equal to the sentinel string.
      const mapKey = brandKey ?? '\u0000(no brand)'
      let members = byBrand.get(mapKey)
      if (!members) {
        members = []
        byBrand.set(mapKey, members)
      }
      members.push(member)
    }

    const subFamilies: BrandSubFamily[] = []
    for (const members of byBrand.values()) {
      subFamilies.push({
        brandKey: familyBrandKey(members[0]?.brandName ?? null),
        brandName: pickRepresentativeBrand(members),
        members,
        memberCount: members.length,
      })
    }
    subFamilies.sort(compareSubFamilies)

    return {
      familyKey: group.familyKey,
      categoryName: group.categoryName,
      subcategoryName: group.subcategoryName,
      sizeGroupKey: group.sizeGroupKey,
      sizeGroupLabel: group.sizeGroupLabel,
      packCount: group.packCount,
      sizeUnparsed: group.sizeUnparsed,
      subFamilies,
      brandCount: subFamilies.length,
      memberCount: group.memberCount,
    }
  })
}

/**
 * Deterministic representative raw brand spelling for a sub-family whose
 * members may carry case/whitespace variants of one brand key: the
 * lexicographically-smallest non-null raw name, or null when truly brandless.
 */
function pickRepresentativeBrand(members: readonly FamilyMember[]): string | null {
  let best: string | null = null
  for (const m of members) {
    if (m.brandName == null) continue
    if (best == null || m.brandName.localeCompare(best) < 0) best = m.brandName
  }
  return best
}

/** Sub-family ordering: real brands first (by key), the no-brand bucket last. */
function compareSubFamilies(a: BrandSubFamily, b: BrandSubFamily): number {
  if (a.brandKey == null && b.brandKey == null) return 0
  if (a.brandKey == null) return 1
  if (b.brandKey == null) return -1
  return a.brandKey.localeCompare(b.brandKey)
}

/** Deterministic member ordering: name, then SKU, then productId. */
function compareMembers(a: FamilyMember, b: FamilyMember): number {
  const byName = (a.name ?? '').localeCompare(b.name ?? '')
  if (byName !== 0) return byName
  const bySku = (a.sku ?? '').localeCompare(b.sku ?? '')
  if (bySku !== 0) return bySku
  return a.productId - b.productId
}

/**
 * Deterministic group ordering. Unparseable-size families sort FIRST (they are
 * the grouping bugs the operator is hunting), then by brand, category,
 * subcategory, size-group, pack.
 */
function compareGroups(a: FamilyGroup, b: FamilyGroup): number {
  if (a.sizeUnparsed !== b.sizeUnparsed) return a.sizeUnparsed ? -1 : 1
  const byBrand = (a.brandName ?? '').localeCompare(b.brandName ?? '')
  if (byBrand !== 0) return byBrand
  const byCat = (a.categoryName ?? '').localeCompare(b.categoryName ?? '')
  if (byCat !== 0) return byCat
  const bySub = (a.subcategoryName ?? '').localeCompare(b.subcategoryName ?? '')
  if (bySub !== 0) return bySub
  const bySize = a.sizeGroupKey.localeCompare(b.sizeGroupKey)
  if (bySize !== 0) return bySize
  return (a.packCount ?? -1) - (b.packCount ?? -1)
}
