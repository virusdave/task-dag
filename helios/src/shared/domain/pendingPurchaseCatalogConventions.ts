export interface CatalogCreationConventionInput {
  readonly brand: string | null
  readonly brandAliases?: readonly string[]
  readonly category: string | null
  readonly groupName: string | null
  readonly packCount: number | null
  readonly size: string | null
  readonly strainName?: string | null
  readonly variantName: string | null
}

export interface CatalogCreationConventionResult {
  readonly groupName: string | null
  readonly issues: readonly string[]
  readonly variantName: string | null
  readonly variantTab: string | null
}

const CATEGORY_TERMS: Readonly<Record<string, readonly string[]>> = {
  beverages: ['beverage', 'beverages', 'drink', 'drinks'],
  concentrates: ['concentrate', 'concentrates', 'conc'],
  edibles: ['edible', 'edibles'],
  flower: ['flower', 'flwr'],
  'pre rolls': ['pre roll', 'pre rolls', 'preroll', 'prerolls', 'pr'],
  tinctures: ['tincture', 'tinctures'],
  topicals: ['topical', 'topicals'],
  vapes: ['vape', 'vapes', 'vaporizer', 'vaporizers'],
}

export function applyCatalogCreationConventions(
  input: CatalogCreationConventionInput,
): CatalogCreationConventionResult {
  const size = nonBlank(input.size)
  const packCount = input.packCount
  const issues: string[] = []
  if (size === null) issues.push('catalog creation requires a unit size')
  if (packCount === null || !Number.isInteger(packCount) || packCount < 1) {
    issues.push('catalog creation requires a positive integer pack count')
  }

  const forbiddenPhrases = conventionPhrases(input)
  const variantName = cleanCatalogName(input.variantName, forbiddenPhrases)
    ?? cleanCatalogName(input.strainName ?? null, forbiddenPhrases)
  let groupName = cleanCatalogName(input.groupName, forbiddenPhrases)
  if (variantName !== null && !containsPhrase(groupName, variantName)) {
    groupName = groupName === null ? variantName : `${groupName} - ${variantName}`
  }
  if (groupName === null) issues.push('catalog creation requires a salient group/line name')
  if (variantName === null) issues.push('catalog creation requires a salient variant name separate from size and pack metadata')

  return {
    groupName,
    issues,
    variantName,
    variantTab: size === null || packCount === null || packCount < 1
      ? null
      : packCount === 1 ? size : `${packCount}x ${size}`,
  }
}

function conventionPhrases(input: CatalogCreationConventionInput): string[] {
  const brandPhrases = [input.brand, ...(input.brandAliases ?? [])]
    .map(nonBlank)
    .filter((value): value is string => value !== null)
  const categoryKey = normalize(input.category ?? '')
  return [...new Set([
    ...brandPhrases,
    ...(CATEGORY_TERMS[categoryKey] ?? (categoryKey ? [input.category!] : [])),
  ])]
}

function cleanCatalogName(value: string | null, forbiddenPhrases: readonly string[]): string | null {
  let cleaned = nonBlank(value)
  if (cleaned === null) return null
  for (const phrase of [...forbiddenPhrases].sort((left, right) => right.length - left.length)) {
    const tokens = phrase.split(/[^a-z0-9]+/iu).filter(Boolean)
    if (tokens.length === 0) continue
    const pattern = tokens.map(escapeRegExp).join('[^a-z0-9]+')
    cleaned = cleaned.replace(new RegExp(`(^|[^a-z0-9])${pattern}(?=$|[^a-z0-9])`, 'giu'), '$1')
  }
  cleaned = cleaned
    .replace(/\b(?:\d+(?:\.\d+)?|\.\d+)\s*(?:x|×|pk|packs?|pack of)\b/giu, ' ')
    .replace(/[[(]?(?:\b\d+(?:\.\d+)?|(?<![a-z0-9])\.\d+)\s*(?:mg|g|ml|oz)\b[\])]?/giu, ' ')
    .replace(/\s*[-–—:|/,]+\s*(?=$|[-–—:|/,])/gu, ' ')
    .replace(/^[\s\-–—:|/,()[\]]+|[\s\-–—:|/,()[\]]+$/gu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

function containsPhrase(value: string | null, phrase: string): boolean {
  if (value === null) return false
  const normalizedValue = ` ${normalize(value)} `
  const normalizedPhrase = ` ${normalize(phrase)} `
  return normalizedValue.includes(normalizedPhrase)
}

function normalize(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/gu, ' ').trim()
}

function nonBlank(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
