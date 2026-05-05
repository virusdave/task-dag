import { z } from 'zod'

import type { JsonValue } from '../../shared/contracts/common/json.js'
import type { FieldPath } from '../../shared/domain/fieldPaths.js'

const POST_TAX_MULTIPLIER = 1.13

const MEDICAL_CLAIM_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'contains targeted relief claim', pattern: /\btargeted relief\b/i },
  { label: 'contains pain relief claim', pattern: /\bpain relief\b/i },
  { label: 'contains anxiety relief claim', pattern: /\banxiety relief\b/i },
  { label: 'contains therapeutic claim', pattern: /\btherapeutic\b/i },
  { label: 'contains therapy claim', pattern: /\btherapy\b/i },
  { label: 'contains medicinal claim', pattern: /\bmedicinal\b/i },
  { label: 'contains medical-benefit claim', pattern: /\bmedical benefit\b/i },
  { label: 'contains helps-with claim', pattern: /\bhelps with\b/i },
]

const SweedNamedValueSchema = z.object({
  name: z.string().nullable().optional(),
}).passthrough()

const SweedImageSchema = z.object({
  url: z.string().nullable().optional(),
}).passthrough()

const SweedProductSchema = z.object({
  groupImages: z.array(SweedImageSchema).optional(),
  id: z.coerce.number().int(),
  images: z.array(SweedImageSchema).optional(),
  name: z.string().nullable().optional(),
  price: z.coerce.number().nullable().optional(),
  priceInfo: z.object({ actualPrice: z.coerce.number().nullable().optional() }).passthrough().nullable().optional(),
  shortName: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  tab: z.string().nullable().optional(),
  wholesaleCost: z.coerce.number().nullable().optional(),
}).passthrough()

const SweedProductGroupDetailSchema = z.object({
  brand: SweedNamedValueSchema.nullable().optional(),
  category: SweedNamedValueSchema.nullable().optional(),
  description: z.string().nullable().optional(),
  effects: z.array(SweedNamedValueSchema).optional(),
  flavorings: z.array(SweedNamedValueSchema).optional(),
  fullName: z.string().nullable().optional(),
  id: z.coerce.number().int(),
  images: z.array(SweedImageSchema).optional(),
  name: z.string(),
  products: z.array(SweedProductSchema).optional(),
  scents: z.array(SweedNamedValueSchema).optional(),
  strain: SweedNamedValueSchema.nullable().optional(),
  subcategory: SweedNamedValueSchema.nullable().optional(),
  tags: z.array(SweedNamedValueSchema).optional(),
}).passthrough()

export const NormalizedCatalogProductLiveStateSchema = z.object({
  gmPercent: z.number().nullable(),
  imageUrl: z.string().nullable(),
  name: z.string(),
  price: z.number().nullable(),
  productId: z.number().int(),
  shortName: z.string().nullable(),
  sku: z.string().nullable(),
  tab: z.string(),
  wholesaleCost: z.number().nullable(),
})
export type NormalizedCatalogProductLiveState = z.infer<typeof NormalizedCatalogProductLiveStateSchema>

export const NormalizedCatalogGroupLiveStateSchema = z.object({
  brand: z.string().nullable(),
  category: z.string().nullable(),
  currentDescription: z.string(),
  effects: z.array(z.string()),
  flavorings: z.array(z.string()),
  groupFullName: z.string(),
  groupId: z.number().int(),
  groupName: z.string(),
  imageUrl: z.string().nullable(),
  productTabs: z.array(z.string()),
  products: z.array(NormalizedCatalogProductLiveStateSchema),
  scents: z.array(z.string()),
  strain: z.string().nullable(),
  subcategory: z.string().nullable(),
  tags: z.array(z.string()),
})
export type NormalizedCatalogGroupLiveState = z.infer<typeof NormalizedCatalogGroupLiveStateSchema>

export function findDescriptionMedicalClaimIssues(description: string): string[] {
  return MEDICAL_CLAIM_PATTERNS.filter(({ pattern }) => pattern.test(description)).map(({ label }) => label)
}

export function getLiveStateFieldValue(
  liveState: NormalizedCatalogGroupLiveState,
  targetEntityType: 'catalog_group' | 'catalog_product',
  targetEntityId: number,
  fieldPath: FieldPath,
): JsonValue | null {
  if (targetEntityType === 'catalog_group' && fieldPath === 'description' && liveState.groupId === targetEntityId) {
    return liveState.currentDescription
  }

  if (targetEntityType === 'catalog_product' && fieldPath === 'products.price') {
    const product = liveState.products.find((candidate) => candidate.productId === targetEntityId)
    return product?.price ?? null
  }

  return null
}

