export type PricingReviewGroupLevel = 'brand' | 'category' | 'subcategory' | 'variant'

export interface PricingReviewFollowUpNote {
  completedAt: string | null
  createdAt: string
  id: string
  text: string
}

export interface PricingReviewDraftRow {
  followUpNotes: PricingReviewFollowUpNote[]
  include: boolean
  productId: number
  reviewedPrice: string | null
  status: 'accepted' | 'rejected' | 'unreviewed'
}

export interface PricingReviewDraftGroupFollowUp {
  followUpNotes: PricingReviewFollowUpNote[]
  groupKey: string
  groupLevel: PricingReviewGroupLevel
  label: string
}

export interface PricingReviewBrandMetadata {
  brandKey: string
  isMso: boolean
  label: string
  note: string | null
}

export interface PricingReviewBrandMetadataRef {
  key: string
  label: string
}

export interface PacketRowHierarchy {
  brandKey: string
  brandLabel: string
  brandScopeLabel: string
  categoryKey: string
  categoryLabel: string
  categoryScopeLabel: string
  subcategoryKey: string
  subcategoryLabel: string
  subcategoryScopeLabel: string
  variantKey: string
  variantLabel: string
  variantScopeLabel: string
}

export interface PricingReviewPacketRowSummary {
  hierarchy?: PacketRowHierarchy | null
  productId: number
}

export interface PricingReviewDraftSummary {
  acceptedCount: number
  completedNoteCount: number
  groupTargetCount: number
  includedCount: number
  outstandingGroupCount: number
  outstandingNoteCount: number
  outstandingProductCount: number
  rejectedCount: number
  reviewedCount: number
  rowCount: number
  totalNoteCount: number
  unreviewedCount: number
}

export function buildPacketRowHierarchy(input: {
  brand: string | null
  category: string | null
  subcategory: string | null
  variant: string | null
}): PacketRowHierarchy {
  const categoryLabel = sanitizeHierarchyLabel(input.category, 'Uncategorized')
  const subcategoryLabel = sanitizeHierarchyLabel(input.subcategory, 'No subcategory')
  const variantLabel = sanitizeHierarchyLabel(input.variant, 'Unknown size')
  const brandLabel = sanitizeHierarchyLabel(input.brand, 'No brand')

  const categoryKey = buildHierarchyKey('category', [categoryLabel])
  const subcategoryKey = buildHierarchyKey('subcategory', [categoryLabel, subcategoryLabel])
  const variantKey = buildHierarchyKey('variant', [categoryLabel, subcategoryLabel, variantLabel])
  const brandKey = buildHierarchyKey('brand', [categoryLabel, subcategoryLabel, variantLabel, brandLabel])

  return {
    brandKey,
    brandLabel,
    brandScopeLabel: `${categoryLabel} / ${subcategoryLabel} / ${variantLabel} / ${brandLabel}`,
    categoryKey,
    categoryLabel,
    categoryScopeLabel: categoryLabel,
    subcategoryKey,
    subcategoryLabel,
    subcategoryScopeLabel: `${categoryLabel} / ${subcategoryLabel}`,
    variantKey,
    variantLabel,
    variantScopeLabel: `${categoryLabel} / ${subcategoryLabel} / ${variantLabel}`,
  }
}

export function buildBrandMetadataRef(brand: string | null | undefined): PricingReviewBrandMetadataRef {
  const label = sanitizeHierarchyLabel(brand, 'No brand')
  return {
    key: buildHierarchyKey('brand', [label]),
    label,
  }
}

export function summarizePricingReviewDraft(
  packetRows: PricingReviewPacketRowSummary[],
  rows: PricingReviewDraftRow[],
  groupFollowUpNotes: PricingReviewDraftGroupFollowUp[] = [],
): PricingReviewDraftSummary {
  const rowByProductId = new Map<number, PricingReviewDraftRow>(rows.map((row) => [row.productId, row]))
  const outstandingGroupKeys = new Set(
    groupFollowUpNotes
      .filter((group) => group.followUpNotes.some((note) => note.completedAt === null))
      .map((group) => group.groupKey),
  )
  const allNotes = rows.flatMap((row) => row.followUpNotes).concat(groupFollowUpNotes.flatMap((group) => group.followUpNotes))
  const completedNoteCount = allNotes.filter((note) => note.completedAt !== null).length

  const outstandingProductCount = packetRows.reduce((count, packetRow) => {
    const row = rowByProductId.get(packetRow.productId)
    const ownOutstandingNotes = row?.followUpNotes.some((note) => note.completedAt === null) === true
    const inheritedOutstandingNotes = getHierarchyKeys(packetRow).some((groupKey) => outstandingGroupKeys.has(groupKey))
    return count + (ownOutstandingNotes || inheritedOutstandingNotes ? 1 : 0)
  }, 0)

  return {
    acceptedCount: rows.filter((row) => row.status === 'accepted').length,
    completedNoteCount,
    groupTargetCount: groupFollowUpNotes.length,
    includedCount: rows.filter((row) => row.include).length,
    outstandingGroupCount: groupFollowUpNotes.filter((group) => group.followUpNotes.some((note) => note.completedAt === null)).length,
    outstandingNoteCount: allNotes.length - completedNoteCount,
    outstandingProductCount,
    rejectedCount: rows.filter((row) => row.status === 'rejected').length,
    reviewedCount: rows.filter((row) => row.status !== 'unreviewed').length,
    rowCount: rows.length,
    totalNoteCount: allNotes.length,
    unreviewedCount: rows.filter((row) => row.status === 'unreviewed').length,
  }
}

export function collectPacketHierarchyGroupKeys(packetRows: PricingReviewPacketRowSummary[]): Set<string> {
  return new Set(packetRows.flatMap((row) => getHierarchyKeys(row)))
}

function getHierarchyKeys(packetRow: PricingReviewPacketRowSummary): string[] {
  if (!packetRow.hierarchy) {
    return []
  }
  return [
    packetRow.hierarchy.categoryKey,
    packetRow.hierarchy.subcategoryKey,
    packetRow.hierarchy.variantKey,
    packetRow.hierarchy.brandKey,
  ]
}

function sanitizeHierarchyLabel(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : fallback
}

function buildHierarchyKey(level: PricingReviewGroupLevel, pathLabels: string[]): string {
  return `${level}:${pathLabels.map(slugifyHierarchySegment).join('__')}`
}

function slugifyHierarchySegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized.length > 0 ? normalized : 'blank'
}