export function normalizeCatalogGroupDetail(detail: unknown): NormalizedCatalogGroupLiveState {
  const parsed = SweedProductGroupDetailSchema.parse(detail)
  const products = [...(parsed.products ?? [])]
    .sort((left, right) => compareProducts(left.id, left.tab, left.name, right.id, right.tab, right.name))
    .map((product) => ({
      gmPercent: calculateGrossMarginPercent(resolveProductPrice(product), product.wholesaleCost ?? null),
      imageUrl: firstImageUrl(product.images, product.groupImages, parsed.images),
      name: normalizeInlineText(product.name),
      price: resolveProductPrice(product),
      productId: product.id,
      shortName: normalizeOptionalInlineText(product.shortName),
      sku: normalizeOptionalInlineText(product.sku),
      tab: normalizeInlineText(product.tab),
      wholesaleCost: product.wholesaleCost ?? null,
    }))

  return {
    brand: normalizeOptionalInlineText(parsed.brand?.name),
    category: normalizeOptionalInlineText(parsed.category?.name),
    currentDescription: normalizeDescriptionText(parsed.description),
    effects: normalizeNamedList(parsed.effects),
    flavorings: normalizeNamedList(parsed.flavorings),
    groupFullName: normalizeInlineText(parsed.fullName ?? parsed.name),
    groupId: parsed.id,
    groupName: normalizeInlineText(parsed.name),
    imageUrl: firstImageUrl(parsed.images),
    productTabs: products.map((product) => product.tab).filter((tab, index, allTabs) => allTabs.indexOf(tab) === index),
    products,
    scents: normalizeNamedList(parsed.scents),
    strain: normalizeOptionalInlineText(parsed.strain?.name),
    subcategory: normalizeOptionalInlineText(parsed.subcategory?.name),
    tags: normalizeNamedList(parsed.tags),
  }
}

export function normalizeDescriptionText(value: string | null | undefined): string {
  const paragraphs: string[] = []
  let currentParagraphLines: string[] = []

  for (const rawLine of String(value ?? '').replace(/\r/g, '').split('\n')) {
    const normalizedLine = normalizeInlineText(rawLine)
    if (!normalizedLine) {
      if (currentParagraphLines.length > 0) {
        paragraphs.push(currentParagraphLines.join(' '))
        currentParagraphLines = []
      }
      continue
    }

    currentParagraphLines.push(normalizedLine)
  }

  if (currentParagraphLines.length > 0) {
    paragraphs.push(currentParagraphLines.join(' '))
  }

  return paragraphs.join('\n\n').trim()
}

function calculateGrossMarginPercent(price: number | null, wholesaleCost: number | null): number | null {
  if (price === null || wholesaleCost === null || price <= 0) {
    return null
  }

  return Math.round((1 - (POST_TAX_MULTIPLIER * wholesaleCost) / price) * 10000) / 100
}

function compareProducts(
  leftId: number,
  leftTab: string | null | undefined,
  leftName: string | null | undefined,
  rightId: number,
  rightTab: string | null | undefined,
  rightName: string | null | undefined,
): number {
  const leftTabText = normalizeInlineText(leftTab)
  const rightTabText = normalizeInlineText(rightTab)
  if (leftTabText !== rightTabText) {
    return leftTabText.localeCompare(rightTabText)
  }

  const leftNameText = normalizeInlineText(leftName)
  const rightNameText = normalizeInlineText(rightName)
  if (leftNameText !== rightNameText) {
    return leftNameText.localeCompare(rightNameText)
  }

  return leftId - rightId
}

function firstImageUrl(...collections: Array<Array<{ url?: string | null }> | undefined>): string | null {
  for (const collection of collections) {
    for (const row of collection ?? []) {
      const url = normalizeOptionalInlineText(row.url)
      if (url) {
        return url
      }
    }
  }

  return null
}

function normalizeInlineText(value: string | null | undefined): string {
  return String(value ?? '')
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(' ')
    .trim()
}

function normalizeNamedList(values: Array<{ name?: string | null }> | undefined): string[] {
  const names = (values ?? [])
    .map((value) => normalizeOptionalInlineText(value.name))
    .filter((value): value is string => value !== null)

  return names.filter((name, index) => names.findIndex((candidate) => candidate.toLowerCase() === name.toLowerCase()) === index)
}

function normalizeOptionalInlineText(value: string | null | undefined): string | null {
  const normalized = normalizeInlineText(value)
  return normalized.length > 0 ? normalized : null
}

function resolveProductPrice(product: z.infer<typeof SweedProductSchema>): number | null {
  return product.priceInfo?.actualPrice ?? product.price ?? null
}
